import asyncio
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.deps import get_current_user, require_admin
from backend.core.job_runner import execute_job
from backend.core.scheduler import schedule_job, unschedule_job
from backend.db.session import get_db
from backend.models import Job, Node, User

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _job_dict(j: Job) -> dict:
    return {
        "id": j.id,
        "name": j.name,
        "operation": j.operation,
        "source_node_id": j.source_node_id,
        "source_paths": j.source_paths,
        "dest_node_id": j.dest_node_id,
        "dest_path": j.dest_path,
        "target_paths": j.target_paths,
        "schedule_cron": j.schedule_cron,
        "shutdown_after": j.shutdown_after,
        "enabled": j.enabled,
    }


class JobCreate(BaseModel):
    name: str
    operation: str  # copy | move | delete
    source_node_id: Optional[int] = None
    source_paths: Optional[list[str]] = None
    dest_node_id: Optional[int] = None
    dest_path: Optional[str] = None
    target_paths: Optional[list[str]] = None
    schedule_cron: Optional[str] = None
    shutdown_after: bool = False
    enabled: bool = True
    run_now: bool = False


class JobUpdate(BaseModel):
    name: Optional[str] = None
    operation: Optional[str] = None
    source_node_id: Optional[int] = None
    source_paths: Optional[list[str]] = None
    dest_node_id: Optional[int] = None
    dest_path: Optional[str] = None
    target_paths: Optional[list[str]] = None
    schedule_cron: Optional[str] = None
    shutdown_after: Optional[bool] = None
    enabled: Optional[bool] = None


def _sync_schedule(job: Job) -> None:
    if job.enabled and job.schedule_cron:
        schedule_job(job.id, job.schedule_cron, execute_job, job.id)
    else:
        unschedule_job(job.id)


@router.get("")
async def list_jobs(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Job).order_by(Job.name))
    return [_job_dict(j) for j in result.scalars()]


@router.post("")
async def create_job(
    body: JobCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    data = body.model_dump(exclude={"run_now"})
    job = Job(**data)
    db.add(job)
    await db.commit()
    await db.refresh(job)
    _sync_schedule(job)
    if body.run_now:
        background_tasks.add_task(execute_job, job.id)
    return _job_dict(job)


@router.get("/{job_id}")
async def get_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return _job_dict(job)


@router.patch("/{job_id}")
async def update_job(
    job_id: int,
    body: JobUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(job, field, value)
    await db.commit()
    await db.refresh(job)
    _sync_schedule(job)
    return _job_dict(job)


@router.delete("/{job_id}")
async def delete_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    unschedule_job(job_id)
    await db.delete(job)
    await db.commit()
    return {"message": "Job deleted"}


@router.post("/{job_id}/trigger")
async def trigger_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    background_tasks.add_task(execute_job, job_id)
    return {"message": "Job triggered"}
