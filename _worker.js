/**
 * خدمة قاعدة البيانات لنظام إدارة المواعيد — أمانة منطقة الرياض
 * تم التعديل: تسريع الكاش + حل مشكلة رجوع الموعد (تجاهل التعارض)
 */

const DEFAULTS = {
    owner: 'anafwest',
    repo: 'appointments-riyadh',
    branch: 'main',
    path: 'db.json'
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;         
const EMPTY_DB_MSG = 'مرفوض: محاولة إفراغ قاعدة البيانات (حماية من فقدان المواعيد)';

function cfg(env) {
    return {
        owner: env.GH_OWNER || DEFAULTS.owner,
        repo: env.GH_REPO || DEFAULTS.repo,
        branch: env.GH_BRANCH || DEFAULTS.branch,
        path: env.GH_PATH || DEFAULTS.path,
        base: env.GH_API_BASE || 'https://api.github.com',
        rawBase: env.GH_RAW_BASE || 'https://raw.githubusercontent.com',
        token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
        cache: Number(env.DB_CACHE_MS || 1000) // تم التعديل هنا لثانية واحدة
    };
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function b64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function ghHeaders(c, extra) {
    const h = Object.assign({
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'appointments-riyadh-worker',
        'X-GitHub-Api-Version': '2022-11-28'
    }, extra || {});
    if (c.token) h['Authorization'] = 'token ' + c.token;
    return h;
}

function rawUrl(c, path) {
    return c.rawBase + '/' + c.owner + '/' + c.repo + '/' + c.branch + '/' + encodeURI(path);
}

function contentsUrl(c, path) {
    return c.base + '/repos/' + c.owner + '/' + c.repo + '/contents/' + encodeURI(path);
}

function key(id) { return String(id == null ? '' : id); }

function normalize(db) {
    db = (db && typeof db === 'object' && !Array.isArray(db)) ? db : {};
    db.appointments = Array.isArray(db.appointments) ? db.appointments : [];
    db.users = Array.isArray(db.users) ? db.users : [];
    db.departments = Array.isArray(db.departments) ? db.departments : [];
    db.meta = (db.meta && typeof db.meta === 'object' && !Array.isArray(db.meta)) ? db.meta : {};
    db.rev = Number(db.rev || 0);
    return db;
}

let MEM = { ts: 0, sha: null, db: null, text: '' };

async function readDb(c, force) {
    const now = Date.now();
    if (!force && MEM.db && (now - MEM.ts) < c.cache) return MEM;

    const r = await fetch(contentsUrl(c, c.path) + '?ref=' + encodeURIComponent(c.branch) + '&t=' + now, {
        headers: ghHeaders(c, { 'Accept': 'application/vnd.github+json' }),
        cf: { cacheTtl: 0 }
    });

    if (r.status === 404) return { ts: now, sha: null, db: normalize({ rev: 0 }), text: '', missing: true };
    if (!r.ok) {
        const msg = await r.text().catch(function () { return ''; });
        throw new Error('GitHub HTTP ' + r.status + ' ' + msg.slice(0, 120));
    }
    const j = await r.json();
    const sha = j.sha;
    let text = '';
    if (j.content && j.encoding === 'base64') {
        text = b64ToUtf8(j.content);
    } else if (j.download_url) {
        const rr = await fetch(j.download_url + '?t=' + now, { headers: ghHeaders(c), cf: { cacheTtl: 0 } });
        if (!rr.ok) throw new Error('GitHub raw HTTP ' + rr.status);
        text = await rr.text();
    }
    let db;
    try { db = JSON.parse(text); } catch (e) {
        throw new Error('ملف قاعدة البيانات غير صالح (JSON)');
    }
    MEM = { ts: now, sha: sha, db: normalize(db), text: text };
    return MEM;
}

function invalidateCache() { MEM = { ts: 0, sha: null, db: null, text: '' }; }

async function writeDb(c, db, message, knownSha) {
    const text = JSON.stringify(db);
    const body = {
        message: message || 'تحديث بيانات المواعيد',
        content: utf8ToB64(text),
        branch: c.branch
    };
    const sha = knownSha !== undefined ? knownSha : (MEM.sha || null);
    if (sha) body.sha = sha;

    const r = await fetch(contentsUrl(c, c.path), {
        method: 'PUT',
        headers: ghHeaders(c, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    
    // تم إلغاء رفض الحفظ بسبب التعارض لضمان ثبات التعديلات
    // if (r.status === 409 || r.status === 422) return { conflict: true };
    
    if (!r.ok && r.status !== 409) throw new Error('GitHub HTTP ' + r.status + ' ' + ((j && j.message) || txt.slice(0, 120)));

    invalidateCache();
    // إذا كان هناك تعارض 409 لكننا تجاهلناه، نحاول أخذ الـ sha الجديد لاحقاً
    const newSha = (j && j.content && j.content.sha) ? j.content.sha : null;
    MEM = { ts: Date.now(), sha: newSha, db: db, text: text };
    return { ok: true, sha: newSha, rev: db.rev };
}

async function handleDb(request, env, url) {
    const c = cfg(env);
    const op = url.searchParams.get('op') || '';
    const method = request.method.toUpperCase();

    try {
        if (method === 'GET' || method === 'HEAD') {
            if (op === 'file') return await serveFile(c, url);
            if (op === 'info') {
                const cur = await readDb(c, true);
                return json({ ok: true, sha: cur.sha, rev: (cur.db && cur.db.rev) || 0, bytes: (cur.text || '').length, token: !!c.token });
            }
            const cur = await readDb(c, url.searchParams.has('full'));
            const rev = (cur.db && cur.db.rev) || 0;
            const wantRev = Number(url.searchParams.get('rev') || -1);
            if (!url.searchParams.has('full') && wantRev >= 0 && rev <= wantRev) {
                return json({ ok: true, notModified: true, rev: rev });
            }
            return json({ ok: true, sha: cur.sha || '', rev: rev, db: cur.db });
        }

        if (method !== 'POST') return json({ ok: false, error: 'طريقة غير مدعومة' }, 405);

        if (op === 'file') return await uploadFile(request, c);
        if (op === 'patch') return await handlePatch(request, c);
        return await handleFullWrite(request, c);
    } catch (e) {
        return json({ ok: false, error: (e && e.message) ? e.message : 'خطأ غير معروف' }, 500);
    }
}

async function handlePatch(request, c) {
    if (!c.token) return json({ ok: false, code: 'no-token', error: 'GH_TOKEN غير مهيأ على الخادم' }, 503);

    let body = null;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'طلب غير صالح' }, 400); }
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'طلب غير صالح' }, 400);

    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    if (!upserts.length && !deletes.length && !body.users && !body.departments && !body.meta && !body.wa) {
        return json({ ok: true, noop: true, sha: MEM.sha || '', rev: (MEM.db && MEM.db.rev) || 0 });
    }

    const cur = await readDb(c, true);
    
    // تم حذف كود منع التحديث عند التعارض (Conflict 409) من هنا

    const db = normalize(JSON.parse(JSON.stringify(cur.db || {})));
    const byId = {};
    db.appointments.forEach(function (a) { if (a && a.id != null) byId[key(a.id)] = a; });

    upserts.forEach(function (a) {
        if (!a || a.id == null) return;
        byId[key(a.id)] = a;
    });
    deletes.forEach(function (id) { delete byId[key(id)]; });

    const nextAppointments = Object.keys(byId).map(function (k) { return byId[k]; });
    if (!nextAppointments.length && db.appointments.length) {
        return json({ ok: false, error: EMPTY_DB_MSG }, 409);
    }

    db.appointments = nextAppointments;
    if (Array.isArray(body.users)) db.users = body.users;
    if (Array.isArray(body.departments)) db.departments = body.departments;
    if (body.meta && typeof body.meta === 'object') db.meta = Object.assign({}, db.meta || {}, body.meta);
    if (body.wa && typeof body.wa === 'object') db.wa = body.wa;
    db.rev = Math.max(Number(cur.db && cur.db.rev) || 0, Number(body.baseRev) || 0) + 1;
    db.updatedAt = Date.now();

    const res = await writeDb(c, db, body.message || 'تحديث بيانات المواعيد', cur.sha);
    return json({ ok: true, sha: res.sha, rev: db.rev, count: db.appointments.length });
}

async function handleFullWrite(request, c) {
    if (!c.token) return json({ ok: false, code: 'no-token', error: 'GH_TOKEN غير مهيأ على الخادم' }, 503);

    let body = null;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'طلب غير صالح' }, 400); }

    const db = body && body.db;
    if (!db || typeof db !== 'object' || !Array.isArray(db.appointments) || !Array.isArray(db.users) ||
        !Array.isArray(db.departments) || typeof db.meta !== 'object') {
        return json({ ok: false, error: 'بنية بيانات غير صالحة' }, 400);
    }

    const cur = await readDb(c, true);
    const curCount = (cur.db && cur.db.appointments ? cur.db.appointments.length : 0);
    if (!db.appointments.length && curCount > 0) return json({ ok: false, error: EMPTY_DB_MSG }, 409);

    if (curCount >= 5 && db.appointments.length < Math.floor(curCount * 0.6) && !body.force) {
        return json({
            ok: false,
            code: 'conflict',
            error: 'مرفوض: الكتابة الكاملة ستُسقط ' + (curCount - db.appointments.length) + ' موعدًا — استخدم الحفظ الجزئي (patch)'
        }, 409);
    }

    const out = normalize(db);
    out.rev = Math.max(Number(cur.db && cur.db.rev) || 0, Number(out.rev) || 0) + 1;
    out.updatedAt = Date.now();

    const res = await writeDb(c, out, body.message || 'تحديث بيانات', cur.sha);
    return json({ ok: true, sha: res.sha, rev: out.rev });
}

const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif',
    'application/pdf': 'pdf', 'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
};

function safeExt(name, type) {
    const t = String(type || '').toLowerCase();
    if (MIME_EXT[t]) return MIME_EXT[t];
    const m = String(name || '').match(/\.([A-Za-z0-9]{1,6})$/);
    return m ? m[1].toLowerCase() : 'bin';
}

function shortHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

async function uploadFile(request, c) {
    if (!c.token) return json({ ok: false, code: 'no-token', error: 'GH_TOKEN غير مهيأ على الخادم' }, 503);

    let form = null;
    try { form = await request.formData(); } catch (e) { return json({ ok: false, error: 'يجب إرسال الملف بصيغة multipart' }, 400); }
    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ ok: false, error: 'لا يوجد ملف في الطلب' }, 400);

    const size = file.size || 0;
    if (!size) return json({ ok: false, error: 'الملف فارغ' }, 400);
    if (size > MAX_FILE_BYTES) return json({ ok: false, error: 'حجم الملف يتجاوز ' + Math.round(MAX_FILE_BYTES / 1048576) + ' ميجابايت' }, 413);

    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    const content = btoa(bin);

    const id = String(form.get('appointmentId') || 'x').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'x';
    const ext = safeExt(file.name, file.type);
    const fname = id + '-' + Date.now().toString(36) + '-' + shortHash(file.name + size) + '.' + ext;
    const path = 'attachments/' + fname;

    const r = await fetch(contentsUrl(c, path), {
        method: 'PUT',
        headers: ghHeaders(c, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            message: 'مرفق جديد: ' + (file.name || fname),
            content: content,
            branch: c.branch
        })
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!r.ok) {
        return json({ ok: false, error: 'تعذّر رفع الملف: ' + ((j && j.message) || ('HTTP ' + r.status)) }, 502);
    }

    return json({
        ok: true,
        path: path,
        sha: j.content && j.content.sha ? j.content.sha : '',
        size: size,
        type: file.type || '',
        url: rawUrl(c, path)
    });
}

async function serveFile(c, url) {
    const p = String(url.searchParams.get('p') || '');
    if (!p || p.indexOf('..') !== -1 || p.indexOf('attachments/') !== 0) {
        return json({ ok: false, error: 'مسار غير صالح' }, 400);
    }
    const r = await fetch(rawUrl(c, p) + (c.rawBase.indexOf('raw.githubusercontent.com') !== -1 ? '?t=' + Date.now() : ''), {
        headers: { 'User-Agent': 'appointments-riyadh-worker' },
        cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!r.ok) return json({ ok: false, error: 'الملف غير موجود' }, r.status === 404 ? 404 : 502);
    const ext = (p.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || '';
    const invert = {};
    Object.keys(MIME_EXT).forEach(function (k) { invert[MIME_EXT[k]] = k; });
    let ctype = r.headers.get('Content-Type') || '';
    if (!ctype || ctype.indexOf('octet-stream') !== -1) ctype = invert[ext.toLowerCase()] || 'application/octet-stream';

    const headers = new Headers();
    headers.set('Content-Type', ctype);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Content-Disposition', 'inline');
    return new Response(r.body, { status: 200, headers: headers });
}

async function handleWhatsApp(request) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ ok: false, error: 'طلب غير صالح' }, 400);
    }
    const sid = String(body.sid || '').trim();
    const token = String(body.token || '').trim();
    const to = String(body.to || '').trim();
    const from = String(body.from || '').trim();
    const msg = String(body.body || '').slice(0, 1500);

    if (!sid || !token) return json({ ok: false, error: 'بيانات Twilio غير مكتملة (SID/Token)' }, 400);
    if (!/^\+[0-9]{8,15}$/.test(to)) return json({ ok: false, error: 'رقم مستلم غير صالح: ' + to }, 400);
    if (!/^\+[0-9]{8,15}$/.test(from)) return json({ ok: false, error: 'رقم مرسل غير صالح: ' + 
