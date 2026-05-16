import math
from datetime import datetime, timezone


def stay_duration_hours(entry: datetime, exit_: datetime) -> float:
    """Actual elapsed time between entry and exit (for display on invoice)."""
    delta = exit_ - entry
    total_seconds = max(0.0, delta.total_seconds())
    return round(total_seconds / 3600.0, 2)


def billable_days(entry: datetime, exit_: datetime) -> int:
    """Bill by started calendar day: any fraction of a day rounds up (minimum one day)."""
    delta = exit_ - entry
    total_seconds = max(0.0, delta.total_seconds())
    days_raw = total_seconds / 86400.0
    if days_raw <= 0:
        return 1
    return int(math.ceil(days_raw))


def amount_due_cents(price_per_day_cents: int, billable_days: int) -> int:
    return int(round(price_per_day_cents * billable_days))


def utc_now() -> datetime:
    # Naive UTC for SQLite DATETIME compatibility
    return datetime.now(timezone.utc).replace(tzinfo=None)
