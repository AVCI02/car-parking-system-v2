import mimetypes
import os
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.auth_password import hash_password, verify_password
from app.auth_tokens import create_access_token
from app.billing import amount_due_cents, billable_days, stay_duration_hours, utc_now
from app.database import Base, SessionLocal, engine, get_db, ensure_schema_migrations
from app.deps import get_current_user, require_admin
from openpyxl import Workbook

from app.month_stats_service import build_month_stats_response
from app.models import ParkingSession, ParkingSettings, User, VehicleProfile
from app.receipt_codes import allocate_unique_receipt_code
from app.schemas import (
    ActiveSessionBrief,
    AdminRenameUserRequest,
    AdminSetPasswordRequest,
    AdminWipeDataRequest,
    ChangeOwnPasswordRequest,
    CheckInRequest,
    CheckInResponse,
    CheckOutRequest,
    CheckOutResponse,
    LoginRequest,
    LoginResponse,
    MonthStatsResponse,
    OkResponse,
    RenameUserResponse,
    SessionHistoryItem,
    SettingsResponse,
    SettingsUpdate,
    UserListItem,
    UserMe,
    VehicleProfileListItem,
    VehicleProfilePublic,
    VehiclePublicRegisterResponse,
    VehicleScanResponse,
    VehicleTokenBody,
)
from app.time_damascus import damascus_today_date


def seed_users_if_empty(db: Session) -> None:
    if db.scalar(select(User.id).limit(1)) is not None:
        return
    admin_pw = os.environ.get("PARKING_ADMIN_PASSWORD", "admin123")
    emp_pw = os.environ.get("PARKING_EMPLOYEE_PASSWORD", "employee123")
    db.add(
        User(
            username="admin",
            password_hash=hash_password(admin_pw),
            role="admin",
        )
    )
    db.add(
        User(
            username="employee",
            password_hash=hash_password(emp_pw),
            role="employee",
        )
    )
    db.commit()


def init_db():
    Base.metadata.create_all(bind=engine)
    ensure_schema_migrations()
    VEHICLE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db = SessionLocal()
    try:
        row = db.get(ParkingSettings, 1)
        if row is None:
            db.add(
                ParkingSettings(
                    id=1,
                    total_slots=20,
                    price_per_hour_cents=200,
                )
            )
            db.commit()
        seed_users_if_empty(db)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="ادارة الكراج", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_arabic(_request, _exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "detail": "البيانات المُدخلة غير صالحة. تحقق من الحقول والأرقام المطلوبة.",
        },
    )


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
BASE_APP_DIR = Path(__file__).resolve().parent.parent
VEHICLE_UPLOAD_DIR = BASE_APP_DIR / "uploads" / "vehicle_photos"
MAX_VEHICLE_PHOTO_BYTES = 5 * 1024 * 1024
ALLOWED_VEHICLE_PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.post("/api/auth/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.username == body.username.strip()))
    if u is None or not verify_password(body.password, u.password_hash):
        raise HTTPException(
            status_code=401,
            detail="اسم المستخدم أو كلمة المرور غير صحيحة.",
        )
    if not u.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقوف.")
    token = create_access_token(username=u.username, role=u.role)
    return LoginResponse(
        access_token=token,
        token_type="bearer",
        role=u.role,
        username=u.username,
    )


@app.get("/api/auth/me", response_model=UserMe)
def auth_me(user: User = Depends(get_current_user)):
    return UserMe(username=user.username, role=user.role)


@app.post("/api/auth/change-password", response_model=OkResponse)
def change_own_password(
    body: ChangeOwnPasswordRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="كلمة المرور الحالية غير صحيحة.")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return OkResponse()


@app.get("/api/admin/users", response_model=list[UserListItem])
def admin_list_users(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    rows = db.scalars(
        select(User).where(User.is_active.is_(True)).order_by(User.username.asc())
    ).all()
    return [UserListItem(username=r.username, role=r.role) for r in rows]


@app.put("/api/admin/users/password", response_model=OkResponse)
def admin_set_user_password(
    body: AdminSetPasswordRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    username = body.username.strip()
    u = db.scalar(select(User).where(User.username == username))
    if u is None:
        raise HTTPException(status_code=404, detail="المستخدم غير موجود.")
    u.password_hash = hash_password(body.new_password)
    db.commit()
    return OkResponse()


@app.put("/api/admin/users/username", response_model=RenameUserResponse)
def admin_rename_user(
    body: AdminRenameUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    cur = body.current_username.strip()
    new = body.new_username.strip()
    if not new:
        raise HTTPException(status_code=400, detail="اسم المستخدم الجديد فارغ.")
    if cur.lower() == new.lower():
        raise HTTPException(status_code=400, detail="اسم المستخدم الجديد مطابق للحالي.")
    taken = db.scalar(
        select(User.id).where(func.lower(User.username) == func.lower(new))
    )
    if taken is not None:
        raise HTTPException(status_code=400, detail="اسم المستخدم الجديد مستخدم مسبقًا.")
    u = db.scalar(select(User).where(User.username == cur))
    if u is None:
        raise HTTPException(status_code=404, detail="المستخدم الحالي غير موجود.")
    u.username = new
    db.commit()
    renamed_self = admin.id == u.id
    return RenameUserResponse(ok=True, renamed_self=renamed_self)


WIPE_CONFIRMATION = "امسح_كل_البيانات"


@app.post("/api/admin/database/wipe", response_model=OkResponse)
def admin_wipe_parking_data(
    body: AdminWipeDataRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """حذف كل جلسات الموقف وإعادة إعدادات السعة/السعر للافتراضي. لا يحذف المستخدمين."""
    if body.confirmation.strip() != WIPE_CONFIRMATION:
        raise HTTPException(
            status_code=400,
            detail=f'اكتب بالضبط: {WIPE_CONFIRMATION}',
        )
    db.execute(delete(ParkingSession))
    s = get_settings_row(db)
    s.total_slots = 20
    s.price_per_hour_cents = 200
    db.commit()
    return OkResponse()


def get_settings_row(db: Session) -> ParkingSettings:
    row = db.get(ParkingSettings, 1)
    if row is None:
        row = ParkingSettings(id=1, total_slots=20, price_per_hour_cents=200)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def occupied_slot_numbers(db: Session) -> set[int]:
    q = select(ParkingSession.slot_number).where(ParkingSession.exited_at.is_(None))
    return set(db.scalars(q).all())


def next_free_slot(db: Session, total: int) -> int | None:
    taken = occupied_slot_numbers(db)
    for n in range(1, total + 1):
        if n not in taken:
            return n
    return None


def _finalize_checkout_session(db: Session, row: ParkingSession) -> CheckOutResponse:
    if row.exited_at is not None:
        raise HTTPException(status_code=400, detail="تم خروج هذه المركبة مسبقًا.")
    s = get_settings_row(db)
    now = utc_now()
    days = billable_days(row.entered_at, now)
    duration_hrs = stay_duration_hours(row.entered_at, now)
    due = amount_due_cents(s.price_per_hour_cents, days)
    row.exited_at = now
    row.hours_billed = float(days)
    row.amount_due_cents = due
    row.paid = True
    db.commit()
    db.refresh(row)
    return CheckOutResponse(
        receipt_code=row.receipt_code,
        license_plate=row.license_plate,
        slot_number=row.slot_number,
        entered_at=row.entered_at,
        exited_at=row.exited_at,
        duration_hours=duration_hrs,
        days_billed=days,
        daily_rate_cents=s.price_per_hour_cents,
        amount_due_cents=due,
    )


def _profile_public(p: VehicleProfile) -> VehicleProfilePublic:
    return VehicleProfilePublic(
        id=p.id,
        license_plate=p.license_plate,
        vehicle_make=p.vehicle_make,
        vehicle_color=p.vehicle_color,
        mechanical_number=p.mechanical_number,
        has_photo=bool(p.photo_path),
    )


def _public_base_url(request: Request) -> str:
    raw = (os.environ.get("PARKING_PUBLIC_BASE_URL") or "").strip()
    if raw:
        return raw.rstrip("/")
    return str(request.base_url).rstrip("/")


def _vehicle_qr_payload(public_token: str) -> str:
    """رمز QR خام (UUID) لقراءته من قارئات الباركود والكاميرا."""
    return public_token.strip()


def _ensure_no_active_session_conflict(
    db: Session, plate_upper: str, vehicle_profile_id: int | None = None
) -> None:
    or_parts = [func.lower(ParkingSession.license_plate) == func.lower(plate_upper)]
    if vehicle_profile_id is not None:
        or_parts.append(ParkingSession.vehicle_profile_id == vehicle_profile_id)
    dup = db.scalar(
        select(ParkingSession.id).where(
            ParkingSession.exited_at.is_(None),
            or_(*or_parts),
        )
    )
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail="هذه اللوحة أو بطاقة البروفايل مسجّلة داخل الموقف حاليًا. أكمِل الخروج أولًا.",
        )


def _pick_vehicle_photo_extension(filename: str, content_type: str | None) -> str:
    fn = (filename or "").lower()
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        if fn.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    ct = (content_type or "").lower()
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    return ".jpg"


@app.get("/api/settings", response_model=SettingsResponse)
def read_settings(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    s = get_settings_row(db)
    occ = len(occupied_slot_numbers(db))
    avail = max(0, s.total_slots - occ)
    return SettingsResponse(
        total_slots=s.total_slots,
        price_per_hour_cents=s.price_per_hour_cents,
        occupied_slots=occ,
        available_slots=avail,
    )


@app.put("/api/settings", response_model=SettingsResponse)
def update_settings(
    body: SettingsUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    s = get_settings_row(db)
    occ = len(occupied_slot_numbers(db))
    if body.total_slots < occ:
        raise HTTPException(
            status_code=400,
            detail=f"لا يمكن تقليل عدد الأماكن عن عدد السيارات المركونة حاليًا ({occ}).",
        )
    s.total_slots = body.total_slots
    s.price_per_hour_cents = body.price_per_hour_cents
    db.commit()
    db.refresh(s)
    avail = max(0, s.total_slots - occ)
    return SettingsResponse(
        total_slots=s.total_slots,
        price_per_hour_cents=s.price_per_hour_cents,
        occupied_slots=occ,
        available_slots=avail,
    )


@app.post("/api/check-in", response_model=CheckInResponse)
def check_in(
    body: CheckInRequest,
    request: Request,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    s = get_settings_row(db)
    if s.total_slots <= 0:
        raise HTTPException(status_code=400, detail="لم يتم تهيئة سعة الموقف.")
    slot = next_free_slot(db, s.total_slots)
    if slot is None:
        raise HTTPException(status_code=400, detail="لا توجد أماكن شاغرة.")

    plate = body.license_plate.strip().upper()
    if not plate or len(plate) > 32:
        raise HTTPException(status_code=400, detail="رقم اللوحة غير صالح.")
    mech = body.mechanical_number.strip()
    if not mech or len(mech) > 64:
        raise HTTPException(status_code=400, detail="رقم الميكانيك مطلوب للتسجيل اليدوي.")
    dup_profile = db.scalar(
        select(VehicleProfile.id).where(
            or_(
                func.lower(VehicleProfile.license_plate) == func.lower(plate),
                func.lower(VehicleProfile.mechanical_number) == func.lower(mech),
            )
        )
    )
    if dup_profile is not None:
        raise HTTPException(
            status_code=409,
            detail="اللوحة أو رقم الميكانيك مسجّل مسبقًا في بروفايل مركبة. استخدم مسح بطاقة الـ QR أو أدخل مركبة غير مسجّلة.",
        )
    _ensure_no_active_session_conflict(db, plate, None)

    token = str(uuid.uuid4())
    now = utc_now()
    prof = VehicleProfile(
        public_token=token,
        license_plate=plate,
        vehicle_make=(body.vehicle_make or "").strip() or None,
        vehicle_color=(body.vehicle_color or "").strip() or None,
        mechanical_number=mech,
        photo_path=None,
        created_at=now,
    )
    db.add(prof)
    db.flush()
    _ensure_no_active_session_conflict(db, plate, prof.id)

    try:
        receipt = allocate_unique_receipt_code(db)
    except RuntimeError:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="تعذّر إنشاء رمز إيصال. أعد المحاولة.",
        ) from None
    notes_parts = []
    if body.notes and body.notes.strip():
        notes_parts.append(body.notes.strip())
    notes_parts.append(f"بروفايل #{prof.id} (تسجيل يدوي من الموظف)")
    session_row = ParkingSession(
        receipt_code=receipt,
        license_plate=plate,
        vehicle_make=prof.vehicle_make,
        vehicle_color=prof.vehicle_color,
        notes="\n".join(notes_parts),
        slot_number=slot,
        entered_at=now,
        exited_at=None,
        paid=False,
        vehicle_profile_id=prof.id,
    )
    db.add(session_row)
    db.commit()
    db.refresh(session_row)
    db.refresh(prof)
    total_profiles = db.scalar(select(func.count()).select_from(VehicleProfile))
    if total_profiles is None:
        total_profiles = 1
    qr_payload = _vehicle_qr_payload(token)
    return CheckInResponse(
        receipt_code=receipt,
        slot_number=slot,
        entered_at=session_row.entered_at,
        license_plate=session_row.license_plate,
        profile_id=prof.id,
        public_token=token,
        registration_order=int(total_profiles),
        qr_payload=qr_payload,
        vehicle_make=prof.vehicle_make,
        vehicle_color=prof.vehicle_color,
        mechanical_number=prof.mechanical_number,
    )


@app.post("/api/check-out", response_model=CheckOutResponse)
def check_out(
    body: CheckOutRequest,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    code = body.receipt_code.strip()
    row = db.scalar(
        select(ParkingSession).where(
            func.lower(ParkingSession.receipt_code) == func.lower(code)
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="لم يُعثر على الإيصال.")
    return _finalize_checkout_session(db, row)


@app.get("/api/sessions/active", response_model=list[SessionHistoryItem])
def list_active(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    q = (
        select(ParkingSession)
        .where(ParkingSession.exited_at.is_(None))
        .order_by(ParkingSession.entered_at.desc())
    )
    rows = db.scalars(q).all()
    return [
        SessionHistoryItem(
            receipt_code=r.receipt_code,
            license_plate=r.license_plate,
            slot_number=r.slot_number,
            entered_at=r.entered_at,
            exited_at=r.exited_at,
            hours_billed=r.hours_billed,
            amount_due_cents=r.amount_due_cents,
            paid=r.paid,
        )
        for r in rows
    ]


@app.get("/api/sessions/history", response_model=list[SessionHistoryItem])
def list_history(
    limit: int = 50,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    limit = min(max(limit, 1), 500)
    q = (
        select(ParkingSession)
        .where(ParkingSession.exited_at.is_not(None))
        .order_by(ParkingSession.exited_at.desc())
        .limit(limit)
    )
    rows = db.scalars(q).all()
    return [
        SessionHistoryItem(
            receipt_code=r.receipt_code,
            license_plate=r.license_plate,
            slot_number=r.slot_number,
            entered_at=r.entered_at,
            exited_at=r.exited_at,
            hours_billed=r.hours_billed,
            amount_due_cents=r.amount_due_cents,
            paid=r.paid,
        )
        for r in rows
    ]


@app.get("/api/stats/month", response_model=MonthStatsResponse)
def month_checkout_stats(
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """دخول حسب تاريخ دمشق لوقت الدخول؛ خروج وإيراد حسب تاريخ دمشق لوقت الخروج."""
    today = damascus_today_date()
    y = year if year is not None else today.year
    m = month if month is not None else today.month
    return build_month_stats_response(db, y, m)


@app.get("/api/stats/month/export")
def export_month_stats_xlsx(
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    today = damascus_today_date()
    y = year if year is not None else today.year
    m = month if month is not None else today.month
    stats = build_month_stats_response(db, y, m)

    wb = Workbook()
    ws = wb.active
    ws.title = f"{y}-{m:02d}"

    ws.append(["اليوم", "دخول", "خروج", "إيراد جديد", "إيراد قديم"])
    for d in stats.days:
        ws.append(
            [
                d.day,
                d.entry_count,
                d.checkout_count,
                d.revenue_syp_new,
                int(round(d.revenue_syp_new * 100)),
            ]
        )
    ws.append([])
    ws.append(
        [
            "الإجمالي",
            stats.total_entries,
            stats.total_checkouts,
            stats.total_revenue_syp_new,
            int(round(stats.total_revenue_syp_new * 100)),
        ]
    )

    bio = BytesIO()
    wb.save(bio)
    bio.seek(0)
    fname = f"parking-stats-{y}-{m:02d}.xlsx"
    return Response(
        content=bio.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"; filename*=UTF-8\'\'{fname}',
        },
    )


@app.get("/api/sessions/log", response_model=list[SessionHistoryItem])
def list_sessions_log(
    limit: int = 200,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """كل التذاكر: الأحدث دخولًا أولًا (داخل الموقف أو خرجت)."""
    limit = min(max(limit, 1), 500)
    q = select(ParkingSession).order_by(ParkingSession.entered_at.desc()).limit(limit)
    rows = db.scalars(q).all()
    return [
        SessionHistoryItem(
            receipt_code=r.receipt_code,
            license_plate=r.license_plate,
            slot_number=r.slot_number,
            entered_at=r.entered_at,
            exited_at=r.exited_at,
            hours_billed=r.hours_billed,
            amount_due_cents=r.amount_due_cents,
            paid=r.paid,
        )
        for r in rows
    ]


@app.get("/CarRegistration")
def serve_car_registration_page():
    path = STATIC_DIR / "CarRegistration.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="صفحة CarRegistration غير موجودة.")
    return FileResponse(path)


@app.get("/driver")
def redirect_legacy_driver_page():
    return RedirectResponse(url="/CarRegistration", status_code=302)


@app.post("/api/public/vehicle-profile", response_model=VehiclePublicRegisterResponse)
async def public_register_vehicle_profile(
    request: Request,
    license_plate: str = Form(...),
    vehicle_make: str | None = Form(None),
    vehicle_color: str | None = Form(None),
    mechanical_number: str = Form(...),
    photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    plate = license_plate.strip().upper()
    if not plate or len(plate) > 32:
        raise HTTPException(status_code=400, detail="رقم اللوحة غير صالح.")
    mech = mechanical_number.strip()
    if not mech or len(mech) > 64:
        raise HTTPException(status_code=400, detail="رقم الميكانيك مطلوب.")
    dup_plate = db.scalar(
        select(VehicleProfile.id).where(
            func.lower(VehicleProfile.license_plate) == func.lower(plate)
        )
    )
    if dup_plate is not None:
        raise HTTPException(
            status_code=409,
            detail="هذه اللوحة مسجّلة مسبقًا. إن كانت سيارتك فقد تم إنشاء البروفايل سابقًا.",
        )
    dup_mech = db.scalar(
        select(VehicleProfile.id).where(
            func.lower(VehicleProfile.mechanical_number) == func.lower(mech)
        )
    )
    if dup_mech is not None:
        raise HTTPException(
            status_code=409,
            detail="رقم الميكانيك مسجّل مسبقًا لمركبة أخرى في النظام.",
        )
    photo_bytes: bytes | None = None
    photo_ext: str | None = None
    if photo is not None and photo.filename:
        photo_bytes = await photo.read()
        if photo_bytes:
            if len(photo_bytes) < 32:
                raise HTTPException(status_code=400, detail="ملف الصورة غير صالح.")
            if len(photo_bytes) > MAX_VEHICLE_PHOTO_BYTES:
                raise HTTPException(status_code=413, detail="حجم الصورة كبير جدًا (الحد 5 ميجابايت).")
            photo_ext = _pick_vehicle_photo_extension(photo.filename or "", photo.content_type)
            if photo_ext == ".jpeg":
                photo_ext = ".jpg"
            if photo_ext not in ALLOWED_VEHICLE_PHOTO_EXT:
                photo_ext = ".jpg"
    token = str(uuid.uuid4())
    now = utc_now()
    prof = VehicleProfile(
        public_token=token,
        license_plate=plate,
        vehicle_make=(vehicle_make or "").strip() or None,
        vehicle_color=(vehicle_color or "").strip() or None,
        mechanical_number=mech,
        photo_path=None,
        created_at=now,
    )
    db.add(prof)
    db.flush()
    if photo_bytes and photo_ext:
        fn = f"{prof.id}_{token[:8]}{photo_ext}"
        rel = f"uploads/vehicle_photos/{fn}".replace("\\", "/")
        abs_p = BASE_APP_DIR / rel
        abs_p.parent.mkdir(parents=True, exist_ok=True)
        with open(abs_p, "wb") as f:
            f.write(photo_bytes)
        prof.photo_path = rel
    db.commit()
    db.refresh(prof)
    total_profiles = db.scalar(select(func.count()).select_from(VehicleProfile))
    if total_profiles is None:
        total_profiles = 1
    qr_payload = _vehicle_qr_payload(token)
    return VehiclePublicRegisterResponse(
        profile_id=prof.id,
        public_token=token,
        qr_payload=qr_payload,
        registration_order=int(total_profiles),
        license_plate=plate,
        vehicle_make=prof.vehicle_make,
        vehicle_color=prof.vehicle_color,
        mechanical_number=mech,
    )


@app.get("/api/vehicle-profiles/{profile_id:int}/photo")
def vehicle_profile_photo(
    profile_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    p = db.get(VehicleProfile, profile_id)
    if p is None or not p.photo_path:
        raise HTTPException(status_code=404, detail="الصورة غير موجودة.")
    full = BASE_APP_DIR / p.photo_path
    if not full.is_file():
        raise HTTPException(status_code=404, detail="الصورة غير موجودة على الخادم.")
    mime, _ = mimetypes.guess_type(str(full))
    return FileResponse(full, media_type=mime or "application/octet-stream")


@app.get("/api/vehicle-profiles", response_model=list[VehicleProfileListItem])
def list_vehicle_profiles(
    request: Request,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """كل بروفايلات المركبات (للموظف والمدير)."""
    rows = db.scalars(
        select(VehicleProfile)
        .order_by(VehicleProfile.created_at.desc())
        .limit(limit)
    ).all()
    ordered_ids = db.scalars(
        select(VehicleProfile.id).order_by(VehicleProfile.id.asc())
    ).all()
    reg_rank = {pid: idx + 1 for idx, pid in enumerate(ordered_ids)}
    return [
        VehicleProfileListItem(
            id=r.id,
            public_token=r.public_token,
            license_plate=r.license_plate,
            vehicle_make=r.vehicle_make,
            vehicle_color=r.vehicle_color,
            mechanical_number=r.mechanical_number,
            has_photo=bool(r.photo_path),
            created_at=r.created_at,
            qr_payload=_vehicle_qr_payload(r.public_token),
            registration_order=reg_rank.get(r.id, r.id),
        )
        for r in rows
    ]


@app.get("/api/employee/vehicle-scan/{token}", response_model=VehicleScanResponse)
def employee_vehicle_scan(
    token: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    t = token.strip()
    if len(t) < 8:
        raise HTTPException(status_code=400, detail="رمز غير صالح.")
    prof = db.scalar(select(VehicleProfile).where(VehicleProfile.public_token == t))
    if prof is None:
        raise HTTPException(status_code=404, detail="لم يُعثر على بروفايل بهذا الرمز.")
    active = db.scalar(
        select(ParkingSession).where(
            ParkingSession.vehicle_profile_id == prof.id,
            ParkingSession.exited_at.is_(None),
        )
    )
    inside = active is not None
    brief = None
    if active is not None:
        brief = ActiveSessionBrief(
            receipt_code=active.receipt_code,
            entered_at=active.entered_at,
            slot_number=active.slot_number,
            license_plate=active.license_plate,
        )
    return VehicleScanResponse(
        inside=inside,
        profile=_profile_public(prof),
        active_session=brief,
    )


@app.post("/api/employee/vehicle-check-in", response_model=CheckInResponse)
def employee_vehicle_check_in(
    body: VehicleTokenBody,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    t = body.public_token.strip()
    prof = db.scalar(select(VehicleProfile).where(VehicleProfile.public_token == t))
    if prof is None:
        raise HTTPException(status_code=404, detail="بروفايل المركبة غير معروف.")
    s = get_settings_row(db)
    if s.total_slots <= 0:
        raise HTTPException(status_code=400, detail="لم يتم تهيئة سعة الموقف.")
    slot = next_free_slot(db, s.total_slots)
    if slot is None:
        raise HTTPException(status_code=400, detail="لا توجد أماكن شاغرة.")
    _ensure_no_active_session_conflict(db, prof.license_plate, prof.id)
    try:
        receipt = allocate_unique_receipt_code(db)
    except RuntimeError:
        raise HTTPException(
            status_code=500,
            detail="تعذّر إنشاء رمز إيصال. أعد المحاولة.",
        ) from None
    now = utc_now()
    session_row = ParkingSession(
        receipt_code=receipt,
        license_plate=prof.license_plate,
        vehicle_make=prof.vehicle_make,
        vehicle_color=prof.vehicle_color,
        notes=f"بروفايل #{prof.id}",
        slot_number=slot,
        entered_at=now,
        exited_at=None,
        paid=False,
        vehicle_profile_id=prof.id,
    )
    db.add(session_row)
    db.commit()
    db.refresh(session_row)
    return CheckInResponse(
        receipt_code=receipt,
        slot_number=slot,
        entered_at=session_row.entered_at,
        license_plate=session_row.license_plate,
    )


@app.post("/api/employee/vehicle-check-out", response_model=CheckOutResponse)
def employee_vehicle_check_out(
    body: VehicleTokenBody,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    t = body.public_token.strip()
    prof = db.scalar(select(VehicleProfile).where(VehicleProfile.public_token == t))
    if prof is None:
        raise HTTPException(status_code=404, detail="بروفايل المركبة غير معروف.")
    row = db.scalar(
        select(ParkingSession).where(
            ParkingSession.vehicle_profile_id == prof.id,
            ParkingSession.exited_at.is_(None),
        )
    )
    if row is None:
        raise HTTPException(
            status_code=400,
            detail="لا توجد جلسة دخول نشطة لهذه المركبة داخل الموقف.",
        )
    return _finalize_checkout_session(db, row)


@app.delete("/api/admin/vehicle-profiles/{profile_id:int}", response_model=OkResponse)
def admin_delete_vehicle_profile(
    profile_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    prof = db.get(VehicleProfile, profile_id)
    if prof is None:
        raise HTTPException(status_code=404, detail="بروفايل المركبة غير موجود.")
    active = db.scalar(
        select(ParkingSession.id).where(
            ParkingSession.vehicle_profile_id == prof.id,
            ParkingSession.exited_at.is_(None),
        )
    )
    if active is not None:
        raise HTTPException(
            status_code=400,
            detail="لا يمكن حذف البروفايل: المركبة مسجّلة داخل الموقف حاليًا. أكمِل الخروج أولًا.",
        )
    db.execute(
        update(ParkingSession)
        .where(ParkingSession.vehicle_profile_id == prof.id)
        .values(vehicle_profile_id=None)
    )
    if prof.photo_path:
        full = BASE_APP_DIR / prof.photo_path
        try:
            if full.is_file():
                full.unlink()
        except OSError:
            pass
    db.delete(prof)
    db.commit()
    return OkResponse()


@app.get("/favicon.ico", include_in_schema=False)
@app.get("/favicon.svg", include_in_schema=False)
def favicon():
    svg = STATIC_DIR / "favicon.svg"
    if svg.is_file():
        return FileResponse(svg, media_type="image/svg+xml")
    path = STATIC_DIR / "logo.png"
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png")


@app.get("/")
def serve_app():
    index = Path(__file__).resolve().parent.parent / "static" / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="واجهة المستخدم غير موجودة.")
