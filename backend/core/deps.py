from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_jwt_secret
from backend.core.security import decode_access_token, hash_api_key
from backend.db.session import get_db
from backend.models import ApiKey, User


async def _resolve_user(request: Request, db: AsyncSession) -> Optional[User]:
    # Bearer API key takes priority
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        raw_key = auth_header[7:]
        key_hash = hash_api_key(raw_key)
        result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        api_key = result.scalar_one_or_none()
        if api_key:
            if api_key.expires_at and api_key.expires_at < datetime.utcnow():
                return None
            api_key.last_used_at = datetime.utcnow()
            await db.commit()
            result2 = await db.execute(select(User).where(User.id == api_key.user_id))
            user = result2.scalar_one_or_none()
            if user:
                # Attach effective role (key role is capped at user role)
                roles = {"admin": 1, "viewer": 0}
                effective = api_key.role if roles.get(api_key.role, 0) <= roles.get(user.role, 0) else user.role
                user._effective_role = effective
            return user
        return None

    # JWT cookie fallback
    token = request.cookies.get("access_token")
    if not token:
        return None

    secret = await get_jwt_secret(db)
    payload = decode_access_token(token, secret)
    if not payload:
        return None

    user_id = payload.get("sub")
    if not user_id:
        return None

    result = await db.execute(select(User).where(User.id == int(user_id)))
    user = result.scalar_one_or_none()
    if user:
        user._effective_role = user.role
    return user


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await _resolve_user(request, db)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    role = getattr(user, "_effective_role", user.role)
    if role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
