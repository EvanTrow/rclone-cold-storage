from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Setting

DEFAULTS: dict[str, str] = {
    "wol_broadcast": "255.255.255.255",
    "ssh_port": "22",
    "idle_shutdown_timeout": "3600",
    "session_expiry_days": "30",
    "cache_max_depth": "5",
    "notification_webhook": "",
    "agent_callback_port": "8001",
}


async def get_setting(db: AsyncSession, key: str) -> Optional[str]:
    result = await db.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    return row.value if row else DEFAULTS.get(key)


async def set_setting(db: AsyncSession, key: str, value: str) -> None:
    result = await db.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    await db.commit()


async def get_all_settings(db: AsyncSession) -> dict[str, str]:
    result = await db.execute(select(Setting))
    stored = {row.key: row.value for row in result.scalars()}
    return {**DEFAULTS, **stored}


async def get_jwt_secret(db: AsyncSession) -> str:
    from backend.core.security import generate_secret
    secret = await get_setting(db, "jwt_secret")
    if not secret:
        secret = generate_secret()
        await set_setting(db, "jwt_secret", secret)
    return secret
