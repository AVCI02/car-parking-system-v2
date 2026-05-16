from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth_tokens import decode_access_token
from app.database import get_db
from app.models import User

security = HTTPBearer(auto_error=False)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="يجب تسجيل الدخول.")
    payload = decode_access_token(creds.credentials)
    username = payload.get("sub")
    if not username or not isinstance(username, str):
        raise HTTPException(status_code=401, detail="رمز الدخول غير صالح.")
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise HTTPException(status_code=401, detail="المستخدم غير موجود.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقوف.")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="هذه العملية للمدير فقط.",
        )
    return user
