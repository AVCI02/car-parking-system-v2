const $ = (id) => document.getElementById(id);

const DAMASCUS_TZ = "Asia/Damascus";
const TOKEN_KEY = "parking_access_token";

/** آخر تحميل لسجل التذاكر (للمعاينة السريعة) */
let ticketLogCache = [];
/** صفحة بروفايلات المركبات الحالية (من الخادم) */
let vehicleProfileListCache = [];
/** نص البحث في صفحة إدارة المركبات */
let profilesSearchQuery = "";
/** فلاتر قائمة المركبات */
let profilesFilters = { vehicle_type: "", partnership_company: "", has_photo: "" };
/** ترقيم صفحات بروفايلات المركبات */
let profilesPage = 1;
const PROFILES_PAGE_SIZE = 50;
let profilesListMeta = { total: 0, page: 1, total_pages: 1 };
let profilesFilterOptions = null;
let profilesListLoading = false;
/** معرّف البروفايل المعروض في نافذة البطاقة (للتنزيل) */
let vehicleCardProfileId = null;
/** بروفايل مرتبط بإيصال الدخول المعروض حاليًا (لزر بطاقة المركبة) */
let receiptModalProfileRef = null;
/** admin | employee | null */
let currentRole = null;
/** اسم المستخدم الحالي */
let currentUsername = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  currentRole = null;
  currentUsername = null;
}

function showLoginView() {
  $("view-login").classList.remove("hidden");
  $("app-shell").classList.add("hidden");
}

function showAppShell() {
  $("view-login").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
}

function applyRoleUI(me) {
  currentRole = me.role;
  currentUsername = me.username;
  const isAdmin = me.role === "admin";
  $("nav-settings").classList.toggle("hidden", !isAdmin);
  $("nav-stats").classList.toggle("hidden", !isAdmin);
  const roleLabel = isAdmin ? "مدير" : "موظف";
  $("user-banner").textContent = `${me.username} · ${roleLabel}`;
}

/** يفسر التواريخ القادمة من الخادم كـ UTC (naive ISO) ثم يعرضها بتوقيت دمشق. */
function parseServerUtc(iso) {
  if (iso == null || iso === "") return new Date(NaN);
  const s = String(iso).trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s}Z`);
}

function formatDamascusDateTime(iso) {
  const d = parseServerUtc(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SY", {
    numberingSystem: "latn",
    timeZone: DAMASCUS_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sypOldEquivalent(amountNew) {
  const n = Number(amountNew);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function formatSypDualLine(amountNew) {
  const oldEq = sypOldEquivalent(amountNew);
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  return `${nf.format(amountNew)} ل.س جديدة — ${nf.format(oldEq)} ل.س قديمة`;
}

function formatDailyRate(sypNewPerDay) {
  return `${formatSypDualLine(sypNewPerDay)} لليوم`;
}

function formatStayDuration(hours) {
  if (hours == null || !Number.isFinite(Number(hours))) return "—";
  const totalMinutes = Math.max(0, Math.round(Number(hours) * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h} ساعة و ${m} دقيقة`;
  if (h > 0) return h === 1 ? "ساعة واحدة" : `${h} ساعات`;
  if (m > 0) return m === 1 ? "دقيقة واحدة" : `${m} دقائق`;
  return "أقل من دقيقة";
}

function formatSypAmountDue(amountNew) {
  return formatSypDualLine(amountNew);
}

function formatBillingHours(h) {
  if (h == null || !Number.isFinite(Number(h))) return "—";
  const n = Number(h);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function api(path, options = {}) {
  const skipAuth = path === "/api/auth/login";
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (!skipAuth) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    headers,
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401 && !skipAuth) {
    clearAuth();
    showLoginView();
    const err = new Error("انتهت الجلسة. سجّل الدخول مجددًا.");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg;
    if (Array.isArray(data?.detail)) {
      msg = data.detail.map((d) => d.msg || JSON.stringify(d)).join("؛ ");
    } else if (data?.detail != null) {
      msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } else if (typeof data === "string") {
      msg = data;
    } else {
      msg = res.statusText;
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshStats() {
  const s = await api("/api/settings");
  $("cap").textContent = s.total_slots;
  $("avail").textContent = s.available_slots;
  $("rate").textContent = formatDailyRate(s.price_per_hour_cents);
  $("total-slots").value = s.total_slots;
  $("price-hour").value = String(s.price_per_hour_cents);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function printIssuerFooterHtml() {
  if (!currentRole) return "";
  const label = currentRole === "admin" ? "مدير" : "موظف";
  return `<p class="print-issuer-footer">${label}</p>`;
}

function renderQrIntoHost(hostEl, text, pixelSize = 200) {
  if (!hostEl) return;
  hostEl.innerHTML = "";
  if (!text || typeof QRCode === "undefined") {
    hostEl.innerHTML = '<p class="muted">تعذّر إنشاء رمز QR.</p>';
    return;
  }
  try {
    const level =
      QRCode.CorrectLevel != null ? QRCode.CorrectLevel.H : undefined;
    new QRCode(hostEl, {
      text,
      width: pixelSize,
      height: pixelSize,
      colorDark: "#000000",
      colorLight: "#ffffff",
      ...(level !== undefined ? { correctLevel: level } : {}),
    });
  } catch (e) {
    console.error(e);
    hostEl.innerHTML = '<p class="muted">تعذّر إنشاء رمز QR.</p>';
  }
}

function buildCheckoutResultHtml(data) {
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  const newAmt = data.amount_due_cents;
  const oldAmt = sypOldEquivalent(newAmt);
  const days = data.days_billed ?? 1;
  const rateLine = formatSypDualLine(data.daily_rate_cents);
  const daysLabel = days === 1 ? "يوم واحد" : `${days} أيام`;
  const entered = formatDamascusDateTime(data.entered_at);
  const exited = formatDamascusDateTime(data.exited_at);
  return `
    <div id="checkout-invoice-slip" class="checkout-invoice-slip thermal-slip" role="document" aria-label="فاتورة الموقف">
      <header class="invoice-header">
        <h3 class="invoice-title">فاتورة الخروج</h3>
        <p class="invoice-code" dir="ltr">${escapeHtml(data.receipt_code)}</p>
      </header>
      <dl class="invoice-meta">
        <div><dt>وقت الدخول</dt><dd>${escapeHtml(entered)}</dd></div>
        <div><dt>وقت الخروج</dt><dd>${escapeHtml(exited)}</dd></div>
        <div><dt>اللوحة</dt><dd>${escapeHtml(data.license_plate)}</dd></div>
        <div><dt>المكان</dt><dd>${escapeHtml(String(data.slot_number))}</dd></div>
        <div><dt>أيام محسوبة</dt><dd>${escapeHtml(daysLabel)}</dd></div>
        <div><dt>السعر / يوم</dt><dd>${escapeHtml(rateLine)}</dd></div>
      </dl>
      <div class="invoice-total-block">
        <p class="invoice-total-label">الإجمالي المستحق</p>
        <p class="invoice-total-new">${nf.format(newAmt)} <span>ل.س جديدة</span></p>
        <p class="invoice-total-old">${nf.format(oldAmt)} <span>ل.س قديمة</span></p>
      </div>
      <p class="invoice-farewell">رافقتكم السلامة</p>
      ${printIssuerFooterHtml()}
    </div>`;
}

function renderReceiptQr(receiptCode) {
  const qrEl = $("receipt-qr-host");
  const plainEl = $("receipt-code-plain");
  if (plainEl) plainEl.textContent = receiptCode;
  renderQrIntoHost(qrEl, receiptCode, 168);
}

/**
 * @param {object} p
 * @param {string} p.receipt_code
 * @param {string} p.license_plate
 * @param {number} p.slot_number
 * @param {string} p.entered_at ISO
 * @param {string|null} [p.exited_at]
 * @param {number|null} [p.amount_due_cents]
 * @param {number|null} [p.hours_billed]
 */
function buildReceiptSlipHtml(p) {
  const entered = formatDamascusDateTime(p.entered_at);
  let extra = "";
  if (p.exited_at) {
    const ex = formatDamascusDateTime(p.exited_at);
    let pay = "";
    if (p.amount_due_cents != null) {
      pay = `<dt>المستحق</dt><dd>${escapeHtml(formatSypAmountDue(p.amount_due_cents))}</dd>`;
    }
    let hrs = "";
    if (p.hours_billed != null) {
      const d = Number(p.hours_billed);
      const daysTxt = d === 1 ? "يوم واحد" : `${formatBillingHours(d)} أيام`;
      hrs = `<dt>أيام محسوبة</dt><dd>${escapeHtml(daysTxt)}</dd>`;
    }
    extra = `
      <div class="receipt-exit-block">
        <p class="receipt-exit-title">خرجت من الموقف</p>
        <dl class="receipt-meta receipt-meta-exit">
          <dt>وقت الخروج</dt><dd>${escapeHtml(ex)}</dd>
          ${hrs}
          ${pay}
        </dl>
      </div>`;
  }
  return `
    <div id="receipt-slip" class="receipt-slip thermal-slip">
      <div class="receipt-slip-inner">
        <h3>إيصال موقف</h3>
        <p class="hint-scan">امسح الرمز عند الخروج لتسريع إجراءات الدفع.</p>
        <div class="codes-row codes-row-qr-only">
          <div class="qr-host" id="receipt-qr-host" aria-label="رمز QR للإيصال"></div>
          <div class="receipt-code-block">
            <span class="receipt-code-label">رمز الإيصال</span>
            <div class="receipt-code-plain" id="receipt-code-plain"></div>
          </div>
        </div>
        <dl class="receipt-meta">
          <dt>المكان</dt><dd>${escapeHtml(String(p.slot_number))}</dd>
          <dt>اللوحة</dt><dd>${escapeHtml(p.license_plate)}</dd>
          <dt>وقت الدخول</dt><dd>${escapeHtml(entered)}</dd>
        </dl>
        ${extra}
        ${printIssuerFooterHtml()}
      </div>
    </div>`;
}

let html5QrScanner = null;
const QR_CAMERA_STORAGE_KEY = "parking.qrCameraId";
let vehicleFlowPrimaryHandler = null;
let profilePhotoBlobUrl = null;

function vehicleFlowModalIsHidden() {
  const m = $("vehicle-flow-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function clearProfilePhotoBlob() {
  if (profilePhotoBlobUrl) {
    URL.revokeObjectURL(profilePhotoBlobUrl);
    profilePhotoBlobUrl = null;
  }
}

function closeVehicleFlowModal() {
  clearProfilePhotoBlob();
  vehicleFlowPrimaryHandler = null;
  const modal = $("vehicle-flow-modal");
  delete modal.dataset.publicToken;
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("vehicle-flow-modal-body").innerHTML = "";
  $("vehicle-flow-primary").classList.add("hidden");
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openVehicleFlowModal({ title, bodyHtml, primaryLabel, showPrimary, onPrimary }) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  clearProfilePhotoBlob();
  vehicleFlowPrimaryHandler = onPrimary || null;
  $("vehicle-flow-modal-title").textContent = title;
  $("vehicle-flow-modal-body").innerHTML = bodyHtml;
  const btn = $("vehicle-flow-primary");
  btn.textContent = primaryLabel || "متابعة";
  btn.classList.toggle("hidden", !showPrimary);
  const modal = $("vehicle-flow-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  if (showPrimary) btn.focus();
  else $("vehicle-flow-cancel").focus();
}

function extractScanToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const hashMatch = s.match(/[#&?]scan=([^&\s#]+)/i);
  if (hashMatch) {
    try {
      return decodeURIComponent(hashMatch[1]);
    } catch {
      return hashMatch[1];
    }
  }
  const uuidMatch = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuidMatch) return uuidMatch[0];
  return s;
}

function captureVehicleScanFromHash() {
  const h = location.hash || "";
  if (!h.startsWith("#scan=")) return;
  const token = extractScanToken(h);
  history.replaceState(null, "", location.pathname + location.search);
  if (token) sessionStorage.setItem("pendingVehicleScan", token);
}

function consumePendingVehicleScan() {
  const token = sessionStorage.getItem("pendingVehicleScan");
  if (!token) return;
  sessionStorage.removeItem("pendingVehicleScan");
  const manual = $("vehicle-token-manual");
  if (manual) manual.value = token;
  setView("desk");
  setTimeout(() => {
    processVehicleScan(token).catch((e) => alert(e.message));
  }, 350);
}

async function fetchProfilePhotoHtml(profileId, hasPhoto) {
  if (!hasPhoto) return "";
  const t = getToken();
  if (!t) return "";
  const res = await fetch(`/api/vehicle-profiles/${profileId}/photo`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) return '<p class="muted small-print">تعذّر تحميل الصورة.</p>';
  const blob = await res.blob();
  clearProfilePhotoBlob();
  profilePhotoBlobUrl = URL.createObjectURL(blob);
  return `<div class="profile-photo-wrap"><img class="profile-photo-preview" src="${profilePhotoBlobUrl}" alt="" /></div>`;
}

function dlValue(v) {
  return v && String(v).trim() ? escapeHtml(String(v).trim()) : "—";
}

function normalizeVehicleProfileRow(p) {
  if (!p) return null;
  const id = p.id ?? p.profile_id;
  if (id == null) return null;
  return {
    id,
    public_token: p.public_token ?? p.publicToken ?? "",
    license_plate: p.license_plate ?? p.licensePlate ?? "",
    vehicle_make: p.vehicle_make ?? p.vehicleMake ?? null,
    vehicle_type: p.vehicle_type ?? p.vehicleType ?? null,
    vehicle_color: p.vehicle_color ?? p.vehicleColor ?? null,
    driver_name: p.driver_name ?? p.driverName ?? null,
    owner_name: p.owner_name ?? p.ownerName ?? null,
    partnership_company: p.partnership_company ?? p.partnershipCompany ?? null,
    mechanical_number: p.mechanical_number ?? p.mechanicalNumber ?? "",
    qr_payload: p.qr_payload ?? p.qrPayload ?? "",
  };
}

function buildVehicleCardHtml(p) {
  const row = normalizeVehicleProfileRow(p);
  if (!row) return "";
  return `
    <div class="vehicle-card-preview-shell">
    <article class="driver-card" aria-label="بطاقة المركبة">
      <div class="driver-card-shine" aria-hidden="true"></div>
      <div class="driver-card-inner">
        <header class="driver-card-head">
          <img src="/static/logo.png" alt="" class="driver-card-logo" width="40" height="40" />
          <h2 class="driver-card-title">بطاقة المركبة</h2>
        </header>
        <div class="driver-card-grid">
          <dl class="driver-card-dl">
            <div><dt>رقم البروفايل</dt><dd>#${escapeHtml(String(row.id))}</dd></div>
            <div><dt>اللوحة</dt><dd class="driver-card-dl-value-wide">${dlValue(row.license_plate)}</dd></div>
            <div><dt>الطراز</dt><dd>${dlValue(row.vehicle_make)}</dd></div>
            <div><dt>النوع</dt><dd>${dlValue(row.vehicle_type)}</dd></div>
            <div><dt>اللون</dt><dd>${dlValue(row.vehicle_color)}</dd></div>
            <div><dt>اسم السائق</dt><dd>${dlValue(row.driver_name)}</dd></div>
            <div><dt>اسم المالك</dt><dd>${dlValue(row.owner_name)}</dd></div>
            <div><dt>الشركة التضامنية</dt><dd>${dlValue(row.partnership_company)}</dd></div>
            <div><dt>رقم الميكانيك</dt><dd class="driver-card-dl-value-wide">${dlValue(row.mechanical_number)}</dd></div>
          </dl>
          <div class="driver-card-qr-panel">
            <p class="driver-card-qr-caption">امسح من تطبيق الموقف</p>
            <div id="vehicle-card-qr-host"></div>
          </div>
        </div>
      </div>
    </article>
    </div>`;
}

function prepareVehicleCardCloneForExport(clonedDoc) {
  const clonedCard = clonedDoc.querySelector(".driver-card");
  if (!clonedCard) return;
  clonedCard.style.fontFamily = '"Segoe UI", Tahoma, "Arabic UI Text", Arial, sans-serif';
  clonedCard.style.direction = "rtl";
  clonedCard.style.width = "680px";
  clonedCard.style.maxWidth = "680px";
  clonedCard.querySelectorAll(
    ".driver-card-dl dt, .driver-card-dl dd, .driver-card-title, .driver-card-seq, .driver-card-qr-caption"
  ).forEach((el) => {
    el.style.letterSpacing = "normal";
    el.style.textTransform = "none";
    el.style.fontFamily = '"Segoe UI", Tahoma, "Arabic UI Text", Arial, sans-serif';
  });
}

function vehicleQrPayload(profileRow) {
  if (!profileRow) return "";
  const token = String(profileRow.public_token || "").trim();
  if (token) return token;
  const legacy = String(profileRow.qr_payload || "").trim();
  return extractScanToken(legacy) || legacy;
}

function renderVehicleCardQr(qrPayload) {
  renderQrIntoHost($("vehicle-card-qr-host"), qrPayload, 200);
}

function vehicleCardModalIsHidden() {
  const m = $("vehicle-card-modal");
  return !m || m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function closeVehicleCardModal() {
  const modal = $("vehicle-card-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("vehicle-card-modal-host").innerHTML = "";
  vehicleCardProfileId = null;
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openVehicleCardModal(profileRow) {
  const cached =
    profileRow?.id != null
      ? vehicleProfileListCache.find((x) => x.id === profileRow.id)
      : null;
  const merged = normalizeVehicleProfileRow(
    cached ? { ...cached, ...profileRow } : profileRow
  );
  if (!merged) return;
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();

  vehicleCardProfileId = merged.id;
  $("vehicle-card-modal-title").textContent = `بطاقة المركبة #${merged.id}`;
  $("vehicle-card-modal-host").innerHTML = buildVehicleCardHtml(merged);
  renderVehicleCardQr(vehicleQrPayload(merged));

  const modal = $("vehicle-card-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("vehicle-card-dismiss").focus();
}

async function downloadVehicleCardPng() {
  if (typeof html2canvas === "undefined") {
    alert("تعذّر تحميل أداة تصدير البطاقة. تحقق من الاتصال وأعد تحميل الصفحة.");
    return;
  }
  const card = $("vehicle-card-modal-host")?.querySelector(".driver-card");
  if (!card) return;
  const btn = $("vehicle-card-download");
  const prevLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "جارٍ إنشاء الصورة…";
  }
  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    const canvas = await html2canvas(card, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: "#0f141c",
      ignoreElements: (node) =>
        node.classList && node.classList.contains("driver-card-shine"),
      onclone: prepareVehicleCardCloneForExport,
    });
    const pid = vehicleCardProfileId != null ? String(vehicleCardProfileId) : "vehicle";
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `parking-vehicle-card-${pid}.png`;
    a.click();
  } catch (ex) {
    alert(ex.message || "تعذّر تصدير البطاقة. جرّب متصفحًا آخر أو صوّر الشاشة.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

function buildVehicleProfileDl(p) {
  const field = (v) => (v ? escapeHtml(v) : "—");
  return `
    <dl class="checkout-result-dl profile-flow-dl">
      <div><dt>رقم البروفايل</dt><dd>${escapeHtml(String(p.id))}</dd></div>
      <div><dt>اللوحة</dt><dd>${escapeHtml(p.license_plate)}</dd></div>
      <div><dt>الطراز</dt><dd>${field(p.vehicle_make)}</dd></div>
      <div><dt>النوع</dt><dd>${field(p.vehicle_type)}</dd></div>
      <div><dt>اللون</dt><dd>${field(p.vehicle_color)}</dd></div>
      <div><dt>اسم السائق</dt><dd>${field(p.driver_name)}</dd></div>
      <div><dt>اسم المالك</dt><dd>${field(p.owner_name)}</dd></div>
      <div><dt>الشركة التضامنية</dt><dd>${field(p.partnership_company)}</dd></div>
      <div><dt>رقم الميكانيك</dt><dd>${field(p.mechanical_number)}</dd></div>
    </dl>`;
}

async function deleteVehicleProfile(row) {
  if (currentRole !== "admin") {
    alert("إزالة المركبة متاحة للمدير فقط.");
    return;
  }
  const plate = row.license_plate || "هذه المركبة";
  if (
    !confirm(
      `هل تريد إزالة المركبة «${plate}» من النظام؟\nلا يمكن التراجع عن هذا الإجراء.`
    )
  ) {
    return;
  }
  try {
    await api(`/api/admin/vehicle-profiles/${row.id}`, { method: "DELETE" });
    profilesFilterOptions = null;
    await refreshVehicleProfiles();
    alert("تمت إزالة المركبة.");
  } catch (e) {
    alert(e.message);
  }
}

async function showVehicleFlowFromScan(publicToken, data) {
  const modalEl = $("vehicle-flow-modal");
  if (modalEl) modalEl.dataset.publicToken = publicToken;
  const photoHtml = await fetchProfilePhotoHtml(data.profile.id, data.profile.has_photo);
  const body = `${photoHtml}${buildVehicleProfileDl(data.profile)}`;
  if (data.inside && data.active_session) {
    const entered = formatDamascusDateTime(data.active_session.entered_at);
    const extra = `
      <div class="vehicle-flow-session panel-elevated-inner">
        <p class="checkout-micro muted">المركبة داخل الموقف حاليًا.</p>
        <dl class="checkout-result-dl">
          <div><dt>وقت الدخول (دمشق)</dt><dd>${escapeHtml(entered)}</dd></div>
          <div><dt>المكان</dt><dd>${escapeHtml(String(data.active_session.slot_number))}</dd></div>
          <div><dt>رمز الإيصال</dt><dd dir="ltr">${escapeHtml(data.active_session.receipt_code)}</dd></div>
        </dl>
      </div>`;
    openVehicleFlowModal({
      title: "خروج المركبة",
      bodyHtml: body + extra,
      primaryLabel: "إتمام الخروج وحساب الرسوم",
      showPrimary: true,
      onPrimary: async () => {
        try {
          const out = await api("/api/employee/vehicle-check-out", {
            method: "POST",
            body: JSON.stringify({ public_token: publicToken }),
          });
          closeVehicleFlowModal();
          openCheckoutResultModal(out);
          await refreshDeskData();
          if (!$("view-tickets").classList.contains("hidden")) await refreshTickets();
        } catch (e) {
          alert(e.message);
        }
      },
    });
  } else {
    openVehicleFlowModal({
      title: "دخول المركبة",
      bodyHtml: `${body}<p class="checkout-micro muted">المركبة غير مسجّلة داخل الموقف. يمكن إصدار إيصال دخول.</p>`,
      primaryLabel: "إصدار إيصال الدخول",
      showPrimary: true,
      onPrimary: async () => {
        try {
          const cin = await api("/api/employee/vehicle-check-in", {
            method: "POST",
            body: JSON.stringify({ public_token: publicToken }),
          });
          closeVehicleFlowModal();
          openReceiptModal({
            receipt_code: cin.receipt_code,
            license_plate: cin.license_plate,
            slot_number: cin.slot_number,
            entered_at: cin.entered_at,
            exited_at: null,
            amount_due_cents: null,
            hours_billed: null,
            profile_id: cin.profile_id ?? data.profile?.id ?? null,
            public_token: publicToken,
            vehicle_make: data.profile?.vehicle_make ?? cin.vehicle_make ?? null,
            vehicle_type: data.profile?.vehicle_type ?? cin.vehicle_type ?? null,
            vehicle_color: data.profile?.vehicle_color ?? cin.vehicle_color ?? null,
            driver_name: data.profile?.driver_name ?? cin.driver_name ?? null,
            owner_name: data.profile?.owner_name ?? cin.owner_name ?? null,
            partnership_company:
              data.profile?.partnership_company ?? cin.partnership_company ?? null,
            mechanical_number:
              data.profile?.mechanical_number ?? cin.mechanical_number ?? null,
            registration_order: cin.registration_order ?? null,
            qr_payload: cin.qr_payload ?? publicToken,
          });
          await refreshDeskData();
          if (!$("view-tickets").classList.contains("hidden")) await refreshTickets();
        } catch (e) {
          if (e.status === 409) openMessageModal("تعذّر الدخول", e.message);
          else alert(e.message);
        }
      },
    });
  }
}

async function processVehicleScan(raw) {
  const token = extractScanToken(raw);
  if (!token) {
    alert("لم يُستخرج رمز صالح من المسح.");
    return;
  }
  try {
    await stopVehicleQrScanner();
    const data = await api(`/api/employee/vehicle-scan/${encodeURIComponent(token)}`);
    await showVehicleFlowFromScan(token, data);
  } catch (e) {
    alert(e.message);
  }
}

async function stopVehicleQrScanner() {
  if (!html5QrScanner) return;
  try {
    await html5QrScanner.stop();
    html5QrScanner.clear();
  } catch {
    /* ignore */
  }
  html5QrScanner = null;
  $("vehicle-qr-start")?.classList.remove("hidden");
  $("vehicle-qr-stop")?.classList.add("hidden");
}

function getSelectedQrCameraConfig() {
  const cameraId = ($("vehicle-qr-camera")?.value || "").trim();
  if (cameraId) return cameraId;
  return { facingMode: "environment" };
}

async function populateVehicleQrCameras() {
  const sel = $("vehicle-qr-camera");
  if (!sel || typeof Html5Qrcode === "undefined") return;
  const saved = localStorage.getItem(QR_CAMERA_STORAGE_KEY) || "";
  try {
    const cameras = await Html5Qrcode.getCameras();
    sel.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "الكاميرا الافتراضية (خلفية)";
    sel.appendChild(defaultOpt);
    cameras.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.id;
      opt.textContent = cam.label || `كاميرا ${i + 1}`;
      sel.appendChild(opt);
    });
    if (saved && [...sel.options].some((o) => o.value === saved)) {
      sel.value = saved;
    }
  } catch {
    sel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "الكاميرا الافتراضية (خلفية)";
    sel.appendChild(opt);
  }
}

async function startVehicleQrScanner() {
  const hostId = "vehicle-qr-reader-host";
  if (typeof Html5Qrcode === "undefined") {
    alert("مكتبة مسح QR غير محمّلة.");
    return;
  }
  await stopVehicleQrScanner();
  const reader = new Html5Qrcode(hostId);
  html5QrScanner = reader;
  $("vehicle-qr-start")?.classList.add("hidden");
  $("vehicle-qr-stop")?.classList.remove("hidden");
  try {
    await reader.start(
      getSelectedQrCameraConfig(),
      { fps: 8, qrbox: { width: 200, height: 200 } },
      (decodedText) => {
        processVehicleScan(decodedText).catch((err) => alert(err.message));
      },
      () => {}
    );
  } catch (e) {
    html5QrScanner = null;
    $("vehicle-qr-start")?.classList.remove("hidden");
    $("vehicle-qr-stop")?.classList.add("hidden");
    alert(e.message || "تعذّر تشغيل الكاميرا. جرّب اختيار كاميرا أخرى أو إدخال الرمز يدويًا.");
  }
}

function wireVehicleFlowModal() {
  $("vehicle-flow-cancel").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-modal-close").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-modal-backdrop").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-primary").addEventListener("click", () => {
    if (typeof vehicleFlowPrimaryHandler === "function") {
      vehicleFlowPrimaryHandler();
    }
  });
}

function wireVehicleScanDesk() {
  populateVehicleQrCameras().catch(() => {});
  $("vehicle-qr-camera")?.addEventListener("change", () => {
    const id = ($("vehicle-qr-camera")?.value || "").trim();
    if (id) localStorage.setItem(QR_CAMERA_STORAGE_KEY, id);
    else localStorage.removeItem(QR_CAMERA_STORAGE_KEY);
    if (html5QrScanner) {
      stopVehicleQrScanner()
        .then(() => startVehicleQrScanner())
        .catch((e) => alert(e.message));
    }
  });
  $("vehicle-qr-start")?.addEventListener("click", () => {
    startVehicleQrScanner().catch((e) => alert(e.message));
  });
  $("vehicle-qr-stop")?.addEventListener("click", () => {
    stopVehicleQrScanner().catch(() => {});
  });
  $("vehicle-token-submit")?.addEventListener("click", () => {
    const v = $("vehicle-token-manual")?.value || "";
    processVehicleScan(v).catch((e) => alert(e.message));
  });
  const link = $("driver-register-link");
  if (link) link.href = `${window.location.origin}/CarRegistration`;
  $("copy-driver-link")?.addEventListener("click", async () => {
    const url = `${window.location.origin}/CarRegistration`;
    try {
      await navigator.clipboard.writeText(url);
      alert("تم نسخ الرابط.");
    } catch {
      alert(url);
    }
  });
}

function resolveProfileForReceipt(session) {
  if (!session) return null;
  const profileId = session.profile_id;
  if (profileId != null) {
    const cached = vehicleProfileListCache.find((x) => x.id === profileId);
    if (cached) return cached;
    const token = String(session.public_token || "").trim();
    if (token) {
      return {
        id: profileId,
        public_token: token,
        license_plate: session.license_plate || "",
        vehicle_make: session.vehicle_make ?? null,
        vehicle_type: session.vehicle_type ?? null,
        vehicle_color: session.vehicle_color ?? null,
        driver_name: session.driver_name ?? null,
        owner_name: session.owner_name ?? null,
        partnership_company: session.partnership_company ?? null,
        mechanical_number: session.mechanical_number || "",
        registration_order: session.registration_order ?? null,
        qr_payload: session.qr_payload || token,
        has_photo: false,
      };
    }
  }
  const plate = String(session.license_plate || "").trim();
  if (plate) {
    const byPlate = vehicleProfileListCache.find(
      (x) => (x.license_plate || "").toLowerCase() === plate.toLowerCase()
    );
    if (byPlate) return byPlate;
  }
  return null;
}

function syncReceiptCardButton() {
  const btn = $("receipt-modal-card");
  if (!btn) return;
  const show = !!receiptModalProfileRef;
  btn.classList.toggle("hidden", !show);
}

function goToVehicleCardFromReceipt() {
  if (!receiptModalProfileRef) {
    alert("لا يوجد بروفايل مركبة مرتبط بهذا الإيصال.");
    return;
  }
  const profile = receiptModalProfileRef;
  closeReceiptModal();
  openVehicleCardModal(profile);
}

function clearThermalPrintMode() {
  document.body.classList.remove("print-receipt-slip", "print-checkout-slip");
}

function printThermalSlip(mode) {
  clearThermalPrintMode();
  document.body.classList.add(
    mode === "checkout" ? "print-checkout-slip" : "print-receipt-slip"
  );
  const cleanup = () => clearThermalPrintMode();
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 4000);
  window.print();
}

function openReceiptModal(session) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  receiptModalProfileRef = resolveProfileForReceipt(session);
  const modal = $("receipt-modal");
  const body = $("receipt-modal-body");
  body.innerHTML = buildReceiptSlipHtml(session);
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  renderReceiptQr(session.receipt_code);
  syncReceiptCardButton();
  $("receipt-modal-close").focus();
}

function closeReceiptModal() {
  const modal = $("receipt-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("receipt-modal-body").innerHTML = "";
  receiptModalProfileRef = null;
  syncReceiptCardButton();
  if (
    checkoutModalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function checkoutModalIsHidden() {
  const m = $("checkout-result-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function messageModalIsHidden() {
  const m = $("message-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function closeMessageModal() {
  const modal = $("message-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openMessageModal(title, message) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  $("message-modal-title").textContent = title;
  $("message-modal-body").textContent = message;
  const modal = $("message-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("message-modal-dismiss").focus();
}

function wireMessageModal() {
  $("message-modal-close").addEventListener("click", closeMessageModal);
  $("message-modal-dismiss").addEventListener("click", closeMessageModal);
  $("message-modal-backdrop").addEventListener("click", closeMessageModal);
}

function openCheckoutResultModal(data) {
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  const modal = $("checkout-result-modal");
  $("checkout-result-modal-body").innerHTML = buildCheckoutResultHtml(data);
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("checkout-result-modal-dismiss").focus();
}

function closeCheckoutResultModal() {
  const modal = $("checkout-result-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("checkout-result-modal-body").innerHTML = "";
  if (
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function wireCheckoutResultModal() {
  $("checkout-result-modal-close").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-dismiss").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-backdrop").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-print")?.addEventListener("click", () =>
    printThermalSlip("checkout")
  );
}

function wireReceiptModal() {
  const printBtn = $("receipt-modal-print");
  const cardBtn = $("receipt-modal-card");
  const dismiss = $("receipt-modal-dismiss");
  const close = $("receipt-modal-close");
  const backdrop = $("receipt-modal-backdrop");
  printBtn.addEventListener("click", () => printThermalSlip("receipt"));
  cardBtn?.addEventListener("click", goToVehicleCardFromReceipt);
  dismiss.addEventListener("click", closeReceiptModal);
  close.addEventListener("click", closeReceiptModal);
  backdrop.addEventListener("click", closeReceiptModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!vehicleCardModalIsHidden()) {
      closeVehicleCardModal();
      return;
    }
    if (!vehicleFlowModalIsHidden()) {
      closeVehicleFlowModal();
      return;
    }
    if (!messageModalIsHidden()) {
      closeMessageModal();
      return;
    }
    if (!checkoutModalIsHidden()) {
      closeCheckoutResultModal();
      return;
    }
    if (!modalIsHidden()) closeReceiptModal();
  });
}

function modalIsHidden() {
  const m = $("receipt-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function setView(name) {
  if (name === "settings" && currentRole !== "admin") {
    name = "desk";
  }
  if (name === "stats" && currentRole !== "admin") {
    name = "desk";
  }
  const desk = $("view-desk");
  const tickets = $("view-tickets");
  const profiles = $("view-profiles");
  const stats = $("view-stats");
  const settings = $("view-settings");
  const tabDesk = $("nav-desk");
  const tabTickets = $("nav-tickets");
  const tabProfiles = $("nav-profiles");
  const tabStats = $("nav-stats");
  const tabSettings = $("nav-settings");

  if (!desk || !tickets || !profiles || !stats || !settings) return;
  if (!tabDesk || !tabTickets || !tabProfiles || !tabStats || !tabSettings) return;

  const isDesk = name === "desk";
  const isTickets = name === "tickets";
  const isProfiles = name === "profiles";
  const isStats = name === "stats";
  const isSettings = name === "settings";

  desk.classList.toggle("hidden", !isDesk);
  desk.toggleAttribute("hidden", !isDesk);
  tickets.classList.toggle("hidden", !isTickets);
  tickets.toggleAttribute("hidden", !isTickets);
  profiles.classList.toggle("hidden", !isProfiles);
  profiles.toggleAttribute("hidden", !isProfiles);
  stats.classList.toggle("hidden", !isStats);
  stats.toggleAttribute("hidden", !isStats);
  settings.classList.toggle("hidden", !isSettings);
  settings.toggleAttribute("hidden", !isSettings);

  tabDesk.classList.toggle("active", isDesk);
  tabTickets.classList.toggle("active", isTickets);
  tabProfiles.classList.toggle("active", isProfiles);
  tabStats.classList.toggle("active", isStats);
  tabSettings.classList.toggle("active", isSettings);

  if (isDesk) {
    refreshDeskData().catch((e) => alert(e.message));
  } else if (isTickets) {
    refreshTickets().catch((e) => alert(e.message));
  } else if (isProfiles) {
    refreshVehicleProfiles().catch((e) => alert(e.message));
  } else if (isStats) {
    if (!$("stats-month").value) {
      $("stats-month").value = new Date()
        .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
        .slice(0, 7);
    }
    refreshMonthStats().catch((e) => alert(e.message));
  } else if (isSettings) {
    refreshDeskData()
      .then(() => loadAdminUsersForPassword())
      .catch((e) => alert(e.message));
  }
}

function wireNav() {
  $("nav-desk").addEventListener("click", () => setView("desk"));
  $("nav-tickets").addEventListener("click", () => setView("tickets"));
  $("nav-profiles")?.addEventListener("click", () => setView("profiles"));
  $("nav-stats").addEventListener("click", () => setView("stats"));
  $("nav-settings").addEventListener("click", () => setView("settings"));
  $("tickets-refresh").addEventListener("click", () => {
    refreshTickets().catch((e) => alert(e.message));
  });
  $("profiles-refresh")?.addEventListener("click", () => {
    profilesFilterOptions = null;
    refreshVehicleProfiles().catch((e) => alert(e.message));
  });
  $("stats-refresh").addEventListener("click", () => {
    refreshMonthStats().catch((e) => alert(e.message));
  });
  $("stats-month").addEventListener("change", () => {
    refreshMonthStats().catch((e) => alert(e.message));
  });
  $("stats-export-xlsx").addEventListener("click", () => {
    downloadMonthStatsExcel().catch((e) => alert(e.message));
  });
  $("tickets-body").addEventListener("click", onTicketsTableClick);
  $("profiles-body")?.addEventListener("click", onProfilesTableClick);
  let profilesSearchTimer = null;
  $("profiles-search")?.addEventListener("input", (e) => {
    profilesSearchQuery = e.target.value || "";
    profilesPage = 1;
    clearTimeout(profilesSearchTimer);
    profilesSearchTimer = setTimeout(() => {
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }, 300);
  });
  const onFilterChange = () => {
    profilesFilters = {
      vehicle_type: $("profiles-filter-type")?.value || "",
      partnership_company: $("profiles-filter-company")?.value || "",
      has_photo: $("profiles-filter-photo")?.value || "",
    };
    profilesPage = 1;
    refreshVehicleProfiles().catch((err) => alert(err.message));
  };
  $("profiles-filter-type")?.addEventListener("change", onFilterChange);
  $("profiles-filter-company")?.addEventListener("change", onFilterChange);
  $("profiles-filter-photo")?.addEventListener("change", onFilterChange);
  $("profiles-clear-filters")?.addEventListener("click", () => {
    profilesSearchQuery = "";
    profilesFilters = { vehicle_type: "", partnership_company: "", has_photo: "" };
    profilesPage = 1;
    const searchEl = $("profiles-search");
    if (searchEl) searchEl.value = "";
    const typeEl = $("profiles-filter-type");
    const companyEl = $("profiles-filter-company");
    const photoEl = $("profiles-filter-photo");
    if (typeEl) typeEl.value = "";
    if (companyEl) companyEl.value = "";
    if (photoEl) photoEl.value = "";
    refreshVehicleProfiles().catch((err) => alert(err.message));
  });
  $("profiles-prev")?.addEventListener("click", () => {
    if (profilesPage > 1) {
      profilesPage -= 1;
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }
  });
  $("profiles-next")?.addEventListener("click", () => {
    if (profilesPage < profilesListMeta.total_pages) {
      profilesPage += 1;
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }
  });
  $("btn-logout").addEventListener("click", () => {
    clearAuth();
    $("login-error").textContent = "";
    showLoginView();
  });
}

function onTicketsTableClick(e) {
  const copyBtn = e.target.closest(".copy-receipt-code");
  if (copyBtn) {
    e.preventDefault();
    const code = copyBtn.getAttribute("data-code") || "";
    if (!code) return;
    const label = copyBtn;
    const done = () => {
      const prev = label.textContent;
      label.textContent = "تم النسخ";
      setTimeout(() => {
        label.textContent = prev;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {
        fallbackCopy(code, done);
      });
    } else {
      fallbackCopy(code, done);
    }
    return;
  }

  const previewBtn = e.target.closest(".preview-ticket");
  if (previewBtn) {
    const code = previewBtn.getAttribute("data-receipt") || "";
    const row = ticketLogCache.find(
      (x) => x.receipt_code.toLowerCase() === code.toLowerCase()
    );
    if (row) openReceiptModal(row);
    return;
  }

  const codeEl = e.target.closest(".ticket-code");
  if (codeEl) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function fallbackCopy(text, onOk) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
    onOk();
  } catch {
    alert("تعذّر النسخ. انسخ الرمز يدويًا.");
  }
  document.body.removeChild(ta);
}

async function refreshMonthStats() {
  if (!$("stats-month").value) {
    $("stats-month").value = new Date()
      .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
      .slice(0, 7);
  }
  const v = $("stats-month").value;
  const [yStr, mStr] = v.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const q = new URLSearchParams({ year: String(y), month: String(m) });
  const data = await api(`/api/stats/month?${q.toString()}`);
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  $("stats-total-entries").textContent = nf.format(data.total_entries);
  $("stats-total-count").textContent = nf.format(data.total_checkouts);
  $("stats-total-new").textContent = nf.format(data.total_revenue_syp_new);
  $("stats-total-old").textContent = nf.format(
    sypOldEquivalent(data.total_revenue_syp_new)
  );
  const tbody = $("stats-body");
  tbody.innerHTML = "";
  for (const row of data.days) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${nf.format(row.day)}</td>
      <td>${nf.format(row.entry_count)}</td>
      <td>${nf.format(row.checkout_count)}</td>
      <td>${nf.format(row.revenue_syp_new)}</td>
      <td>${nf.format(sypOldEquivalent(row.revenue_syp_new))}</td>`;
    tbody.appendChild(tr);
  }
}

async function downloadMonthStatsExcel() {
  if (!$("stats-month").value) {
    $("stats-month").value = new Date()
      .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
      .slice(0, 7);
  }
  const v = $("stats-month").value;
  const [yStr, mStr] = v.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const t = getToken();
  if (!t) throw new Error("يجب تسجيل الدخول.");
  const url = `/api/stats/month/export?year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    clearAuth();
    showLoginView();
    throw new Error("انتهت الجلسة.");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j.detail != null) {
        msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg || "تعذّر تنزيل الملف.");
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  const name = `parking-stats-${y}-${String(m).padStart(2, "0")}.xlsx`;
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fillUserSelect(sel, users, prevValue) {
  if (!sel) return;
  sel.innerHTML = "";
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.username;
    opt.textContent = `${u.username} (${u.role === "admin" ? "مدير" : "موظف"})`;
    sel.appendChild(opt);
  }
  if (prevValue && [...sel.options].some((o) => o.value === prevValue)) {
    sel.value = prevValue;
  } else if (currentUsername && [...sel.options].some((o) => o.value === currentUsername)) {
    sel.value = currentUsername;
  }
}

async function loadAdminUsersForPassword() {
  if (currentRole !== "admin") return;
  const selPw = $("admin-pw-user");
  const selRename = $("admin-rename-user");
  if (!selPw && !selRename) return;
  const users = await api("/api/admin/users");
  const prevPw = selPw ? selPw.value : "";
  const prevRn = selRename ? selRename.value : "";
  fillUserSelect(selPw, users, prevPw);
  fillUserSelect(selRename, users, prevRn);
}

function onProfilesTableClick(e) {
  const cardBtn = e.target.closest(".profile-row-card");
  if (cardBtn) {
    e.preventDefault();
    const id = parseInt(cardBtn.getAttribute("data-id") || "", 10);
    const row = vehicleProfileListCache.find((x) => x.id === id);
    if (row) openVehicleCardModal(row);
    return;
  }

  const scanRowBtn = e.target.closest(".profile-row-scan");
  if (scanRowBtn) {
    e.preventDefault();
    const t = scanRowBtn.getAttribute("data-token") || "";
    if (!t) return;
    processVehicleScan(t).catch((err) => alert(err.message));
    return;
  }

  const deleteBtn = e.target.closest(".profile-row-delete");
  if (deleteBtn) {
    e.preventDefault();
    const id = parseInt(deleteBtn.getAttribute("data-id") || "", 10);
    const row = vehicleProfileListCache.find((x) => x.id === id);
    if (row) deleteVehicleProfile(row).catch((err) => alert(err.message));
  }
}

function updateProfilesTotalStat() {
  const el = $("profiles-total");
  if (!el) return;
  const total = profilesFilterOptions?.total ?? profilesListMeta.total ?? 0;
  el.textContent = String(total);
}

function populateProfilesFilterSelects(meta) {
  const typeSel = $("profiles-filter-type");
  const companySel = $("profiles-filter-company");
  if (!typeSel || !companySel || !meta) return;
  const typeVal = profilesFilters.vehicle_type;
  const companyVal = profilesFilters.partnership_company;
  typeSel.innerHTML = '<option value="">الكل</option>';
  for (const opt of meta.vehicle_types || []) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = `${opt.value} (${opt.count})`;
    typeSel.appendChild(o);
  }
  typeSel.value = typeVal;
  companySel.innerHTML = '<option value="">الكل</option>';
  for (const opt of meta.partnership_companies || []) {
    const o = document.createElement("option");
    o.value = opt.value;
    const label = opt.value.length > 42 ? `${opt.value.slice(0, 42)}…` : opt.value;
    o.textContent = `${label} (${opt.count})`;
    companySel.appendChild(o);
  }
  companySel.value = companyVal;
  const photoSel = $("profiles-filter-photo");
  if (photoSel) photoSel.value = profilesFilters.has_photo || "";
}

async function loadProfilesFilterMeta() {
  if (profilesFilterOptions) return profilesFilterOptions;
  profilesFilterOptions = await api("/api/vehicle-profiles/meta");
  populateProfilesFilterSelects(profilesFilterOptions);
  updateProfilesTotalStat();
  return profilesFilterOptions;
}

function buildProfilesListParams() {
  const params = new URLSearchParams({
    page: String(profilesPage),
    page_size: String(PROFILES_PAGE_SIZE),
  });
  const q = profilesSearchQuery.trim();
  if (q) params.set("q", q);
  if (profilesFilters.vehicle_type) params.set("vehicle_type", profilesFilters.vehicle_type);
  if (profilesFilters.partnership_company) {
    params.set("partnership_company", profilesFilters.partnership_company);
  }
  if (profilesFilters.has_photo === "yes") params.set("has_photo", "true");
  else if (profilesFilters.has_photo === "no") params.set("has_photo", "false");
  return params;
}

function updateProfilesPaginationUi() {
  const summary = $("profiles-results-summary");
  const pageInfo = $("profiles-page-info");
  const prevBtn = $("profiles-prev");
  const nextBtn = $("profiles-next");
  const { total, page, total_pages } = profilesListMeta;
  if (summary) {
    if (!total) {
      summary.textContent = "لا توجد نتائج.";
    } else {
      const from = (page - 1) * PROFILES_PAGE_SIZE + 1;
      const to = Math.min(page * PROFILES_PAGE_SIZE, total);
      summary.textContent = `عرض ${from}–${to} من ${total} مركبة`;
    }
  }
  if (pageInfo) {
    pageInfo.textContent = total ? `صفحة ${page} من ${total_pages}` : "—";
  }
  if (prevBtn) prevBtn.disabled = page <= 1 || profilesListLoading;
  if (nextBtn) nextBtn.disabled = page >= total_pages || !total || profilesListLoading;
}

async function refreshVehicleProfiles() {
  const tbody = $("profiles-body");
  if (!tbody) return;
  if (profilesListLoading) return;
  profilesListLoading = true;
  updateProfilesPaginationUi();
  try {
    await loadProfilesFilterMeta();
    const data = await api(`/api/vehicle-profiles?${buildProfilesListParams()}`);
    vehicleProfileListCache = Array.isArray(data?.items) ? data.items : [];
    profilesListMeta = {
      total: Number(data?.total) || 0,
      page: Number(data?.page) || 1,
      total_pages: Number(data?.total_pages) || 1,
    };
    profilesPage = profilesListMeta.page;
    renderVehicleProfilesTable();
  } finally {
    profilesListLoading = false;
    updateProfilesPaginationUi();
  }
}

function renderVehicleProfilesTable() {
  const tbody = $("profiles-body");
  if (!tbody) return;
  updateProfilesTotalStat();
  updateProfilesPaginationUi();
  if (!vehicleProfileListCache.length) {
    const hasFilters =
      profilesSearchQuery.trim() ||
      profilesFilters.vehicle_type ||
      profilesFilters.partnership_company ||
      profilesFilters.has_photo;
    tbody.innerHTML = hasFilters
      ? '<tr><td colspan="13" class="muted">لا توجد نتائج مطابقة للبحث أو الفلاتر.</td></tr>'
      : '<tr><td colspan="13" class="muted">لا توجد بروفايلات مسجّلة بعد.</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  for (const r of vehicleProfileListCache) {
    const tr = document.createElement("tr");
    const mk = r.vehicle_make ? escapeHtml(r.vehicle_make) : "—";
    const vtype = r.vehicle_type ? escapeHtml(r.vehicle_type) : "—";
    const cl = r.vehicle_color ? escapeHtml(r.vehicle_color) : "—";
    const mech = escapeHtml(r.mechanical_number);
    const driver = r.driver_name ? escapeHtml(r.driver_name) : "—";
    const owner = r.owner_name ? escapeHtml(r.owner_name) : "—";
    const company = r.partnership_company ? escapeHtml(r.partnership_company) : "—";
    const created = formatDamascusDateTime(r.created_at);
    const photoLabel = r.has_photo ? "نعم" : "لا";
    const seq = Number(r.registration_order);
    const seqDisplay = Number.isFinite(seq) ? escapeHtml(String(seq)) : "—";
    tr.innerHTML = `
      <td>${seqDisplay}</td>
      <td>${escapeHtml(String(r.id))}</td>
      <td>${escapeHtml(r.license_plate)}</td>
      <td>${mk}</td>
      <td>${vtype}</td>
      <td>${cl}</td>
      <td>${mech}</td>
      <td>${driver}</td>
      <td>${owner}</td>
      <td>${company}</td>
      <td>${photoLabel}</td>
      <td>${created}</td>
      <td class="profiles-actions-cell"></td>`;
    const cell = tr.querySelector(".profiles-actions-cell");
    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.className = "btn btn-sm profile-row-scan";
    scanBtn.textContent = "استعلام";
    scanBtn.setAttribute("data-token", r.public_token);
    const cardBtn = document.createElement("button");
    cardBtn.type = "button";
    cardBtn.className = "btn btn-sm profile-row-card";
    cardBtn.textContent = "البطاقة";
    cardBtn.dataset.id = String(r.id);
    cell.appendChild(scanBtn);
    cell.appendChild(document.createTextNode(" "));
    cell.appendChild(cardBtn);
    if (currentRole === "admin") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-sm btn-danger profile-row-delete";
      deleteBtn.textContent = "إزالة";
      deleteBtn.dataset.id = String(r.id);
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(deleteBtn);
    }
    tbody.appendChild(tr);
  }
}

async function refreshTickets() {
  ticketLogCache = await api("/api/sessions/log?limit=300");
  const tbody = $("tickets-body");
  tbody.innerHTML = "";
  if (!ticketLogCache.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="muted">لا توجد تذاكر بعد.</td></tr>';
    return;
  }
  for (const r of ticketLogCache) {
    const tr = document.createElement("tr");
    const entered = formatDamascusDateTime(r.entered_at);
    const inside = r.exited_at == null;
    const statusHtml = inside
      ? '<span class="badge badge-in">داخل الموقف</span>'
      : '<span class="badge badge-out">خرجت</span>';
    const exitedDisplay = r.exited_at
      ? formatDamascusDateTime(r.exited_at)
      : "—";
    const codeHtml = escapeHtml(r.receipt_code);
    tr.innerHTML = `
      <td>${escapeHtml(r.license_plate)}</td>
      <td class="ticket-code-cell">
        <div class="ticket-code-row">
          <code class="ticket-code" dir="ltr" title="انقر لتحديد الرمز">${codeHtml}</code>
          <button type="button" class="btn btn-sm copy-receipt-code" data-code="${codeHtml}">نسخ</button>
        </div>
      </td>
      <td>${entered}</td>
      <td>${statusHtml}</td>
      <td>${exitedDisplay}</td>
      <td>${r.slot_number}</td>
      <td><button type="button" class="btn btn-sm preview-ticket" data-receipt="${codeHtml}">معاينة</button></td>`;
    tbody.appendChild(tr);
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("login-error");
  errEl.textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("login-user").value.trim(),
        password: $("login-pass").value,
      }),
    });
    setToken(data.access_token);
    applyRoleUI({ username: data.username, role: data.role });
    showAppShell();
    $("login-pass").value = "";
    setView("desk");
    await refreshDeskData();
    consumePendingVehicleScan();
  } catch (err) {
    errEl.textContent = err.message || "فشل تسجيل الدخول.";
  }
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("settings-msg");
  msg.textContent = "";
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        total_slots: parseInt($("total-slots").value, 10),
        price_per_hour_cents: Math.max(
          0,
          parseInt(String($("price-hour").value).trim(), 10) || 0
        ),
      }),
    });
    await refreshDeskData();
    msg.textContent = "تم حفظ الإعدادات.";
    msg.style.color = "var(--success)";
  } catch (err) {
    alert(err.message);
  }
});

$("checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mechVal = ($("mech") && $("mech").value) ? $("mech").value.trim() : "";
  try {
    const data = await api("/api/check-in", {
      method: "POST",
      body: JSON.stringify({
        license_plate: $("plate").value,
        mechanical_number: mechVal || null,
        vehicle_make: $("make").value || null,
        vehicle_type: $("vehicle-type").value || null,
        vehicle_color: $("color").value || null,
        driver_name: $("driver-name").value || null,
        owner_name: $("owner-name").value || null,
        partnership_company: $("partnership-company").value || null,
        notes: $("notes").value || null,
      }),
    });
    openReceiptModal({
      receipt_code: data.receipt_code,
      license_plate: data.license_plate,
      slot_number: data.slot_number,
      entered_at: data.entered_at,
      exited_at: null,
      amount_due_cents: null,
      hours_billed: null,
      profile_id: data.profile_id ?? null,
      public_token: data.public_token ?? null,
      vehicle_make: data.vehicle_make || $("make").value.trim() || null,
      vehicle_type: data.vehicle_type || $("vehicle-type").value.trim() || null,
      vehicle_color: data.vehicle_color || $("color").value.trim() || null,
      driver_name: data.driver_name || $("driver-name").value.trim() || null,
      owner_name: data.owner_name || $("owner-name").value.trim() || null,
      partnership_company:
        data.partnership_company || $("partnership-company").value.trim() || null,
      mechanical_number: data.mechanical_number || mechVal || null,
      registration_order: data.registration_order ?? null,
      qr_payload: data.qr_payload ?? null,
    });
    $("plate").value = "";
    $("mech").value = "";
    $("make").value = "";
    $("vehicle-type").value = "";
    $("color").value = "";
    $("driver-name").value = "";
    $("owner-name").value = "";
    $("partnership-company").value = "";
    $("notes").value = "";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-profiles").classList.contains("hidden")) {
      await refreshVehicleProfiles();
    }
  } catch (err) {
    if (err.status === 409) {
      openMessageModal("تعذّر الدخول", err.message);
    } else {
      alert(err.message);
    }
  }
});

$("checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/check-out", {
      method: "POST",
      body: JSON.stringify({ receipt_code: $("receipt").value.trim() }),
    });
    openCheckoutResultModal(data);
    $("receipt").value = "";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-stats").classList.contains("hidden")) {
      await refreshMonthStats();
    }
  } catch (err) {
    alert(err.message);
  }
});

$("admin-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-pw-msg");
  msg.textContent = "";
  try {
    await api("/api/admin/users/password", {
      method: "PUT",
      body: JSON.stringify({
        username: $("admin-pw-user").value,
        new_password: $("admin-pw-new").value,
      }),
    });
    $("admin-pw-new").value = "";
    msg.textContent = "تم حفظ كلمة المرور للمستخدم المحدد.";
    msg.style.color = "var(--success)";
  } catch (err) {
    msg.textContent = err.message || "فشل الحفظ.";
    msg.style.color = "#f87171";
  }
});

$("admin-rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-rename-msg");
  msg.textContent = "";
  try {
    const res = await api("/api/admin/users/username", {
      method: "PUT",
      body: JSON.stringify({
        current_username: $("admin-rename-user").value,
        new_username: $("admin-rename-new").value.trim(),
      }),
    });
    $("admin-rename-new").value = "";
    if (res.renamed_self) {
      msg.textContent = "تم تغيير اسمك. سجّل الدخول بالاسم الجديد.";
      msg.style.color = "var(--success)";
      clearAuth();
      showLoginView();
      $("login-error").textContent = "تم تغيير اسم المستخدم. سجّل الدخول بالاسم الجديد.";
      return;
    }
    msg.textContent = "تم تغيير اسم المستخدم.";
    msg.style.color = "var(--success)";
    await loadAdminUsersForPassword();
  } catch (err) {
    msg.textContent = err.message || "فشل التغيير.";
    msg.style.color = "#f87171";
  }
});

$("admin-wipe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-wipe-msg");
  msg.textContent = "";
  try {
    await api("/api/admin/database/wipe", {
      method: "POST",
      body: JSON.stringify({ confirmation: $("admin-wipe-confirm").value }),
    });
    $("admin-wipe-confirm").value = "";
    msg.textContent = "تم مسح جميع جلسات الموقف وإعادة الإعدادات الافتراضية.";
    msg.style.color = "var(--success)";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-stats").classList.contains("hidden")) {
      await refreshMonthStats();
    }
  } catch (err) {
    msg.textContent = err.message || "فشل المسح.";
    msg.style.color = "#f87171";
  }
});

async function refreshDeskData() {
  await refreshStats();
}

async function tryResumeSession() {
  if (!getToken()) return false;
  try {
    const me = await api("/api/auth/me");
    applyRoleUI(me);
    showAppShell();
    return true;
  } catch {
    clearAuth();
    showLoginView();
    return false;
  }
}

async function boot() {
  captureVehicleScanFromHash();
  showLoginView();
  const ok = await tryResumeSession();
  if (ok) {
    setView("desk");
    await refreshDeskData();
    populateVehicleQrCameras().catch(() => {});
    consumePendingVehicleScan();
  }
}

wireCheckoutResultModal();
wireReceiptModal();
wireMessageModal();
wireVehicleFlowModal();
wireVehicleScanDesk();
wireNav();

function wireVehicleCardModal() {
  $("vehicle-card-modal-close")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-dismiss")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-modal-backdrop")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-download")?.addEventListener("click", () => {
    downloadVehicleCardPng().catch(() => {});
  });
}

wireVehicleCardModal();

boot().catch((err) => {
  console.error(err);
  alert(
    "تعذّر الاتصال بالخادم. شغّل الخادم ثم أعد المحاولة: python -m uvicorn app.main:app --reload"
  );
});
