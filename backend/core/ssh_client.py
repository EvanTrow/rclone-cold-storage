import asyncio
import logging
from pathlib import Path
from typing import Optional

import asyncssh

logger = logging.getLogger(__name__)


def _load_client_keys(key_path: Optional[str]) -> list:
    if not key_path:
        logger.warning("SSH connection attempted with no key configured")
        return []
    path = Path(key_path)
    if not path.exists():
        raise FileNotFoundError(f"SSH key file not found: {path}")
    key = asyncssh.read_private_key(str(path))
    logger.debug("Loaded %s key from %s", key.get_algorithm(), path)
    return [key]


def _connect_kwargs(ip: str, user: str, key_path: Optional[str], port: int) -> dict:
    keys = _load_client_keys(key_path)
    kwargs: dict = dict(
        host=ip,
        port=port,
        username=user,
        client_keys=keys,
        known_hosts=None,
    )
    if keys:
        kwargs["preferred_auth"] = "publickey"
    return kwargs


async def test_ssh_connection(
    ip: str,
    user: str,
    key_path: Optional[str],
    port: int = 22,
    timeout: int = 10,
) -> tuple[bool, Optional[str]]:
    """Returns (reachable, error_message). error_message is None on success."""
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(**_connect_kwargs(ip, user, key_path, port)),
            timeout=timeout,
        )
        conn.close()
        return True, None
    except FileNotFoundError as e:
        return False, str(e)
    except asyncssh.PermissionDenied:
        msg = f"Permission denied for {user}@{ip} — check the key is authorized on the server"
        logger.warning(msg)
        return False, msg
    except asyncssh.DisconnectError as e:
        return False, f"SSH disconnect: {e}"
    except asyncio.TimeoutError:
        return False, f"Connection to {ip}:{port} timed out after {timeout}s"
    except Exception as e:
        logger.warning("SSH connection to %s@%s:%s failed: %s", user, ip, port, e)
        return False, str(e)


async def run_ssh_command(
    ip: str,
    user: str,
    key_path: Optional[str],
    command: str,
    port: int = 22,
) -> tuple[int, str, str]:
    async with asyncssh.connect(**_connect_kwargs(ip, user, key_path, port)) as conn:
        result = await conn.run(command)
        return result.exit_status or 0, result.stdout or "", result.stderr or ""


async def shutdown_node(
    ip: str, user: str, key_path: Optional[str], port: int = 22
) -> None:
    await run_ssh_command(ip, user, key_path, "sudo poweroff", port)


async def poll_until_reachable(
    ip: str,
    user: str,
    key_path: Optional[str],
    port: int = 22,
    max_retries: int = 30,
    interval: int = 10,
) -> bool:
    for _ in range(max_retries):
        reachable, _ = await test_ssh_connection(ip, user, key_path, port, timeout=interval)
        if reachable:
            return True
        await asyncio.sleep(interval)
    return False
