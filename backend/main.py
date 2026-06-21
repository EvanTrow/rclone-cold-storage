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
from backend.api import events as events_router
from backend.api import jobs as jobs_router
from backend.api import runs
from backend.api import settings as settings_router
from backend.api import setup
from backend.core.node_status import refresh_node_statuses
from backend.core.scheduler import get_scheduler, start_scheduler, stop_scheduler
from backend.db.session import init_db

import logging
logger = logging.getLogger(__name__)

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
        get_scheduler().add_job(
            _check_idle_nodes,
            "interval",
            seconds=60,
            id="idle_node_check",
            replace_existing=True,
        )
        asyncio.create_task(refresh_node_statuses())
    yield
    stop_scheduler()


async def _check_idle_nodes() -> None:
    from datetime import datetime
    from sqlalchemy import select

    from backend.core import events
    from backend.core.ssh_client import shutdown_node
    from backend.db.session import AsyncSessionLocal
    from backend.models import Node, NodeLock

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Node).where(
                Node.idle_shutdown_enabled == True,  # noqa: E712
                Node.status == "online",
                Node.last_active_at.isnot(None),
            )
        )
        nodes = list(result.scalars())

        locked_result = await db.execute(select(NodeLock.node_id))
        locked_ids = {row[0] for row in locked_result}

        now = datetime.utcnow()
        for node in nodes:
            if node.id in locked_ids:
                continue
            if not node.allow_shutdown:
                continue
            idle_secs = (now - node.last_active_at).total_seconds()
            if idle_secs < node.idle_shutdown_timeout:
                continue
            logger.info("Shutting down idle node %s (idle %.0fs / timeout %ds)", node.name, idle_secs, node.idle_shutdown_timeout)
            try:
                await shutdown_node(node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port)
                node.status = "offline"
                await db.commit()
                events.publish_nodes()
            except Exception as exc:
                logger.warning("Failed to shut down idle node %s: %s", node.name, exc)


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
app.include_router(events_router.router)

# Serve built frontend (production only)
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if DIST.exists():
    _assets = DIST / "assets"
    if _assets.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa(full_path: str):
        return FileResponse(str(DIST / "index.html"))
