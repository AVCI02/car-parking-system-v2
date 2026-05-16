# استضافة نظام الموقف على سيرفر منزلي

هذا الدليل يفترض سيرفرًا منزليًا يعمل **Linux** (مثل Ubuntu على جهاز قديم أو Raspberry Pi). الفكرة نفسها تنطبق على Windows مع تعديل أوامر التشغيل والخدمة.

---

## 1) المتطلبات

- **Python 3.10+** (يُفضّل 3.11 أو أحدث).
- اتصال شبكة ثابت نسبيًا: يفضّل إعطاء السيرفر **عنوان IP ثابت** داخل الشبكة المنزلية (من إعدادات الراوتر DHCP reservation).
- إن أردت الوصول من خارج المنزل: راوتر يدعم **توجيه المنفذ (Port Forward)** أو **VPN** إلى المنزل (الأخير أنسب أمنيًا من فتح منافذ للعالم كله).

---

## 2) تثبيت التطبيق على السيرفر

```bash
# مثال: المجلد الذي تختاره
cd /opt
sudo git clone <رابط-مستودع-المشروع> car-parking-system
cd car-parking-system

# بيئة افتراضية (مُستحسن)
python3 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt
```

إن لم تستخدم Git: انسخ مجلد المشروع كاملًا إلى السيرفر.

---

## 3) ملف البيئة `.env`

أنشئ ملفًا باسم `.env` في جذر المشروع (بجانب `requirements.txt`) أو صدّر المتغيرات في نظامك. انسخ من `env.example` وعدّل القيم.

| المتغير | وصف |
|---------|-----|
| `DATABASE_URL` | اتركه **فارغًا** لاستخدام **SQLite** (`parking.db` في مجلد المشروع). أو ضع رابط PostgreSQL إن ركّبت قاعدة على السيرفر. |
| `PARKING_PUBLIC_BASE_URL` | **مهم لروابط و QR السائق:** الرابط الذي يفتحه الهاتف من خارج السيرفر، مثل `https://parking.example.com` أو `http://192.168.1.50:8000` إن كان الاستخدام داخل الشبكة الداخلية فقط. **بدون** شرطة مائلة في النهاية. |
| `PARKING_JWT_SECRET` | سلسلة عشوائية طويلة (32 حرفًا فأكثر) لتوقيع جلسات تسجيل الدخول. **لا تترك القيمة الافتراضية في الإنتاج.** |
| `PARKING_ADMIN_PASSWORD` / `PARKING_EMPLOYEE_PASSWORD` | تُستخدم **عند أول تشغيل** فقط لإنشاء المستخدمين الافتراضيين إن لم تكن القاعدة موجودة. غيّر كلمات المرور من داخل التطبيق لاحقًا. |
| `PORT` | المنفذ الذي يستمع عليه الخادم (مثل `8000`). |

**ملاحظة:** التطبيق يقرأ المتغيرات من البيئة؛ إن لم تستخدم أداة تحمّل `.env` تلقائيًا، شغّل الأوامر بعد:

```bash
set -a && source .env && set +a
```

أو ثبّت `python-dotenv` وادمج تحميلًا بسيطًا في المشروع لاحقًا، أو ضع المتغيرات في ملف وحدة **systemd** (الأفضل للإنتاج) كما في القسم التالي.

---

## 4) تجربة يدوية سريعة

من مجلد المشروع مع تفعيل الـ venv:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- من جهاز آخر على نفس الشبكة: افتح `http://IP-السيرفر:8000`
- صفحة السائق: `http://IP-السيرفر:8000/driver`

إذا عمل كل شيء، انتقل لتشغيله كخدمة دائمة.

---

## 5) تشغيل دائم بـ systemd (Linux)

1. أنشئ مستخدمًا نظاميًا بلا صلاحيات واسعة (اختياري لكن مُستحسن):

```bash
sudo useradd --system --home /opt/car-parking-system --shell /usr/sbin/nologin parking
sudo chown -R parking:parking /opt/car-parking-system
```

2. أنشئ ملف الخدمة `/etc/systemd/system/parking.service`:

```ini
[Unit]
Description=Car parking web app
After=network.target

[Service]
Type=simple
User=parking
Group=parking
WorkingDirectory=/opt/car-parking-system
Environment=PATH=/opt/car-parking-system/.venv/bin
Environment=PORT=8000
Environment=PARKING_JWT_SECRET=ضع_هنا_سرًا_عشوائيًا_طويلًا
Environment=PARKING_PUBLIC_BASE_URL=http://192.168.1.50:8000
ExecStart=/opt/car-parking-system/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

عدّل المسارات و`PARKING_PUBLIC_BASE_URL` حسب إعدادك.

3. تفعيل وتشغيل:

```bash
sudo systemctl daemon-reload
sudo systemctl enable parking
sudo systemctl start parking
sudo systemctl status parking
```

---

## 6) الوصول من الإنترنت (اختياري)

1. في الراوتر: **Port forwarding** من المنفذ الخارجي (مثل 443 أو 8443) إلى `IP-السيرفر:8000` (أو إلى منفذ الـ reverse proxy).
2. **يُفضّل HTTPS:** استخدم **Nginx** أو **Caddy** أمام Uvicorn، مع شهادة من **Let’s Encrypt** إن كان لديك اسم نطاق يشير إلى منزلك. عندها:
   - يبقى Uvicorn على `127.0.0.1:8000`
   - البروكسي يستمع على 443 ويمرّر الطلبات.
   - حدّث `PARKING_PUBLIC_BASE_URL` إلى `https://اسم-النطاق` حتى تكون روابط QR صحيحة للهواتف من أي مكان.

بدون HTTPS، الاستخدام داخل المنزل فقط (`http://192.168.x.x`) أقل تعقيدًا لكن كلمات المرور تمرّ على الشبكة غير المشفّرة إن لم تضف طبقة TLS.

---

## 7) النسخ الاحتياطي

احفظ بانتظام:

| ماذا | أين |
|------|-----|
| قاعدة SQLite | ملف `parking.db` في جذر المشروع |
| صور بروفايلات السيارات | المجلد `uploads/vehicle_photos/` |

مثال أرشفة:

```bash
cd /opt/car-parking-system
sudo systemctl stop parking
tar czvf ~/parking-backup-$(date +%F).tar.gz parking.db uploads
sudo systemctl start parking
```

---

## 8) جدار الحماية

- على السيرفر: اسمح بالمنفذ 8000 (أو 443 إن استخدمت بروكسي) فقط من الشبكات التي تحتاجها.
- لا تفتح منفذ الإدارة للعالم إن لم تكن بحاجة لذلك؛ الأفضل VPN للوصول الإداري.

---

## 9) Windows (سيرفر منزلي على ويندوز)

- ثبّت Python وشغّل من PowerShell داخل المجلد:

  ```powershell
  python -m venv .venv
  .\.venv\Scripts\Activate.ps1
  pip install -r requirements.txt
  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
  ```

- لتشغيله عند الإقلاع: استخدم **Task Scheduler** أو **NSSM** لتشغيل نفس أمر `uvicorn` مع `Working directory` = مجلد المشروع.
- اضبط `PARKING_PUBLIC_BASE_URL` إما بـ IP داخلي أو بعنوانك العلني مع التوجيه.

---

## 10) قائمة تحقق سريعة

- [ ] `PARKING_JWT_SECRET` قوي وفريد.
- [ ] `PARKING_PUBLIC_BASE_URL` يطابق الرابط الفعلي الذي يفتحه السائق/الموظف (بعد البروكسي إن وُجد).
- [ ] نسخ احتياطي لـ `parking.db` و`uploads/`.
- [ ] كلمات مرور المدير والموظف غيّرت من الواجهة بعد أول دخول.
- [ ] إن كان الوصول من الإنترنت: HTTPS + حد أدنى من فتح المنافذ.

---

إن احتجت خطوات مفصّلة لـ **Nginx + Let’s Encrypt** على توزيعة معيّنة، يمكن إضافة قسم لاحقًا في نفس الملف حسب بيئتك.
