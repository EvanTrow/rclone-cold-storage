from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_all_settings, get_setting, set_setting
from backend.core.deps import get_current_user, require_admin
from backend.core.security import generate_api_key, hash_password
from backend.db.session import get_db
from backend.models import ApiKey, User

router = APIRouter(prefix="/api/settings", tags=["settings"])

EDITABLE_KEYS = {
    "wol_broadcast", "ssh_port", "idle_shutdown_timeout",
    "session_expiry_days", "cache_max_depth", "notification_webhook",
    "agent_callback_port",
}


# ── General settings ─────────────────────────────────────────────────────────

@router.get("")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    all_settings = await get_all_settings(db)
    # Never expose jwt_secret
    all_settings.pop("jwt_secret", None)
    return all_settings


@router.put("")
async def update_settings(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    for key, value in body.items():
        if key in EDITABLE_KEYS:
            await set_setting(db, key, str(value))
    return await get_all_settings(db)


# ── Webhook test ──────────────────────────────────────────────────────────────

@router.post("/test-webhook")
async def test_webhook(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    url = await get_setting(db, "notification_webhook")
    if not url:
        raise HTTPException(400, "No webhook URL configured")
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                url,
                json={"message": "rclone-cold-storage test notification"},
                timeout=10,
            )
        return {"status_code": r.status_code, "ok": r.is_success}
    except Exception as exc:
        raise HTTPException(502, f"Webhook request failed: {exc}")


# ── Users ─────────────────────────────────────────────────────────────────────

def _user_dict(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "role": u.role,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login": u.last_login.isoformat() if u.last_login else None,
    }


class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "viewer"


class UserUpdate(BaseModel):
    password: Optional[str] = None
    role: Optional[str] = None


@router.get("/users")
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.username))
    return [_user_dict(u) for u in result.scalars()]


@router.post("/users")
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    if body.role not in ("admin", "viewer"):
        raise HTTPException(400, "Role must be admin or viewer")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    existing = await db.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Username already taken")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _user_dict(user)


@router.put("/users/{user_id}")
async def update_user(
    user_id: int,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    is_admin = getattr(current_user, "_effective_role", current_user.role) == "admin"
    is_self = current_user.id == user_id

    if not is_admin and not is_self:
        raise HTTPException(403, "Cannot modify another user's account")

    if body.password:
        if len(body.password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        target.password_hash = hash_password(body.password)

    if body.role is not None:
        if not is_admin:
            raise HTTPException(403, "Only admins can change roles")
        if body.role not in ("admin", "viewer"):
            raise HTTPException(400, "Role must be admin or viewer")
        target.role = body.role

    await db.commit()
    await db.refresh(target)
    return _user_dict(target)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if current_user.id == user_id:
        raise HTTPException(400, "Cannot delete your own account")
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    await db.delete(target)
    await db.commit()
    return {"message": "User deleted"}


# ── API Keys ──────────────────────────────────────────────────────────────────

def _key_dict(k: ApiKey, owner_username: Optional[str] = None) -> dict:
    d = {
        "id": k.id,
        "name": k.name,
        "role": k.role,
        "user_id": k.user_id,
        "created_at": k.created_at.isoformat() if k.created_at else None,
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
        "expires_at": k.expires_at.isoformat() if k.expires_at else None,
    }
    if owner_username is not None:
        d["owner_username"] = owner_username
    return d


class ApiKeyCreate(BaseModel):
    name: str
    role: str = "viewer"
    expires_at: Optional[datetime] = None


@router.get("/api-keys")
async def list_api_keys(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    is_admin = getattr(current_user, "_effective_role", current_user.role) == "admin"
    if is_admin:
        result = await db.execute(select(ApiKey).order_by(ApiKey.created_at.desc()))
        keys = result.scalars().all()
        user_ids = {k.user_id for k in keys}
        users_result = await db.execute(select(User).where(User.id.in_(user_ids)))
        user_map = {u.id: u.username for u in users_result.scalars()}
        return [_key_dict(k, user_map.get(k.user_id)) for k in keys]
    else:
        result = await db.execute(
            select(ApiKey).where(ApiKey.user_id == current_user.id).order_by(ApiKey.created_at.desc())
        )
        return [_key_dict(k) for k in result.scalars()]


@router.post("/api-keys")
async def create_api_key(
    body: ApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.role not in ("admin", "viewer"):
        raise HTTPException(400, "Role must be admin or viewer")
    # Cap role at owner's role
    roles = {"admin": 1, "viewer": 0}
    if roles.get(body.role, 0) > roles.get(current_user.role, 0):
        raise HTTPException(403, "Cannot create a key with higher role than your own")

    raw_key, key_hash = generate_api_key()
    api_key = ApiKey(
        name=body.name,
        key_hash=key_hash,
        user_id=current_user.id,
        role=body.role,
        expires_at=body.expires_at,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)
    return {**_key_dict(api_key), "key": raw_key}


@router.delete("/api-keys/{key_id}")
async def revoke_api_key(
    key_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    key = await db.get(ApiKey, key_id)
    if not key:
        raise HTTPException(404, "API key not found")
    is_admin = getattr(current_user, "_effective_role", current_user.role) == "admin"
    if not is_admin and key.user_id != current_user.id:
        raise HTTPException(403, "Cannot revoke another user's key")
    await db.delete(key)
    await db.commit()
    return {"message": "API key revoked"}
