"""Background task: SSH-check all nodes and update their status in the DB."""
import asyncio
import logging
from datetime import datetime

from sqlalchemy import select

from backend.core import events
from backend.core.ssh_client import test_ssh_connection
from backend.db.session import AsyncSessionLocal
from backend.models import Node

logger = logging.getLogger(__name__)

_SSH_TIMEOUT = 5  # seconds — fast check, not a full poll


async def refresh_node_statuses() -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Node))
        nodes = list(result.scalars())

    if not nodes:
        return

    async def _check(node: Node) -> tuple[int, str]:
        reachable, _ = await test_ssh_connection(
            node.ip, node.ssh_user, node.ssh_key_path, node.ssh_port, timeout=_SSH_TIMEOUT
        )
        return node.id, "online" if reachable else "offline"

    results = await asyncio.gather(*[_check(n) for n in nodes], return_exceptions=True)

    changed = False
    async with AsyncSessionLocal() as db:
        # no_autoflush prevents SQLAlchemy from flushing dirty objects mid-loop
        # when db.get() is called on subsequent iterations.
        with db.no_autoflush:
            for item in results:
                if isinstance(item, Exception):
                    logger.warning("Node status check error: %s", item)
                    continue
                node_id, status = item
                node = await db.get(Node, node_id)
                if node and node.status != "waking":
                    transitioning_online = node.status != "online" and status == "online"
                    if node.status != status:
                        changed = True
                    node.status = status
                    if status == "online":
                        node.last_seen = datetime.utcnow()
                    if transitioning_online:
                        node.last_active_at = datetime.utcnow()
        await db.commit()

    # Only push when something actually flipped so idle clients aren't told to
    # refetch every cycle.
    if changed:
        events.publish_nodes()
