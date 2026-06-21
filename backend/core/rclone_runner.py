import asyncio
import posixpath
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional


@dataclass
class RcloneResult:
    exit_code: int
    log: str
    bytes_transferred: int = 0
    files_transferred: int = 0


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
