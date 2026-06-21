from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.deps import get_current_user, require_admin
from backend.core.job_runner import cancel_run
from backend.db.session import get_db
from backend.models import Run, User

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _run_dict(r: Run, include_log: bool = False) -> dict:
    d = {
        "id": r.id,
        "job_id": r.job_id,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "status": r.status,
        "bytes_transferred": r.bytes_transferred,
        "files_transferred": r.files_transferred,
        "validation_passed": r.validation_passed,
        "alert_read": r.alert_read,
    }
    if include_log:
        d["log_output"] = r.log_output
    return d


@router.get("")
async def list_runs(
    job_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    unread_only: bool = Query(False),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = select(Run).order_by(Run.started_at.desc()).limit(limit)
    if job_id is not None:
        q = q.where(Run.job_id == job_id)
    if status:
        q = q.where(Run.status == status)
    if unread_only:
        q = q.where(Run.alert_read == False)  # noqa: E712
    result = await db.execute(q)
    return [_run_dict(r) for r in result.scalars()]


@router.get("/{run_id}")
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return _run_dict(run, include_log=True)


@router.post("/mark-all-read")
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    await db.execute(update(Run).where(Run.alert_read == False).values(alert_read=True))  # noqa: E712
    await db.commit()
    return {"message": "All alerts marked as read"}


@router.post("/{run_id}/cancel")
async def cancel_run_endpoint(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    if run.status not in ("running", "queued"):
        raise HTTPException(400, f"Run is not active (status: {run.status})")
    if not cancel_run(run_id):
        raise HTTPException(400, "Run task not found — it may have just finished")
    return {"message": "Cancellation requested"}


@router.patch("/{run_id}/read")
async def mark_run_read(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    run.alert_read = True
    await db.commit()
    return {"message": "Marked as read"}
