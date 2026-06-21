from sqlalchemy import BigInteger, Column, DateTime, Enum as SAEnum, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from .base import Base


class NodeFileCache(Base):
    __tablename__ = "node_file_cache"

    id = Column(Integer, primary_key=True)
    node_id = Column(Integer, ForeignKey("nodes.id"), nullable=False, index=True)
    path = Column(String, nullable=False)
    name = Column(String, nullable=False)
    type = Column(SAEnum("file", "dir", name="cache_entry_type"), nullable=False)
    size_bytes = Column(BigInteger, nullable=True)
    modified_at = Column(DateTime, nullable=True)

    node = relationship("Node", back_populates="file_cache")
