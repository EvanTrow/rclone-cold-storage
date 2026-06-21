from sqlalchemy import Boolean, Column, Enum as SAEnum, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import relationship

from .base import Base


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    operation = Column(SAEnum("copy", "move", "sync", "delete", name="job_operation"), nullable=False)
    source_node_id = Column(Integer, ForeignKey("nodes.id"), nullable=True)
    source_paths = Column(JSON, nullable=True)
    dest_node_id = Column(Integer, ForeignKey("nodes.id"), nullable=True)
    dest_path = Column(String, nullable=True)
    target_paths = Column(JSON, nullable=True)
    schedule_cron = Column(String, nullable=True)
    shutdown_after = Column(Boolean, default=False, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    delete_on_success = Column(Boolean, default=False, nullable=False)

    source_node = relationship("Node", foreign_keys=[source_node_id], back_populates="source_jobs")
    dest_node = relationship("Node", foreign_keys=[dest_node_id], back_populates="dest_jobs")
    runs = relationship("Run", back_populates="job")
