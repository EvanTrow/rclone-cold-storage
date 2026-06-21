from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer
from sqlalchemy.orm import relationship

from .base import Base


class NodeLock(Base):
    __tablename__ = "node_locks"

    node_id = Column(Integer, ForeignKey("nodes.id"), primary_key=True)
    locked_by_run_id = Column(Integer, ForeignKey("runs.id"), nullable=False)
    locked_at = Column(DateTime, default=datetime.utcnow)

    node = relationship("Node", back_populates="lock")
    run = relationship("Run", back_populates="node_lock")
