import asyncio
import os
import time


async def monitor_idle(idle_timeout_secs: int) -> None:
    """Shuts down the node after idle_timeout_secs of no active SSH/SFTP connections."""
    last_active = time.monotonic()
    while True:
        await asyncio.sleep(60)
        if await _has_active_connections():
            last_active = time.monotonic()
        elif time.monotonic() - last_active > idle_timeout_secs:
            os.system("sudo poweroff")
            return


async def _has_active_connections() -> bool:
    try:
        proc = await asyncio.create_subprocess_shell(
            "ss -tnp | grep ':22' | grep ESTABLISHED | wc -l",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return int(stdout.strip()) > 0
    except Exception:
        return True  # fail-safe: assume active if we can't tell
