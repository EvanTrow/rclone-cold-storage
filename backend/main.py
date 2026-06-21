import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# asyncssh requires SelectorEventLoop; ProactorEventLoop (Windows default) breaks it
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.api import auth, files, health, nodes
from backend.api import jobs as jobs_router
from backend.api import runs
from backend.api import settings as settings_router
from backend.api import setup
from backend.core.node_status import refresh_node_statuses
from backend.core.scheduler import get_scheduler, start_scheduler, stop_scheduler
from backend.db.session import init_db

ROLE = os.getenv("ROLE", "controller")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    if ROLE == "controller":
        await _load_scheduled_jobs()
        start_scheduler()
        get_scheduler().add_job(
            refresh_node_statuses,
            "interval",
            seconds=15,
            id="node_status_refresh",
            replace_existing=True,
        )
        asyncio.create_task(refresh_node_statuses())
    elif ROLE == "node":
        await _start_node_agent()
    yield
    stop_scheduler()


async def _load_scheduled_jobs() -> None:
    from sqlalchemy import select

    from backend.core.job_runner import execute_job
    from backend.core.scheduler import schedule_job
    from backend.db.session import AsyncSessionLocal
    from backend.models import Job

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Job).where(Job.enabled == True, Job.schedule_cron.isnot(None), Job.schedule_cron != "")  # noqa: E712
        )
        for job in result.scalars():
            schedule_job(job.id, job.schedule_cron, execute_job, job.id)


async def _start_node_agent() -> None:
    import asyncio

    from backend.agent.idle_monitor import monitor_idle
    from backend.db.session import AsyncSessionLocal
    from backend.core.config import get_setting

    async with AsyncSessionLocal() as db:
        timeout = int(await get_setting(db, "idle_shutdown_timeout") or 3600)

    asyncio.create_task(monitor_idle(timeout))


app = FastAPI(title="rclone-cold-storage", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def setup_guard(request: Request, call_next):
    """Redirect API calls to setup status if no users exist yet."""
    path = request.url.path
    exempt = (
        path.startswith("/api/setup")
        or path == "/api/health"
        or not path.startswith("/api/")
    )
    if not exempt:
        from sqlalchemy import func, select

        from backend.db.session import AsyncSessionLocal
        from backend.models import User

        async with AsyncSessionLocal() as db:
            count = await db.scalar(select(func.count()).select_from(User))
        if count == 0:
            return JSONResponse({"detail": "setup_required"}, status_code=403)
    return await call_next(request)


app.include_router(auth.router)
app.include_router(setup.router)
app.include_router(health.router)
app.include_router(nodes.router)
app.include_router(files.router)
app.include_router(jobs_router.router)
app.include_router(runs.router)
app.include_router(settings_router.router)

# Serve built frontend (production only)
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if DIST.exists():
    _assets = DIST / "assets"
    if _assets.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa(full_path: str):
        return FileResponse(str(DIST / "index.html"))
