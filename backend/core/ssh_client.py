import asyncio
import logging
import stat as _stat
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


async def sftp_list_dir(
    ip: str,
    user: str,
    key_path: Optional[str],
    port: int = 22,
    path: str = "/",
    timeout: int = 15,
) -> list[dict]:
    """List immediate children of *path* on the remote SFTP server."""
    async with asyncssh.connect(**_connect_kwargs(ip, user, key_path, port)) as conn:
        async with conn.start_sftp_client() as sftp:
            names = await asyncio.wait_for(sftp.readdir(path), timeout=timeout)

    result = []
    for item in names:
        name = item.filename
        if name in (".", ".."):
            continue
        child_path = path.rstrip("/") + "/" + name
        attrs = item.attrs
        is_dir = bool(attrs.permissions and _stat.S_ISDIR(attrs.permissions))
        result.append({
            "name": name,
            "path": child_path,
            "type": "dir" if is_dir else "file",
            "size_bytes": None if is_dir else attrs.size,
            "modified_at": None,
        })

    result.sort(key=lambda e: (0 if e["type"] == "dir" else 1, e["name"].lower()))
    return result


async def shutdown_node(
    ip: str, user: str, key_path: Optional[str], port: int = 22
) -> None:
    await run_ssh_command(ip, user, key_path, "sudo poweroff", port)


async def poll_until_reachable(
    ip: str,
    user: str,
    key_path: Optional[str],
    port: int = 22,
    timeout_secs: int = 300,
    interval: int = 10,
) -> bool:
    deadline = asyncio.get_event_loop().time() + timeout_secs
    while asyncio.get_event_loop().time() < deadline:
        reachable, _ = await test_ssh_connection(ip, user, key_path, port, timeout=interval)
        if reachable:
            return True
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            break
        await asyncio.sleep(min(interval, remaining))
    return False
