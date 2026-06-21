import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core import events
from backend.core.config import get_setting
from backend.core.deps import get_current_user, require_admin
from backend.core.rclone_runner import speed_test
from backend.core.ssh_client import sftp_list_dir, shutdown_node, test_ssh_connection
from backend.core.ssh_key_store import delete_key, save_key
from backend.core.wol import send_wol
from backend.db.session import get_db
from backend.models import Node, NodeFileCache, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])


def _node_dict(n: Node) -> dict:
    return {
        "id": n.id,
        "name": n.name,
        "mac": n.mac,
        "ip": n.ip,
        "ssh_user": n.ssh_user,
        "ssh_key_path": n.ssh_key_path,
        "has_ssh_key": bool(n.ssh_key_path),
        "ssh_port": n.ssh_port,
        "sftp_root": n.sftp_root,
        "allow_shutdown": n.allow_shutdown,
        "wol_timeout": n.wol_timeout,
        "idle_shutdown_enabled": n.idle_shutdown_enabled,
        "idle_shutdown_timeout": n.idle_shutdown_timeout,
        "status": n.status,
        "last_seen": n.last_seen.isoformat() + "Z" if n.last_seen else None,
        "last_active_at": n.last_active_at.isoformat() + "Z" if n.last_active_at else None,
        "last_cache_refresh": n.last_cache_refresh.isoformat() + "Z" if n.last_cache_refresh else None,
    }


class NodeCreate(BaseModel):
    name: str
    mac: str
    ip: str
    ssh_user: str
    ssh_key_path: Optional[str] = None
    ssh_key_content: Optional[str] = None
    ssh_port: int = 22
    sftp_root: str = "/"
    allow_shutdown: bool = True
    wol_timeout: int = 300
    idle_shutdown_enabled: bool = False
    idle_shutdown_timeout: int = 3600


class NodeUpdate(BaseModel):
    name: Optional[str] = None
    mac: Optional[str] = None
    ip: Optional[str] = None
    ssh_user: Optional[str] = None
    ssh_key_path: Optional[str] = None
    ssh_key_content: Optional[str] = None
    ssh_port: Optional[int] = None
    sftp_root: Optional[str] = None
    allow_shutdown: Optional[bool] = None
    wol_timeout: Optional[int] = None
    idle_shutdown_enabled: Optional[bool] = None
    idle_shutdown_timeout: Optional[int] = None


@router.get("")
async def list_nodes(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Node).order_by(Node.name))
    return [_node_dict(n) for n in result.scalars()]


@router.post("")
async def create_node(
    body: NodeCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = Node(**body.model_dump(exclude={"ssh_key_content"}))
    db.add(node)
    await db.commit()
    await db.refresh(node)

    if body.ssh_key_content:
        node.ssh_key_path = save_key(node.id, body.ssh_key_content)
        await db.commit()
        await db.refresh(node)

    events.publish_nodes()
    return _node_dict(node)


@router.get("/{node_id}")
async def get_node(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    return _node_dict(node)


@router.patch("/{node_id}")
async def update_node(
    node_id: int,
    body: NodeUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    for field, value in body.model_dump(exclude_none=True, exclude={"ssh_key_content"}).items():
        setattr(node, field, value)

    if body.ssh_key_content:
        node.ssh_key_path = save_key(node.id, body.ssh_key_content)

    await db.commit()
    await db.refresh(node)
    events.publish_nodes()
    return _node_dict(node)


@router.delete("/{node_id}")
async def delete_node(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    delete_key(node_id)
    await db.delete(node)
    await db.commit()
    events.publish_nodes()
    return {"message": "Node deleted"}


@router.delete("/{node_id}/ssh-key", status_code=204)
async def delete_ssh_key(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    delete_key(node_id)
    node.ssh_key_path = None
    await db.commit()


@router.post("/{node_id}/test-connection")
async def test_connection(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    reachable, error = await test_ssh_connection(
        node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port
    )

    # Only measure transfer speed once we know SSH is up — the speed test
    # reaches the same host over SFTP and would otherwise just hang/fail.
    speed = None
    if reachable:
        result = await speed_test(
            node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port, node.sftp_root
        )
        speed = {
            "upload_bps": result.upload_bps,
            "download_bps": result.download_bps,
            "samples": [
                {
                    "size_bytes": s.size_bytes,
                    "num_files": s.num_files,
                    "upload_bps": s.upload_bps,
                    "download_bps": s.download_bps,
                }
                for s in result.samples
            ],
            "error": result.error,
        }

    return {"reachable": reachable, "error": error, "speed": speed}


@router.post("/{node_id}/shutdown", status_code=204)
async def shutdown_node_endpoint(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    await shutdown_node(node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port)
    node.status = "offline"
    await db.commit()
    events.publish_nodes()


@router.post("/{node_id}/wake", status_code=204)
async def wake_node(
    node_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    broadcast = await get_setting(db, "wol_broadcast") or "255.255.255.255"
    await send_wol(node.mac, broadcast)


# ─── SFTP browse ──────────────────────────────────────────────────────────────

def _parent_prefix(path: str) -> str:
    """Prefix for direct-child path queries. Root stays '/', others get '/'."""
    return "/" if path == "/" else path.rstrip("/") + "/"


async def _cached_children(db: AsyncSession, node_id: int, path: str) -> list[dict]:
    prefix = _parent_prefix(path)
    result = await db.execute(
        select(NodeFileCache)
        .where(
            NodeFileCache.node_id == node_id,
            NodeFileCache.path.like(f"{prefix}%"),
            ~NodeFileCache.path.like(f"{prefix}%/%"),
        )
        .order_by(NodeFileCache.type.desc(), NodeFileCache.name)
    )
    return [
        {
            "name": e.name,
            "path": e.path,
            "type": e.type,
            "size_bytes": e.size_bytes,
            "modified_at": e.modified_at.isoformat() + "Z" if e.modified_at else None,
        }
        for e in result.scalars()
    ]


async def _update_path_cache(db: AsyncSession, node_id: int, path: str, entries: list[dict]) -> None:
    prefix = _parent_prefix(path)
    await db.execute(
        sa_delete(NodeFileCache).where(
            NodeFileCache.node_id == node_id,
            NodeFileCache.path.like(f"{prefix}%"),
            ~NodeFileCache.path.like(f"{prefix}%/%"),
        )
    )
    for e in entries:
        db.add(NodeFileCache(
            node_id=node_id,
            path=e["path"],
            name=e["name"],
            type=e["type"],
            size_bytes=e.get("size_bytes"),
            modified_at=None,
        ))
    await db.commit()


@router.get("/{node_id}/browse")
async def browse_node_path(
    node_id: int,
    path: str = "/",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """List immediate children of *path* on the node via live SFTP (online)
    or from the local cache (offline / unreachable)."""
    node = await db.get(Node, node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    if node.status == "online":
        try:
            entries = await sftp_list_dir(
                node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port, path
            )
            try:
                await _update_path_cache(db, node_id, path, entries)
            except Exception as exc:
                logger.warning("Cache update failed node=%s path=%s: %s", node_id, path, exc)
            return entries
        except Exception as exc:
            logger.warning("SFTP browse failed node=%s path=%s: %s", node_id, path, exc)

    # Offline fallback — return whatever is cached for this directory
    return await _cached_children(db, node_id, path)
