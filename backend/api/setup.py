from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import hash_password
from backend.db.session import get_db
from backend.models import User

router = APIRouter(prefix="/api/setup", tags=["setup"])


class SetupRequest(BaseModel):
    username: str
    password: str


@router.get("/status")
async def setup_status(db: AsyncSession = Depends(get_db)):
    count = await db.scalar(select(func.count()).select_from(User))
    return {"needs_setup": count == 0}


@router.post("")
async def setup(body: SetupRequest, db: AsyncSession = Depends(get_db)):
    count = await db.scalar(select(func.count()).select_from(User))
    if count > 0:
        raise HTTPException(400, "Setup already completed")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role="admin",
    )
    db.add(user)
    await db.commit()
    return {"message": "Admin account created"}
