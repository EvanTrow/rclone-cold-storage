from datetime import datetime

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Enum as SAEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from .base import Base


class Run(Base):
    __tablename__ = "runs"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    job_name = Column(String, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    status = Column(
        SAEnum("success", "failed", "running", "queued", "cancelled",
               name="run_status", create_constraint=False),
        nullable=False,
        default="queued",
    )
    bytes_transferred = Column(BigInteger, nullable=True)
    files_transferred = Column(Integer, nullable=True)
    log_output = Column(Text, nullable=True)
    validation_passed = Column(Boolean, nullable=True)
    alert_read = Column(Boolean, default=False, nullable=False)

    job = relationship("Job", back_populates="runs")
    node_lock = relationship("NodeLock", back_populates="run", uselist=False)
