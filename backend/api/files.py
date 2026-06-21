import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_setting
from backend.core.deps import get_current_user, require_admin
from backend.core.file_cache import crawl_node_sftp
from backend.db.session import AsyncSessionLocal, get_db
from backend.models import Node, NodeFileCache, User

router = APIRouter(prefix="/api/nodes", tags=["files"])

# node_id → in-flight asyncio.Task for that node's crawl
_refresh_tasks: dict[int, asyncio.Task] = {}


@router.get("/{node_id}/files")
async def get_file_cache(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    result = await db.execute(
        select(NodeFileCache)
        .where(NodeFileCache.node_id == node_id)
        .order_by(NodeFileCache.path)
    )
    return [
        {
            "id": e.id,
            "path": e.path,
            "name": e.name,
            "type": e.type,
            "size_bytes": e.size_bytes,
            "modified_at": e.modified_at.isoformat() + "Z" if e.modified_at else None,
        }
        for e in result.scalars()
    ]


@router.post("/{node_id}/files/refresh")
async def refresh_file_cache(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    # Cancel any in-flight refresh for this node before starting a new one.
    existing = _refresh_tasks.pop(node_id, None)
    if existing and not existing.done():
        existing.cancel()
        try:
            await existing
        except (asyncio.CancelledError, Exception):
            pass

    max_depth = int(await get_setting(db, "cache_max_depth") or 5)

    async def _do_crawl() -> dict:
        async with AsyncSessionLocal() as fresh_db:
            fresh_node = await fresh_db.get(Node, node_id)
            return await crawl_node_sftp(fresh_node, fresh_db, max_depth)

    task: asyncio.Task = asyncio.ensure_future(_do_crawl())
    _refresh_tasks[node_id] = task
    try:
        counts = await task
    except asyncio.CancelledError:
        raise HTTPException(409, "Refresh was superseded by a newer request for this node")
    finally:
        _refresh_tasks.pop(node_id, None)

    return {"files": counts["files"], "dirs": counts["dirs"]}
