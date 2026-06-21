import asyncio
import posixpath
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional


@dataclass
class RcloneResult:
    exit_code: int
    log: str
    bytes_transferred: int = 0
    files_transferred: int = 0


@dataclass
class SpeedSample:
    """One `rclone test speed` measurement for a given file size. Speeds are bytes/sec."""

    size_bytes: int
    num_files: int
    upload_bps: float
    download_bps: float


@dataclass
class SpeedTestResult:
    samples: list[SpeedSample] = field(default_factory=list)
    # Peak (best) speeds across all samples, bytes/sec — typically the largest file size.
    upload_bps: float = 0.0
    download_bps: float = 0.0
    log: str = ""
    error: Optional[str] = None


def _sftp_remote(host: str, user: str, key_path: Optional[str], port: int) -> str:
    remote = f":sftp,host={host},user={user},port={port}"
    if key_path:
        remote += f",key_file={key_path}"
    return remote


OnLineCb = Optional[Callable[[str], Awaitable[None]]]


async def _run(args: list[str], on_line: OnLineCb = None) -> RcloneResult:
    full_args = [*args, "--log-level", "INFO"]
    if on_line:
        await on_line("$ rclone " + " ".join(full_args))
    proc = await asyncio.create_subprocess_exec(
        "rclone",
        *full_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    lines: list[str] = []

    async def _read(stream: asyncio.StreamReader) -> None:
        while True:
            raw = await stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip()
            lines.append(line)
            if on_line:
                await on_line(line)

    await asyncio.gather(_read(proc.stdout), _read(proc.stderr))
    await proc.wait()

    log = "\n".join(lines)
    return RcloneResult(proc.returncode or 0, log, _parse_bytes(log), _parse_files(log))


def _parse_bytes(log: str) -> int:
    m = re.search(r"Transferred:\s+([\d.]+\s*\w+)\s*/", log)
    if not m:
        return 0
    return _human_to_bytes(m.group(1).strip())


def _parse_files(log: str) -> int:
    m = re.search(r"Transferred:\s+\d+\s*/\s*\d+,\s*(\d+)%,", log)
    if m:
        return int(m.group(1))
    m2 = re.search(r"(\d+)\s+files", log)
    return int(m2.group(1)) if m2 else 0


def _human_to_bytes(s: str) -> int:
    units = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4,
             "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4}
    m = re.match(r"([\d.]+)\s*(\w+)", s.strip())
    if not m:
        return 0
    try:
        return int(float(m.group(1)) * units.get(m.group(2), 1))
    except (ValueError, TypeError):
        return 0


async def copy(
    src_host: str, src_user: str, src_key: Optional[str], src_port: int, src_path: str,
    dst_host: str, dst_user: str, dst_key: Optional[str], dst_port: int, dst_path: str,
    on_line: OnLineCb = None,
) -> RcloneResult:
    src = f"{_sftp_remote(src_host, src_user, src_key, src_port)}:{src_path}"
    dst = f"{_sftp_remote(dst_host, dst_user, dst_key, dst_port)}:{dst_path}"
    return await _run(["copy", src, dst], on_line=on_line)


async def sync(
    src_host: str, src_user: str, src_key: Optional[str], src_port: int, src_path: str,
    dst_host: str, dst_user: str, dst_key: Optional[str], dst_port: int, dst_path: str,
    on_line: OnLineCb = None,
) -> RcloneResult:
    src = f"{_sftp_remote(src_host, src_user, src_key, src_port)}:{src_path}"
    dst = f"{_sftp_remote(dst_host, dst_user, dst_key, dst_port)}:{dst_path}"
    return await _run(["sync", src, dst], on_line=on_line)


async def verify(
    src_host: str, src_user: str, src_key: Optional[str], src_port: int, src_path: str,
    dst_host: str, dst_user: str, dst_key: Optional[str], dst_port: int, dst_path: str,
    on_line: OnLineCb = None,
) -> bool:
    # rclone check requires directories; for a single file use the parent dir
    # on both sides with --include so only that file is compared.
    extra: list[str] = []
    if not src_path.endswith("/"):
        extra = ["--include", posixpath.basename(src_path)]
        src_path = posixpath.dirname(src_path) + "/"
        dst_path = posixpath.dirname(dst_path) + "/"
    src = f"{_sftp_remote(src_host, src_user, src_key, src_port)}:{src_path}"
    dst = f"{_sftp_remote(dst_host, dst_user, dst_key, dst_port)}:{dst_path}"
    result = await _run(["check", "--checksum", *extra, src, dst], on_line=on_line)
    return result.exit_code == 0


async def delete_path(
    host: str, user: str, key: Optional[str], port: int, path: str, is_dir: bool,
    on_line: OnLineCb = None,
) -> RcloneResult:
    remote = f"{_sftp_remote(host, user, key, port)}:{path}"
    cmd = "purge" if is_dir else "deletefile"
    return await _run([cmd, remote], on_line=on_line)


def _summarize_rclone_error(output: str) -> Optional[str]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    # Prefer an explicit error line; rclone prefixes them with ERROR/Fatal/Failed.
    for line in reversed(lines):
        low = line.lower()
        if "error" in low or "failed" in low:
            return line
    return lines[-1]


_SIZE_UNITS = {
    "": 1, "B": 1,
    "K": 1024, "Ki": 1024, "KiB": 1024, "KB": 1000,
    "M": 1024**2, "Mi": 1024**2, "MiB": 1024**2, "MB": 1000**2,
    "G": 1024**3, "Gi": 1024**3, "GiB": 1024**3, "GB": 1000**3,
    "T": 1024**4, "Ti": 1024**4, "TiB": 1024**4, "TB": 1000**4,
}


def _suffix_to_bytes(s: str) -> float:
    """Parse an rclone size/rate token like ``1Ki`` or ``397.038MiB`` to bytes."""
    m = re.match(r"([\d.]+)\s*([A-Za-z]*)", s.strip())
    if not m:
        return 0.0
    try:
        return float(m.group(1)) * _SIZE_UNITS.get(m.group(2), 1)
    except (ValueError, TypeError):
        return 0.0


# `test speed` text output (stable across rclone versions, unlike the newer
# --json flag which older builds reject):
#   Running test for 8 files of size 1Ki
#   Upload              : 8192B in 5ms at 1.652MiB/s
#   Download            : 8192B in 5ms at 1.611MiB/s
_RUN_RE = re.compile(r"Running (initial )?test for (\d+) files of size (\S+)")
_MEAS_RE = re.compile(r"(Upload|Download)\s*:\s*\d+B\s+in\s+\S+\s+at\s+([\d.]+\s*\w+)/s")


def _parse_speed_text(output: str) -> list[SpeedSample]:
    samples: list[SpeedSample] = []
    num_files = 0
    size_bytes = 0
    skip = True  # ignore the initial calibration run; rclone re-tests that size
    upload = 0.0
    for line in output.splitlines():
        run = _RUN_RE.search(line)
        if run:
            skip = run.group(1) is not None
            num_files = int(run.group(2))
            size_bytes = int(_suffix_to_bytes(run.group(3)))
            upload = 0.0
            continue
        meas = _MEAS_RE.search(line)
        if not meas or skip:
            continue
        bps = _suffix_to_bytes(meas.group(2))
        if meas.group(1) == "Upload":
            upload = bps
        else:  # Download line completes this size's measurement pair
            samples.append(SpeedSample(size_bytes, num_files, upload, bps))
    return samples


async def speed_test(
    host: str,
    user: str,
    key: Optional[str],
    port: int,
    path: str = "/",
    *,
    test_time: str = "3s",
    large: str = "16Mi",
    medium: str = "2Mi",
    small: str = "1Ki",
    file_cap: int = 10,
    timeout: float = 120.0,
) -> SpeedTestResult:
    """Run `rclone test speed` against a node's SFTP remote.

    rclone creates and deletes files in a randomly named directory under
    ``path`` (removed automatically on a clean exit) and reports upload and
    download throughput for each file size. Speeds in the result are bytes/sec.

    The human-readable (``-q``) output is parsed rather than ``--json`` because
    the JSON flag is only present in newer rclone builds.
    """
    remote = f"{_sftp_remote(host, user, key, port)}:{path}"
    args = [
        "test", "speed", remote, "-q",
        "--test-time", test_time,
        "--large", large,
        "--medium", medium,
        "--small", small,
        "--file-cap", str(file_cap),
    ]
    proc = await asyncio.create_subprocess_exec(
        "rclone", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return SpeedTestResult(error=f"Speed test timed out after {int(timeout)}s")

    # Results print to stdout under -q; errors land on stderr. Parse both.
    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    combined = stdout + ("\n" + stderr if stderr.strip() else "")

    if proc.returncode != 0:
        return SpeedTestResult(
            log=combined,
            error=_summarize_rclone_error(combined) or f"rclone exited with code {proc.returncode}",
        )

    samples = _parse_speed_text(combined)
    if not samples:
        return SpeedTestResult(log=combined, error="Could not parse speed test output")

    return SpeedTestResult(
        samples=samples,
        upload_bps=max((s.upload_bps for s in samples), default=0.0),
        download_bps=max((s.download_bps for s in samples), default=0.0),
        log=combined,
    )
