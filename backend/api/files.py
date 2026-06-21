from fastapi import APIRouter

# File-cache endpoints have been replaced by the live SFTP browse endpoint
# at GET /api/nodes/{node_id}/browse (see nodes.py).
router = APIRouter(prefix="/api/nodes", tags=["files"])
