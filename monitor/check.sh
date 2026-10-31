#!/usr/bin/env bash
# ============================================================
# فاحص صفحة نظام إدارة المواعيد — فحص دائم للأخطاء
# يُستخدم محليًا (مراقب الخلفية) وفي GitHub Actions (جدول دائم)
# الاستخدام: bash monitor/check.sh
# المخرجات: سطور [PASS] / [FAIL] / [SKIP] ثم ملخّص — ويخرج برمز1 عند أي فشل
# ============================================================
set -u
URL="https://anafwest-appointments.web.app"
REPO="anafwest/appointments-riyadh"
FAILS=0

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; FAILS=$((FAILS+1)); }
skip() { echo "[SKIP] $1"; }

# ---------- 1) الصفحة الرئيسية ----------
code=$(curl -sS -o /tmp/mon-page.html -w '%{http_code}' --max-time 30 "$URL/" 2>/dev/null) || code=000
if [ "$code" = "200" ]; then
  pass "الصفحة الرئيسية تستجيب (HTTP 200)"
else
  fail "الصفحة الرئيسية — HTTP $code"
fi
size=$(wc -c < /tmp/mon-page.html 2>/dev/null || echo 0)
if [ "$code" = "200" ]; then
  if [ "$size" -gt 300000 ]; then
    pass "حجم الصفحة سليم ($size bytes)"
  else
    fail "حجم الصفحة مريب ($size bytes — المتوقع >300KB)"
  fi
  if grep -q "نظام إدارة المواعيد" /tmp/mon-page.html 2>/dev/null; then
    pass "محتوى الصفحة موجود (نظام إدارة المواعيد)"
  else
    fail "محتوى الصفحة المتوقع غير موجود — قد تكون الصفحة متضررة"
  fi
  if grep -q "ghGetDb" /tmp/mon-page.html 2>/dev/null; then
    pass "كود التطبيق موجود (ghGetDb)"
  else
    fail "كود التطبيق مفقود من الصفحة"
  fi
fi

# ---------- 2) مسار /api/db (يجب أن يكون404 = تحويل سليم لـ GitHub) ----------
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$URL/api/db" 2>/dev/null) || code=000
if [ "$code" = "404" ]; then
  pass "/api/db يرجع 404 (التحويل إلى GitHub يعمل كالمخطط)"
elif [ "$code" = "200" ]; then
  fail "/api/db يرجع 200 — توجد إعادة كتابة غير متوقعة على الاستضافة"
else
  fail "/api/db — ردة غير متوقعة: $code"
fi

# ---------- 3) قاعدة البيانات db.json على GitHub ----------
if command -v python3 >/dev/null 2>&1; then
  dbres=$(curl -sS --max-time 30 -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/contents/db.json?ref=main" -o /tmp/mon-dbmeta.json -w '%{http_code}' 2>/dev/null) || dbres=000
  if [ "$dbres" = "200" ]; then
    out=$(python3 - <<'PY'
import json, base64
try:
    m = json.load(open('/tmp/mon-dbmeta.json'))
    db = json.loads(base64.b64decode(m['content']))
    errs = []
    if not isinstance(db.get('appointments'), list): errs.append('appointments ليست قائمة')
    elif len(db['appointments']) == 0: errs.append('لا يوجد مواعيد إطلاقًا')
    if not isinstance(db.get('users'), list): errs.append('users ليست قائمة')
    if not isinstance(db.get('rev'), (int, float)): errs.append('rev مفقود')
    if errs: print('ERR:' + '; '.join(errs))
    else:
        print('OK:%d مواعيد، rev %s' % (len(db['appointments']), db.get('rev')))
except Exception as e:
    print('ERR:db.json غير صالح — ' + str(e))
PY
)
    case "$out" in
      OK:*) pass "db.json سليم — ${out#OK:}" ;;
      ERR:*) fail "${out#ERR:}" ;;
      *) fail "تعذر تحليل db.json" ;;
    esac
  else
    fail "قراءة db.json من GitHub — HTTP $dbres"
  fi
else
  skip "python3 غير متوفر — فحص db.json"
fi

# ---------- 4) الموارد الخارجية (الخطوط + pdf.js) ----------
for u in \
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" \
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"
do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u" 2>/dev/null) || c=000
  if [ "$c" = "200" ]; then
    pass "مورّد خارجي: $(basename "${u%%\?*}")"
  else
    fail "مورّد خارجي فشل ($c): $u"
  fi
done

# ---------- 5) صلاحية توكن الحفظ (اختياري إن وُضع GH_MONITOR_TOKEN) ----------
if [ -n "${GH_MONITOR_TOKEN:-}" ]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "Authorization: token $GH_MONITOR_TOKEN" "https://api.github.com/rate_limit" 2>/dev/null) || c=000
  if [ "$c" = "200" ]; then
    pass "توكن الحفظ صالح"
  else
    fail "توكن الحفظ غير صالح (HTTP $c) — الحفظ على الموقع معطّل!"
  fi
else
  skip "فحص التوكن (لم يُضبط GH_MONITOR_TOKEN)"
fi

# ---------- الملخّص ----------
if [ "$FAILS" -eq 0 ]; then
  echo "RESULT:PASS — لا توجد أخطاء ($(date '+%F %T'))"
  exit 0
else
  echo "RESULT:FAIL — $FAILS خطأ/أخطاء ($(date '+%F %T'))"
  exit 1
fi
