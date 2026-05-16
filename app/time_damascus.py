"""توقيت دمشق (Asia/Damascus) لعرض التواريخ وتجميع الإحصائيات."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    DAMASCUS = ZoneInfo("Asia/Damascus")
except ZoneInfoNotFoundError:
    # بدون حزمة tzdata (ويندوز): سوريا +03:00 دائمًا منذ 2022 تقريبًا
    DAMASCUS = timezone(timedelta(hours=3))

UTC = timezone.utc


def utc_naive_to_damascus(dt: datetime) -> datetime:
    """يُفترض أن القيمة المخزّنة naive وتُمثّل UTC (توافق SQLite)."""
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt.replace(tzinfo=UTC).astimezone(DAMASCUS)


def damascus_date_of_utc_naive(dt: datetime) -> date:
    return utc_naive_to_damascus(dt).date()


def damascus_today_date() -> date:
    return datetime.now(DAMASCUS).date()


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]
