from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_setting
from backend.core.deps import get_current_user, require_admin
from backend.core.ssh_client import shutdown_node, test_ssh_connection
from backend.core.ssh_key_store import delete_key, save_key
from backend.core.wol import send_wol
from backend.db.session import get_db
from backend.models import Node, User

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
        "status": n.status,
        "last_seen": n.last_seen.isoformat() if n.last_seen else None,
        "last_cache_refresh": n.last_cache_refresh.isoformat() if n.last_cache_refresh else None,
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
    return {"reachable": reachable, "error": error}


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
