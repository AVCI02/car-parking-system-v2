from datetime import datetime

from pydantic import BaseModel, Field


class SettingsUpdate(BaseModel):
    total_slots: int = Field(ge=1, le=10_000)
    # اسم الحقل تاريخي: القيمة = ليرة سورية جديدة كاملة لكل يوم (مثلاً 200)
    price_per_hour_cents: int = Field(ge=0, le=10_000_000, description="ليرة سورية جديدة لكل يوم مُحتسب")


class SettingsResponse(BaseModel):
    total_slots: int
    price_per_hour_cents: int
    occupied_slots: int
    available_slots: int


class CheckInRequest(BaseModel):
    license_plate: str = Field(min_length=1, max_length=32)
    vehicle_make: str | None = Field(None, max_length=64)
    vehicle_type: str | None = Field(None, max_length=64)
    vehicle_color: str | None = Field(None, max_length=32)
    driver_name: str | None = Field(None, max_length=128)
    owner_name: str | None = Field(None, max_length=128)
    partnership_company: str | None = Field(None, max_length=128)
    mechanical_number: str | None = Field(None, max_length=64)
    notes: str | None = None


class CheckInResponse(BaseModel):
    receipt_code: str
    slot_number: int
    entered_at: datetime
    license_plate: str
    profile_id: int | None = None
    public_token: str | None = None
    registration_order: int | None = None
    qr_payload: str | None = None
    vehicle_make: str | None = None
    vehicle_type: str | None = None
    vehicle_color: str | None = None
    driver_name: str | None = None
    owner_name: str | None = None
    partnership_company: str | None = None
    mechanical_number: str | None = None


class CheckOutRequest(BaseModel):
    # يدعم الرموز القصيرة الجديدة والإيصالات القديمة (UUID)
    receipt_code: str = Field(min_length=4, max_length=40)


class CheckOutResponse(BaseModel):
    receipt_code: str
    license_plate: str
    slot_number: int
    entered_at: datetime
    exited_at: datetime
    duration_hours: float
    days_billed: int
    daily_rate_cents: int
    amount_due_cents: int


class SessionHistoryItem(BaseModel):
    receipt_code: str
    license_plate: str
    slot_number: int
    entered_at: datetime
    exited_at: datetime | None
    hours_billed: float | None
    amount_due_cents: int | None
    paid: bool


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str


class UserMe(BaseModel):
    username: str
    role: str


class MonthStatDayItem(BaseModel):
    """يوم من أيام الشهر (تقويم دمشق): دخول حسب وقت الدخول، خروج وإيراد حسب وقت الخروج."""

    day: int
    entry_count: int
    checkout_count: int
    revenue_syp_new: int


class MonthStatsResponse(BaseModel):
    year: int
    month: int
    days: list[MonthStatDayItem]
    total_entries: int
    total_checkouts: int
    total_revenue_syp_new: int


class ChangeOwnPasswordRequest(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class AdminSetPasswordRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    new_password: str = Field(min_length=6, max_length=128)


class UserListItem(BaseModel):
    username: str
    role: str


class OkResponse(BaseModel):
    ok: bool = True


class AdminRenameUserRequest(BaseModel):
    current_username: str = Field(min_length=1, max_length=64)
    new_username: str = Field(min_length=1, max_length=64)


class RenameUserResponse(BaseModel):
    ok: bool = True
    renamed_self: bool = False


class AdminWipeDataRequest(BaseModel):
    confirmation: str = Field(min_length=1, max_length=64)


class VehicleProfilePublic(BaseModel):
    id: int
    license_plate: str
    vehicle_make: str | None
    vehicle_type: str | None
    vehicle_color: str | None
    driver_name: str | None
    owner_name: str | None
    partnership_company: str | None
    mechanical_number: str | None = None
    has_photo: bool = False


class ActiveSessionBrief(BaseModel):
    receipt_code: str
    entered_at: datetime
    slot_number: int
    license_plate: str


class VehicleScanResponse(BaseModel):
    inside: bool
    profile: VehicleProfilePublic
    active_session: ActiveSessionBrief | None = None


class VehiclePublicRegisterResponse(BaseModel):
    profile_id: int
    public_token: str
    qr_payload: str
    # ترتيب هذه المركبة بين كل البروفايلات المسجّلة في النظام (1 = الأولى).
    registration_order: int
    license_plate: str | None = None
    vehicle_make: str | None = None
    vehicle_type: str | None = None
    vehicle_color: str | None = None
    driver_name: str | None = None
    owner_name: str | None = None
    partnership_company: str | None = None
    mechanical_number: str | None = None


class VehicleProfileListItem(BaseModel):
    """عنصر قائمة بروفايلات المركبات (للموظف والمدير)."""

    id: int
    public_token: str
    license_plate: str
    vehicle_make: str | None
    vehicle_type: str | None
    vehicle_color: str | None
    driver_name: str | None
    owner_name: str | None
    partnership_company: str | None
    mechanical_number: str | None = None
    has_photo: bool = False
    created_at: datetime
    qr_payload: str
    # تسلسل التسجيل بين كل البروفايلات (1 = الأقدم حسب المعرّف).
    registration_order: int


class VehicleProfileFilterOption(BaseModel):
    value: str
    count: int


class VehicleProfileFiltersMeta(BaseModel):
    total: int
    vehicle_types: list[VehicleProfileFilterOption]
    partnership_companies: list[VehicleProfileFilterOption]


class VehicleProfileListResponse(BaseModel):
    items: list[VehicleProfileListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class VehicleTokenBody(BaseModel):
    public_token: str = Field(min_length=8, max_length=48)
