import os
import platform
import subprocess
from pathlib import Path


def keys_dir() -> Path:
    d = Path(os.getenv("SSH_KEYS_DIR", "./data/ssh_keys")).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def key_path(node_id: int) -> Path:
    return keys_dir() / f"node_{node_id}.pem"


def normalize_pem(content: str) -> str:
    lines = content.replace("\r\n", "\n").replace("\r", "\n").strip().split("\n")
    lines = [line.strip() for line in lines if line.strip()]
    return "\n".join(lines) + "\n"


def lock_down_key_file(path: Path) -> None:
    if platform.system() == "Windows":
        user = os.getenv("USERNAME")

        if not user:
            return

        subprocess.run(
            ["icacls", str(path), "/inheritance:r"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        subprocess.run(
            ["icacls", str(path), "/grant:r", f"{user}:F"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        subprocess.run(
            [
                "icacls",
                str(path),
                "/remove:g",
                "Users",
                "Authenticated Users",
                "Everyone",
                "BUILTIN\\Users",
                "NT AUTHORITY\\Authenticated Users",
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        path.chmod(0o600)


def save_key(node_id: int, content: str) -> str:
    path = key_path(node_id)

    path.write_text(normalize_pem(content), encoding="utf-8", newline="\n")
    lock_down_key_file(path)

    return str(path)


def delete_key(node_id: int) -> None:
    path = key_path(node_id)

    if path.exists():
        path.unlink()