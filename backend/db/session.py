import os
from pathlib import Path

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_default_db = Path(__file__).parent / "rccs.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{_default_db}")

engine = create_async_engine(DATABASE_URL, echo=False)

# WAL mode allows concurrent readers alongside the single writer, eliminating
# the "database is locked" errors that occur with the default DELETE journal.
@event.listens_for(engine.sync_engine, "connect")
def _set_wal_mode(dbapi_conn, _record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def init_db():
    from backend.models import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate(conn)


async def _migrate(conn) -> None:
    """Apply additive schema changes that create_all cannot handle."""
    result = await conn.execute(text("PRAGMA table_info(jobs)"))
    existing = {row[1] for row in result.fetchall()}
    if "delete_on_success" not in existing:
        await conn.execute(
            text("ALTER TABLE jobs ADD COLUMN delete_on_success BOOLEAN NOT NULL DEFAULT 0")
        )

    result = await conn.execute(text("PRAGMA table_info(runs)"))
    run_cols = {row[1] for row in result.fetchall()}
    if "job_name" not in run_cols:
        # SQLite can't ALTER COLUMN — rebuild the table to make job_id nullable
        # and add the job_name column so history survives job deletion.
        await conn.execute(text("""
            CREATE TABLE runs_new (
                id INTEGER NOT NULL PRIMARY KEY,
                job_id INTEGER REFERENCES jobs(id),
                job_name VARCHAR,
                started_at DATETIME,
                finished_at DATETIME,
                status VARCHAR NOT NULL,
                bytes_transferred BIGINT,
                files_transferred INTEGER,
                log_output TEXT,
                validation_passed BOOLEAN,
                alert_read BOOLEAN NOT NULL DEFAULT 0
            )
        """))
        await conn.execute(text("""
            INSERT INTO runs_new
                (id, job_id, job_name, started_at, finished_at, status,
                 bytes_transferred, files_transferred, log_output,
                 validation_passed, alert_read)
            SELECT id, job_id, NULL, started_at, finished_at, status,
                   bytes_transferred, files_transferred, log_output,
                   validation_passed, alert_read
            FROM runs
        """))
        await conn.execute(text("DROP TABLE runs"))
        await conn.execute(text("ALTER TABLE runs_new RENAME TO runs"))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_runs_job_id ON runs(job_id)"
        ))
