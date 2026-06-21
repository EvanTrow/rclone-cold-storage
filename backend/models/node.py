from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Enum as SAEnum, Integer, String
from sqlalchemy.orm import relationship

from .base import Base


class Node(Base):
    __tablename__ = "nodes"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    mac = Column(String, nullable=False)
    ip = Column(String, nullable=False)
    ssh_user = Column(String, nullable=False)
    ssh_key_path = Column(String, nullable=True)
    ssh_port = Column(Integer, default=22)
    sftp_root = Column(String, default="/")
    status = Column(
        SAEnum("online", "offline", "waking", "unknown", name="node_status"),
        default="unknown",
    )
    allow_shutdown = Column(Boolean, default=True, nullable=False, server_default="1")
    last_seen = Column(DateTime, nullable=True)
    last_cache_refresh = Column(DateTime, nullable=True)

    file_cache = relationship("NodeFileCache", back_populates="node", cascade="all, delete-orphan")
    source_jobs = relationship("Job", foreign_keys="Job.source_node_id", back_populates="source_node")
    dest_jobs = relationship("Job", foreign_keys="Job.dest_node_id", back_populates="dest_node")
    lock = relationship("NodeLock", back_populates="node", uselist=False, cascade="all, delete-orphan")
