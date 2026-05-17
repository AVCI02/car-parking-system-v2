import os
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent


def _sqlite_db_path() -> Path:
    """مسار ملف SQLite — يُفضّل مجلدًا دائمًا على الاستضافة (مثلاً volume)."""
    raw = (os.environ.get("SQLITE_DB_PATH") or "").strip()
    if raw:
        p = Path(raw)
        if not p.is_absolute():
            p = BASE_DIR / p
        return p
    return BASE_DIR / "parking.db"


def _database_url() -> str:
    raw = (os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        db_path = _sqlite_db_path()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{db_path.as_posix()}"
    # Railway / Heroku قد يمرّرون postgres:// بينما SQLAlchemy يتوقع postgresql://
    if raw.startswith("postgres://"):
        raw = "postgresql+psycopg2://" + raw.removeprefix("postgres://")
    elif raw.startswith("postgresql://") and "+psycopg" not in raw.split("://", 1)[0]:
        raw = "postgresql+psycopg2://" + raw.removeprefix("postgresql://")
    return raw


DATABASE_URL = _database_url()
IS_SQLITE = DATABASE_URL.startswith("sqlite")

if IS_SQLITE:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
    )


@event.listens_for(engine, "connect")
def _configure_sqlite_connection(dbapi_conn, _connection_record) -> None:
    if not IS_SQLITE:
        return
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _add_column_if_missing(table: str, column: str, ddl: str) -> None:
    from sqlalchemy import inspect

    insp = inspect(engine)
    if table not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns(table)}
    if column in cols:
        return
    with engine.begin() as conn:
        conn.execute(text(ddl))


def ensure_schema_migrations() -> None:
    """ترقية مخطط قواعد قديمة بإضافة أعمدة فقط — دون حذف جداول أو بيانات."""
    _add_column_if_missing(
        "parking_sessions",
        "vehicle_profile_id",
        "ALTER TABLE parking_sessions ADD COLUMN vehicle_profile_id INTEGER",
    )
    _add_column_if_missing(
        "vehicle_profiles",
        "mechanical_number",
        "ALTER TABLE vehicle_profiles ADD COLUMN mechanical_number VARCHAR(64) NOT NULL DEFAULT ''",
    )
    _add_column_if_missing(
        "vehicle_profiles",
        "vehicle_type",
        "ALTER TABLE vehicle_profiles ADD COLUMN vehicle_type VARCHAR(64)",
    )
    _add_column_if_missing(
        "vehicle_profiles",
        "driver_name",
        "ALTER TABLE vehicle_profiles ADD COLUMN driver_name VARCHAR(128)",
    )
    _add_column_if_missing(
        "vehicle_profiles",
        "owner_name",
        "ALTER TABLE vehicle_profiles ADD COLUMN owner_name VARCHAR(128)",
    )
    _add_column_if_missing(
        "vehicle_profiles",
        "partnership_company",
        "ALTER TABLE vehicle_profiles ADD COLUMN partnership_company VARCHAR(128)",
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
