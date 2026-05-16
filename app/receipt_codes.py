import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ParkingSession

# أحرف واضحة بدون 0/O ولا 1/I/L
_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_CODE_LEN = 10
_MAX_ATTEMPTS = 80


def random_receipt_body() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))


def allocate_unique_receipt_code(db: Session) -> str:
    """رمز إيصال قصير نسبيًا مع ضمان التفرد في قاعدة البيانات."""
    for _ in range(_MAX_ATTEMPTS):
        code = random_receipt_body()
        exists = db.scalar(
            select(ParkingSession.id).where(ParkingSession.receipt_code == code)
        )
        if exists is None:
            return code
    raise RuntimeError("تعذّر إنشاء رمز إيصال فريد بعد عدة محاولات.")
