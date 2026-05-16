# الاستضافة اليومية (Railway + PostgreSQL)

## 1) إنشاء المشروع على Railway

1. ادخل إلى [railway.app](https://railway.app) وأنشئ مشروعًا جديدًا (Deploy from GitHub/GitLab أو رفع المجلد).
2. أضف خدمة **PostgreSQL** من القائمة (New → Database → PostgreSQL).
3. أضف خدمة **Web** من نفس المشروع واربطها بريبو التطبيق. Railway يبني المشروع تلقائيًا (Python + `requirements.txt`).
4. في خدمة الويب: **Variables** (المتغيرات):
   - **`DATABASE_URL`**: غالبًا يُربَط تلقائيًا عند ربط قاعدة Postgres مع التطبيق. إن لم يحدث، انسخ رابط الاتصال من خدمة Postgres والصقه هنا.
   - **`PARKING_JWT_SECRET`**: سلسلة عشوائية طويلة (مثلاً 40 حرفًا فأكثر) لتوقيع جلسات الدخول.
   - **`PARKING_ADMIN_PASSWORD`** و **`PARKING_EMPLOYEE_PASSWORD`**: كلمات المرور عند **أول تشغيل** قبل وجود مستخدمين في القاعدة. بعدها يغيّر المدير كلمات المرور من **إعدادات الموقف** (تعيين كلمة مرور المستخدمين).
5. تأكد أن أمر التشغيل هو تشغيل Uvicorn على المنفذ الذي يعطيه Railway، مثل ما في **`Procfile`**:
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

## 2) بعد أول نشر

- افتح عنوان الخدمة العام، سجّل الدخول كمدير، غيّر كلمات المرور من الواجهة.
- راقب السجلات (Logs) عند أي خطأ في الاتصال بقاعدة البيانات (غالبًا `DATABASE_URL` أو SSL من جهة مزوّد القاعدة).

## 3) تشغيل محلي مع Postgres (اختياري)

اضبط `DATABASE_URL` في بيئة الطرفية ثم:

`python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`

بدون `DATABASE_URL` يُستخدم SQLite (`parking.db`) في مجلد المشروع.

## 4) تصدير الإحصائيات (Excel)

- للمدير فقط: من واجهة **إحصائيات الشهر** زر **«تنزيل Excel»**، أو مباشرةً: `GET /api/stats/month/export?year=YYYY&month=M` مع ترويسة `Authorization: Bearer …`.
- الملف يحتوي أعمدة: اليوم، دخول، خروج، إيراد جديد، إيراد قديم، ثم صف إجمالي.

## 5) واجهات إدارة المستخدمين والمسح (API)

- تغيير اسم مستخدم: `PUT /api/admin/users/username` (جسون: `current_username`, `new_username`).
- تعيين كلمة مرور: `PUT /api/admin/users/password` (جسون: `username`, `new_password`).
- مسح كل جلسات الموقف وإعادة الإعدادات الافتراضية: `POST /api/admin/database/wipe` مع جسون `confirmation` يساوي بالضبط `امسح_كل_البيانات`.
- قائمة المستخدمين: `GET /api/admin/users`.
- تغيير كلمة مرورك (برمجيًا): `POST /api/auth/change-password`.

نسخة مرجعية للمتغيرات: **`env.example`**.
# car-parking-system
# car-parking-system-v2
