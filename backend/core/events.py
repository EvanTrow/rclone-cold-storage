"""In-process pub/sub for pushing live updates to SSE clients.

Single-process only: every publisher (API handlers, the job runner, the node
status refresher) runs in the same asyncio event loop as the SSE subscribers,
so a plain ``asyncio.Queue`` per subscriber is enough. Events are lightweight
"something changed" signals — the frontend reacts by refetching the affected
resource over HTTP, keeping the server the single source of truth.
"""
import asyncio
import logging

logger = logging.getLogger(__name__)

# Bounded so a stalled client can't grow memory without limit. On overflow we
# drop the event; the client resyncs on reconnect / window focus anyway.
_MAX_QUEUE = 1000

_subscribers: set[asyncio.Queue] = set()


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_MAX_QUEUE)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def publish(event: dict) -> None:
    """Fan an event out to all connected subscribers.

    Safe to call from any coroutine running on the main event loop. Never
    raises — a full subscriber queue just drops the event.
    """
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("SSE subscriber queue full — dropping event %s", event)


# Convenience helpers so call sites read clearly and event names stay consistent
# with what the frontend listens for.
def publish_jobs() -> None:
    publish({"type": "jobs"})


def publish_nodes() -> None:
    publish({"type": "nodes"})


def publish_runs() -> None:
    publish({"type": "runs"})


def publish_run(run_id: int) -> None:
    publish({"type": "run", "id": run_id})
