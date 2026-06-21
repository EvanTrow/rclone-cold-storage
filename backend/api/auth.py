import time
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import get_jwt_secret, get_setting
from backend.core.deps import get_current_user
from backend.core.security import create_access_token, verify_password
from backend.db.session import get_db
from backend.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])

_attempts: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
MAX_ATTEMPTS = 5
LOCKOUT_SECS = 15 * 60


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    ip = request.client.host if request.client else "unknown"
    attempts, locked_until = _attempts[ip]
    if time.time() < locked_until:
        raise HTTPException(429, "Too many login attempts. Try again later.")

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        new_attempts = attempts + 1
        lockout = time.time() + LOCKOUT_SECS if new_attempts >= MAX_ATTEMPTS else 0.0
        _attempts[ip] = (new_attempts, lockout)
        raise HTTPException(401, "Invalid credentials")

    _attempts[ip] = (0, 0.0)
    user.last_login = datetime.utcnow()
    await db.commit()

    secret = await get_jwt_secret(db)
    expiry_days = int(await get_setting(db, "session_expiry_days") or 30)
    token = create_access_token(
        {"sub": str(user.id), "role": user.role},
        secret,
        timedelta(days=expiry_days),
    )
    response.set_cookie(
        "access_token",
        token,
        httponly=True,
        samesite="strict",
        max_age=expiry_days * 86400,
    )
    return {"username": user.username, "role": user.role}


@router.post("/logout")
async def logout(response: Response, _: User = Depends(get_current_user)):
    response.delete_cookie("access_token")
    return {"message": "Logged out"}


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "role": getattr(user, "_effective_role", user.role),
    }
