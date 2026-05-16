"""حساب إحصائيات الشهر (تقويم دمشق) لإعادة الاستخدام في JSON وتصدير Excel."""

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ParkingSession
from app.schemas import MonthStatDayItem, MonthStatsResponse
from app.time_damascus import damascus_date_of_utc_naive, days_in_month


def build_month_stats_response(db: Session, year: int, month: int) -> MonthStatsResponse:
    all_rows = db.scalars(select(ParkingSession)).all()
    entry_counts: dict[int, int] = defaultdict(int)
    counts: dict[int, int] = defaultdict(int)
    revenue: dict[int, int] = defaultdict(int)

    for r in all_rows:
        d_in = damascus_date_of_utc_naive(r.entered_at)
        if d_in.year == year and d_in.month == month:
            entry_counts[d_in.day] += 1
        if r.exited_at is not None:
            d_out = damascus_date_of_utc_naive(r.exited_at)
            if d_out.year == year and d_out.month == month:
                counts[d_out.day] += 1
                revenue[d_out.day] += int(r.amount_due_cents or 0)

    last = days_in_month(year, month)
    day_items: list[MonthStatDayItem] = []
    total_c = 0
    total_r = 0
    total_e = 0
    for day in range(1, last + 1):
        ec = entry_counts.get(day, 0)
        c = counts.get(day, 0)
        rev = revenue.get(day, 0)
        total_e += ec
        total_c += c
        total_r += rev
        day_items.append(
            MonthStatDayItem(
                day=day,
                entry_count=ec,
                checkout_count=c,
                revenue_syp_new=rev,
            )
        )

    return MonthStatsResponse(
        year=year,
        month=month,
        days=day_items,
        total_entries=total_e,
        total_checkouts=total_c,
        total_revenue_syp_new=total_r,
    )
