import asyncio
import socket


def _build_magic_packet(mac: str) -> bytes:
    mac_bytes = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    return b"\xff" * 6 + mac_bytes * 16


async def send_wol(mac: str, broadcast: str = "255.255.255.255", port: int = 9) -> None:
    packet = _build_magic_packet(mac)
    loop = asyncio.get_event_loop()

    def _send():
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.sendto(packet, (broadcast, port))

    await loop.run_in_executor(None, _send)
