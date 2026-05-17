from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ParkingSettings(Base):
    __tablename__ = "parking_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    total_slots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    price_per_hour_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=200)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class VehicleProfile(Base):
    """بروفايل ثابت للمركبة (من السائق أو تسجيل يدوي من الموظف) مع رمز عام للـ QR."""

    __tablename__ = "vehicle_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    public_token: Mapped[str] = mapped_column(String(40), unique=True, nullable=False, index=True)
    license_plate: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    vehicle_make = mapped_column(String(64), nullable=True)
    vehicle_type = mapped_column(String(64), nullable=True)
    vehicle_color = mapped_column(String(32), nullable=True)
    driver_name = mapped_column(String(128), nullable=True)
    owner_name = mapped_column(String(128), nullable=True)
    partnership_company = mapped_column(String(128), nullable=True)
    mechanical_number: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    photo_path: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at = mapped_column(DateTime, nullable=False)


class ParkingSession(Base):
    __tablename__ = "parking_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    receipt_code: Mapped[str] = mapped_column(String(36), unique=True, nullable=False, index=True)
    license_plate: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    vehicle_make = mapped_column(String(64), nullable=True)
    vehicle_color = mapped_column(String(32), nullable=True)
    notes = mapped_column(Text, nullable=True)
    slot_number: Mapped[int] = mapped_column(Integer, nullable=False)
    entered_at = mapped_column(DateTime, nullable=False)
    exited_at = mapped_column(DateTime, nullable=True)
    hours_billed = mapped_column(Float, nullable=True)
    amount_due_cents = mapped_column(Integer, nullable=True)
    paid: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    vehicle_profile_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("vehicle_profiles.id"), nullable=True, index=True
    )
