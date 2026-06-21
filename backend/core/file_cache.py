import stat
from datetime import datetime
from typing import Optional

import asyncssh
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.ssh_client import _connect_kwargs
from backend.models import Node, NodeFileCache


async def crawl_node_sftp(node: Node, db: AsyncSession, max_depth: int = 5) -> dict:
    connect_kwargs = _connect_kwargs(node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port)
    async with asyncssh.connect(**connect_kwargs) as conn:
        async with conn.start_sftp_client() as sftp:
            await db.execute(delete(NodeFileCache).where(NodeFileCache.node_id == node.id))

            entries: list[NodeFileCache] = []
            await _walk(sftp, node.sftp_root or "/", node.id, entries, max_depth, 0)

            for entry in entries:
                db.add(entry)

            node.last_cache_refresh = datetime.utcnow()
            await db.commit()
            files = sum(1 for e in entries if e.type == "file")
            dirs = sum(1 for e in entries if e.type == "dir")
            return {"files": files, "dirs": dirs}


async def _walk(
    sftp: asyncssh.SFTPClient,
    path: str,
    node_id: int,
    entries: list,
    max_depth: int,
    depth: int,
) -> None:
    if depth > max_depth:
        return
    try:
        items = await sftp.readdir(path)
    except Exception:
        return

    for item in items:
        name = item.filename
        if name in (".", ".."):
            continue
        full_path = f"{path.rstrip('/')}/{name}"
        attrs = item.attrs
        is_dir = bool(attrs.permissions and stat.S_ISDIR(attrs.permissions))
        mtime: Optional[datetime] = None
        if attrs.mtime:
            try:
                mtime = datetime.fromtimestamp(attrs.mtime)
            except (OSError, OverflowError):
                pass

        entries.append(
            NodeFileCache(
                node_id=node_id,
                path=full_path,
                name=name,
                type="dir" if is_dir else "file",
                size_bytes=None if is_dir else attrs.size,
                modified_at=mtime,
            )
        )

        if is_dir:
            await _walk(sftp, full_path, node_id, entries, max_depth, depth + 1)
