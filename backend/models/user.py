from datetime import datetime

from sqlalchemy import Column, DateTime, Enum as SAEnum, Integer, String
from sqlalchemy.orm import relationship

from .base import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(SAEnum("admin", "viewer", name="user_role"), nullable=False, default="viewer")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, nullable=True)

    api_keys = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
