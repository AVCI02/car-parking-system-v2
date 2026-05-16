import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException

JWT_SECRET = os.environ.get(
    "PARKING_JWT_SECRET",
    "dev-only-change-PARKING_JWT_SECRET-in-production-32chars",
)
JWT_ALGORITHM = "HS256"
JWT_HOURS = int(os.environ.get("PARKING_JWT_HOURS", "12"))


def create_access_token(*, username: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=JWT_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=401,
            detail="انتهت الجلسة أو رمز الدخول غير صالح.",
        ) from e
