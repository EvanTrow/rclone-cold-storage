import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from backend.core import events
from backend.core.deps import _resolve_user
from backend.db.session import AsyncSessionLocal

router = APIRouter(prefix="/api", tags=["events"])

# How long to wait for an event before sending a heartbeat comment. Keeps the
# connection (and any intermediary proxy) alive and lets us notice a dropped
# client within this window.
_HEARTBEAT_SECONDS = 20


@router.get("/events")
async def stream_events(request: Request):
    # Authenticate with a short-lived session rather than Depends(get_db): a
    # streaming response holds its dependencies open for the whole connection,
    # and we don't want to pin a DB session for the stream's lifetime.
    async with AsyncSessionLocal() as db:
        user = await _resolve_user(request, db)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    queue = events.subscribe()

    async def gen():
        try:
            # Ask the browser to reconnect quickly, then open the stream.
            yield "retry: 3000\n\n"
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                if await request.is_disconnected():
                    break
        finally:
            events.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable proxy buffering (nginx and similar) so events flush live.
            "X-Accel-Buffering": "no",
        },
    )
