from typing import Any, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler()
    return _scheduler


def start_scheduler() -> None:
    sched = get_scheduler()
    if not sched.running:
        sched.start()


def stop_scheduler() -> None:
    sched = get_scheduler()
    if sched and sched.running:
        sched.shutdown(wait=False)


def schedule_job(job_id: int, cron: str, func: Callable, *args: Any) -> None:
    sched = get_scheduler()
    sched.add_job(
        func,
        CronTrigger.from_crontab(cron),
        args=args,
        id=f"job_{job_id}",
        replace_existing=True,
    )


def unschedule_job(job_id: int) -> None:
    sched = get_scheduler()
    key = f"job_{job_id}"
    if sched.get_job(key):
        sched.remove_job(key)
