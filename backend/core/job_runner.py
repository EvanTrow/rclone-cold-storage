import asyncio
import posixpath
from datetime import datetime
from typing import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core import rclone_runner, ssh_client, wol
from backend.core.config import get_setting
from backend.db.session import AsyncSessionLocal
from backend.models import Job, Node, NodeLock, Run

# run_id → asyncio.Task, populated while a job is executing
_running_tasks: dict[int, asyncio.Task] = {}


def _dest_dir(src_path: str, src_root: str, dst_root: str) -> str:
    """
    Compute the rclone destination directory for a source path, preserving
    the directory structure relative to each node's sftp_root.

    src_path ending with '/' is treated as a directory (dest = the dir itself).
    src_path without trailing '/' is treated as a file (dest = its parent dir).

    Example:
        src_root=/mnt/data/, dst_root=/home/data/
        /mnt/data/test/file.txt → /home/data/test/
        /mnt/data/videos/       → /home/data/videos/
    """
    stripped_root = src_root.rstrip("/") + "/"
    rel = src_path.removeprefix(stripped_root).lstrip("/")
    dst_base = dst_root.rstrip("/")
    if src_path.endswith("/"):
        # Directory: preserve its name on the destination
        parent = rel.rstrip("/")
    else:
        # File: destination is the file's parent directory
        parent = posixpath.dirname(rel)
    return f"{dst_base}/{parent}/" if parent else f"{dst_base}/"


def _dest_file(src_path: str, src_root: str, dst_root: str) -> str:
    """Full destination path for a source file (non-directory)."""
    return _dest_dir(src_path, src_root, dst_root) + posixpath.basename(src_path)


def cancel_run(run_id: int) -> bool:
    """Request cancellation of an in-progress run. Returns True if the task was found."""
    task = _running_tasks.get(run_id)
    if task and not task.done():
        task.cancel()
        return True
    return False


async def execute_job(job_id: int) -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Job).where(Job.id == job_id))
        job = result.scalar_one_or_none()
        if not job or not job.enabled:
            return

        run = Run(job_id=job_id, status="running", started_at=datetime.utcnow())
        db.add(run)
        await db.commit()
        await db.refresh(run)

        task = asyncio.current_task()
        if task:
            _running_tasks[run.id] = task

        log_lines: list[str] = []
        _flushed_at: list[int] = [0]

        def log(msg: str) -> None:
            ts = datetime.utcnow().strftime("%H:%M:%S")
            log_lines.append(f"[{ts}] {msg}")

        async def flush_log() -> None:
            run.log_output = "\n".join(log_lines)
            _flushed_at[0] = len(log_lines)
            await db.commit()

        async def on_rclone_line(line: str) -> None:
            log_lines.append(line)
            if len(log_lines) - _flushed_at[0] >= 10:
                await flush_log()

        try:
            await _run_job(db, job, run, log, flush_log, on_rclone_line)
        except asyncio.CancelledError:
            ts = datetime.utcnow().strftime("%H:%M:%S")
            log_lines.append(f"[{ts}] Cancelled by user")
            run.status = "cancelled"
            run.finished_at = datetime.utcnow()
            # Do not re-raise — let the finally block commit the result cleanly
        except Exception as exc:
            log(f"Unhandled error: {exc}")
            run.status = "failed"
            run.alert_read = False
            run.finished_at = datetime.utcnow()
        finally:
            _running_tasks.pop(run.id, None)
            run.log_output = "\n".join(log_lines)
            await _release_lock(db, run.id)
            await db.commit()
            if run.status == "failed":
                await _notify_failure(db, job, run, log_lines[-1] if log_lines else "unknown error")


async def _run_job(
    db: AsyncSession, job: Job, run: Run,
    log: Callable, flush_log, on_rclone_line,
) -> None:
    node_ids: set[int] = set()
    if job.source_node_id:
        node_ids.add(job.source_node_id)
    if job.dest_node_id:
        node_ids.add(job.dest_node_id)

    primary_node_id = job.source_node_id or job.dest_node_id
    if primary_node_id:
        acquired = await _acquire_lock(db, primary_node_id, run.id)
        if not acquired:
            log("Waiting for node lock…")
            run.status = "queued"
            await flush_log()
            for _ in range(60):
                await asyncio.sleep(10)
                if await _acquire_lock(db, primary_node_id, run.id):
                    break
            else:
                raise RuntimeError("Timed out waiting for node lock")
            run.status = "running"
            await flush_log()

    wol_broadcast = await get_setting(db, "wol_broadcast") or "255.255.255.255"

    for node_id in node_ids:
        node = await db.get(Node, node_id)
        if not node:
            continue
        log(f"Checking {node.name} ({node.ip})")
        already_up, _ = await ssh_client.test_ssh_connection(
            node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port
        )
        if not already_up:
            log(f"Sending WOL to {node.name} ({node.mac})")
            node.status = "waking"
            await flush_log()
            await wol.send_wol(node.mac, wol_broadcast)
            log(f"Waiting for {node.name} to come online…")
            reachable = await ssh_client.poll_until_reachable(
                node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port
            )
            if not reachable:
                raise RuntimeError(f"{node.name} did not wake within timeout")
            log(f"{node.name} is online")
        else:
            log(f"{node.name} already online, skipping WOL")

        node.status = "online"
        node.last_seen = datetime.utcnow()
        await flush_log()

    if job.operation == "copy":
        await _do_copy(db, job, run, log, flush_log, on_rclone_line)
    elif job.operation == "move":
        await _do_move(db, job, run, log, flush_log, on_rclone_line)
    elif job.operation == "delete":
        await _do_delete(db, job, run, log, flush_log, on_rclone_line)

    if job.shutdown_after and run.status == "success" and job.dest_node_id:
        dst_node = await db.get(Node, job.dest_node_id)
        if dst_node:
            abort_shutdown = False

            # Verify all copied files by checksum before powering off the destination
            if job.operation == "copy" and job.source_node_id and job.source_paths:
                src_node = await db.get(Node, job.source_node_id)
                if src_node:
                    log("Verifying file integrity before shutdown…")
                    await flush_log()
                    for path in job.source_paths:
                        dest = _dest_file(path, src_node.sftp_root, dst_node.sftp_root)
                        valid = await rclone_runner.verify(
                            src_node.ip, src_node.ssh_user, src_node.ssh_key_path, src_node.ssh_port, path,
                            dst_node.ip, dst_node.ssh_user, dst_node.ssh_key_path, dst_node.ssh_port, dest,
                            on_line=on_rclone_line,
                        )
                        if not valid:
                            log(f"Integrity check FAILED for {posixpath.basename(path)} — aborting shutdown")
                            run.status = "failed"
                            run.alert_read = False
                            await flush_log()
                            abort_shutdown = True
                            break
                    if not abort_shutdown:
                        log("Integrity check passed")
                        await flush_log()

            if not abort_shutdown:
                if not dst_node.allow_shutdown:
                    log(f"Skipping shutdown of {dst_node.name} (shutdown disabled on node)")
                    await flush_log()
                else:
                    log(f"Shutting down {dst_node.name}")
                    await flush_log()
                    try:
                        await ssh_client.shutdown_node(
                            dst_node.ip, dst_node.ssh_user, dst_node.ssh_key_path, dst_node.ssh_port
                        )
                        dst_node.status = "offline"
                        await db.commit()
                    except Exception as exc:
                        log(f"Shutdown failed for {dst_node.name}: {exc}")
                        await flush_log()

    run.finished_at = datetime.utcnow()


async def _do_copy(db, job, run, log, flush_log, on_rclone_line) -> None:
    src = await db.get(Node, job.source_node_id)
    dst = await db.get(Node, job.dest_node_id)
    for path in (job.source_paths or []):
        dest = _dest_dir(path, src.sftp_root, dst.sftp_root)
        log(f"Copying {src.name}:{path} → {dst.name}:{dest}")
        await flush_log()
        result = await rclone_runner.copy(
            src.ip, src.ssh_user, src.ssh_key_path, src.ssh_port, path,
            dst.ip, dst.ssh_user, dst.ssh_key_path, dst.ssh_port, dest,
            on_line=on_rclone_line,
        )
        if result.exit_code != 0:
            log(f"rclone copy failed (exit {result.exit_code})")
            run.status = "failed"
            run.alert_read = False
            run.bytes_transferred = result.bytes_transferred
            run.files_transferred = result.files_transferred
            return
        run.bytes_transferred = (run.bytes_transferred or 0) + result.bytes_transferred
        run.files_transferred = (run.files_transferred or 0) + result.files_transferred
        log(f"Copy complete: {result.files_transferred} files, {_fmt_bytes(result.bytes_transferred)}")
    run.status = "success"


async def _do_move(db, job, run, log, flush_log, on_rclone_line) -> None:
    src = await db.get(Node, job.source_node_id)
    dst = await db.get(Node, job.dest_node_id)
    for path in (job.source_paths or []):
        dest_dir = _dest_dir(path, src.sftp_root, dst.sftp_root)
        dest_path = _dest_file(path, src.sftp_root, dst.sftp_root)
        log(f"Copying {src.name}:{path} → {dst.name}:{dest_dir}")
        await flush_log()
        result = await rclone_runner.copy(
            src.ip, src.ssh_user, src.ssh_key_path, src.ssh_port, path,
            dst.ip, dst.ssh_user, dst.ssh_key_path, dst.ssh_port, dest_dir,
            on_line=on_rclone_line,
        )
        if result.exit_code != 0:
            log(f"rclone copy failed (exit {result.exit_code})")
            run.status = "failed"
            run.alert_read = False
            return

        log("Verifying transfer (checksum)…")
        await flush_log()
        valid = await rclone_runner.verify(
            src.ip, src.ssh_user, src.ssh_key_path, src.ssh_port, path,
            dst.ip, dst.ssh_user, dst.ssh_key_path, dst.ssh_port, dest_path,
            on_line=on_rclone_line,
        )
        run.validation_passed = valid
        if not valid:
            log("Validation FAILED — source preserved")
            run.status = "failed"
            run.alert_read = False
            return

        log("Validation passed — deleting source")
        await flush_log()
        del_result = await rclone_runner.delete_path(
            src.ip, src.ssh_user, src.ssh_key_path, src.ssh_port, path,
            is_dir=path.endswith("/"),
            on_line=on_rclone_line,
        )
        if del_result.exit_code != 0:
            log(f"Source delete failed (exit {del_result.exit_code})")
            run.status = "failed"
            run.alert_read = False
            return
        run.bytes_transferred = (run.bytes_transferred or 0) + result.bytes_transferred
        run.files_transferred = (run.files_transferred or 0) + result.files_transferred
        log(f"Move complete: {result.files_transferred} files, {_fmt_bytes(result.bytes_transferred)}")
    run.status = "success"


async def _do_delete(db, job, run, log, flush_log, on_rclone_line) -> None:
    node_id = job.source_node_id or job.dest_node_id
    node = await db.get(Node, node_id)
    for path in (job.target_paths or []):
        log(f"Deleting {node.name}:{path}")
        await flush_log()
        result = await rclone_runner.delete_path(
            node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port, path,
            is_dir=path.endswith("/"),
            on_line=on_rclone_line,
        )
        if result.exit_code != 0:
            log(f"rclone delete failed (exit {result.exit_code})")
            run.status = "failed"
            run.alert_read = False
            return
        log(f"Deleted {node.name}:{path}")
    run.status = "success"


def _fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n / 1024:.1f} KiB"
    if n < 1024**3:
        return f"{n / 1024**2:.1f} MiB"
    return f"{n / 1024**3:.2f} GiB"


async def _acquire_lock(db: AsyncSession, node_id: int, run_id: int) -> bool:
    result = await db.execute(select(NodeLock).where(NodeLock.node_id == node_id))
    if result.scalar_one_or_none():
        return False
    db.add(NodeLock(node_id=node_id, locked_by_run_id=run_id))
    await db.commit()
    return True


async def _release_lock(db: AsyncSession, run_id: int) -> None:
    result = await db.execute(select(NodeLock).where(NodeLock.locked_by_run_id == run_id))
    lock = result.scalar_one_or_none()
    if lock:
        await db.delete(lock)


async def _notify_failure(db: AsyncSession, job: Job, run: Run, reason: str) -> None:
    webhook_url = await get_setting(db, "notification_webhook")
    if not webhook_url:
        return
    node_id = job.source_node_id or job.dest_node_id
    node_name = "unknown"
    if node_id:
        node = await db.get(Node, node_id)
        if node:
            node_name = node.name
    import httpx
    payload = {
        "job_name": job.name,
        "operation": job.operation,
        "node_name": node_name,
        "failure_reason": reason,
        "timestamp": run.started_at.isoformat() if run.started_at else None,
    }
    try:
        async with httpx.AsyncClient() as client:
            await client.post(webhook_url, json=payload, timeout=10)
    except Exception:
        pass
