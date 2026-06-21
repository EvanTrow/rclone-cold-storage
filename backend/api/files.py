import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_setting
from backend.core.deps import get_current_user, require_admin
from backend.core.file_cache import crawl_node_sftp
from backend.db.session import get_db
from backend.models import Node, NodeFileCache, User

router = APIRouter(prefix="/api/nodes", tags=["files"])


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
            "modified_at": e.modified_at.isoformat() if e.modified_at else None,
        }
        for e in result.scalars()
    ]


@router.post("/{node_id}/files/refresh")
async def refresh_file_cache(
    node_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    async def _crawl():
        from backend.db.session import AsyncSessionLocal
        async with AsyncSessionLocal() as fresh_db:
            fresh_node = await fresh_db.get(Node, node_id)
            max_depth = int(await get_setting(fresh_db, "cache_max_depth") or 5)
            await crawl_node_sftp(fresh_node, fresh_db, max_depth)

    background_tasks.add_task(_crawl)
    return {"message": "Cache refresh started"}
