"""Import vehicle records from المركبات.txt into vehicle_profiles (PostgreSQL)."""

from __future__ import annotations

import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Project root on sys.path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.database import _database_url, ensure_schema_migrations
from app.models import VehicleProfile

VEHICLES_FILE = ROOT / "المركبات.txt"
KNOWN_TYPES = {"براد", "سطحة"}
HEADER_TOKENS = {
    "النوع",
    "اسم السائق",
    "رقم لوحة المركبة",
    "الشركة التضامنية",
    "نوع",
}
DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")


def _normalize_db_url(url: str) -> str:
    url = url.strip()
    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url.removeprefix("postgres://")
    elif url.startswith("postgresql://") and "+psycopg2" not in url.split("://", 1)[0]:
        url = "postgresql+psycopg2://" + url.removeprefix("postgresql://")
    return url


def _looks_like_plate(value: str) -> bool:
    value = value.strip()
    if not value or len(value) > 32:
        return False
    if DATE_RE.match(value):
        return False
    if value in KNOWN_TYPES or value in HEADER_TOKENS:
        return False
    alnum = sum(ch.isalnum() for ch in value)
    digits = sum(ch.isdigit() for ch in value)
    if alnum == 0:
        return False
    return digits >= max(1, alnum // 2)


def _iter_fields(path: Path) -> list[str]:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    text = raw.decode("utf-8")
    fields: list[str] = []
    for physical_line in text.split("\n"):
        for part in physical_line.split("\r"):
            part = part.strip()
            if part:
                fields.append(part)
    return fields


def parse_records(path: Path) -> list[dict[str, str | None]]:
    fields = _iter_fields(path)
    records: list[dict[str, str | None]] = []
    i = 0
    n = len(fields)

    while i < n:
        token = fields[i]
        if token in HEADER_TOKENS or DATE_RE.match(token):
            i += 1
            continue
        if token not in KNOWN_TYPES:
            i += 1
            continue

        vehicle_type = token
        if i + 2 < n and _looks_like_plate(fields[i + 2]):
            driver_name = fields[i + 1]
            license_plate = fields[i + 2]
            partnership_company = None
            i += 3
        elif i + 3 < n and _looks_like_plate(fields[i + 3]):
            partnership_company = fields[i + 1]
            driver_name = fields[i + 2]
            license_plate = fields[i + 3]
            i += 4
        else:
            i += 1
            continue

        plate = license_plate.strip().upper()
        if not plate:
            continue

        records.append(
            {
                "vehicle_type": vehicle_type[:64],
                "partnership_company": (partnership_company or "")[:128] or None,
                "driver_name": (driver_name or "")[:128] or None,
                "license_plate": plate[:32],
            }
        )

    return records


def _dedupe_records(records: list[dict[str, str | None]]) -> list[dict[str, str | None]]:
    seen: set[str] = set()
    unique: list[dict[str, str | None]] = []
    for row in records:
        plate = row["license_plate"]
        if plate in seen:
            continue
        seen.add(plate)
        unique.append(row)
    return unique


def import_to_db(records: list[dict[str, str | None]], database_url: str) -> tuple[int, int, int]:
    ensure_schema_migrations()
    engine = create_engine(_normalize_db_url(database_url), pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine)

    inserted = 0
    skipped = 0
    errors = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    with SessionLocal() as db:
        existing_plates = {
            (p or "").upper()
            for p in db.scalars(select(VehicleProfile.license_plate)).all()
        }

        batch: list[VehicleProfile] = []
        for row in records:
            plate = row["license_plate"]
            if plate in existing_plates:
                skipped += 1
                continue
            try:
                prof = VehicleProfile(
                    public_token=str(uuid.uuid4()),
                    license_plate=plate,
                    vehicle_make=None,
                    vehicle_type=row["vehicle_type"],
                    vehicle_color=None,
                    driver_name=row["driver_name"],
                    owner_name=None,
                    partnership_company=row["partnership_company"],
                    mechanical_number="",
                    photo_path=None,
                    created_at=now,
                )
                batch.append(prof)
                existing_plates.add(plate)
                inserted += 1
                if len(batch) >= 200:
                    db.add_all(batch)
                    db.commit()
                    batch.clear()
            except Exception:
                errors += 1

        if batch:
            db.add_all(batch)
            db.commit()

    return inserted, skipped, errors


def main() -> None:
    import os

    if not VEHICLES_FILE.is_file():
        print(f"File not found: {VEHICLES_FILE}", file=sys.stderr)
        sys.exit(1)

    db_url = (
        os.environ.get("DATABASE_PUBLIC_URL")
        or os.environ.get("DATABASE_URL")
        or _database_url()
    )
    if db_url.startswith("sqlite"):
        print("Set DATABASE_PUBLIC_URL or DATABASE_URL to PostgreSQL.", file=sys.stderr)
        sys.exit(1)

    parsed = parse_records(VEHICLES_FILE)
    unique = _dedupe_records(parsed)
    print(f"Parsed rows: {len(parsed)} | Unique plates: {len(unique)}")

    inserted, skipped, errors = import_to_db(unique, db_url)
    print(f"Inserted: {inserted} | Skipped (already in DB): {skipped} | Errors: {errors}")


if __name__ == "__main__":
    main()
