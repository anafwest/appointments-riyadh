/**
 * خدمة قاعدة البيانات لنظام إدارة المواعيد — أمانة منطقة الرياض
 * نظام الحفظ الذكي الذاتي (Auto-Retry & Fresh Fetch)
 */

const DEFAULTS = {
    owner: 'anafwest',
    repo: 'appointments-riyadh',
    branch: 'main',
    path: 'db.json'
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function cfg(env) {
    return {
        owner: env.GH_OWNER || DEFAULTS.owner,
        repo: env.GH_REPO || DEFAULTS.repo,
        branch: env.GH_BRANCH || DEFAULTS.branch,
        path: env.GH_PATH || DEFAULTS.path,
        base: env.GH_API_BASE || 'https://api.github.com',
        rawBase: env.GH_RAW_BASE || 'https://raw.githubusercontent.com',
        token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
        cache: 0 // إلغاء الكاش تماماً لضمان جلب أحدث البيانات فوراً
    };
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
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

// جلب أحدث نسخة مباشرة من GitHub بدون كاش
async function getFreshDbFromGithub(c) {
    const r = await fetch(contentsUrl(c, c.path) + '?ref=' + encodeURIComponent(c.branch) + '&t=' + Date.now(), {
        headers: ghHeaders(c),
        cf: { cacheTtl: 0 }
    });
    if (!r.ok) throw new Error('فشل جلب البيانات من GitHub: ' + r.status);
    const j = await r.json();
    const text = b64ToUtf8(j.content);
    return { sha: j.sha, db: normalize(JSON.parse(text)) };
}

// حفظ ذكي يعيد المحاولة تلقائياً عند وجود أي تعارض
async function saveWithAutoRetry(c, modifyFn, message) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const fresh = await getFreshDbFromGithub(c);
            const updatedDb = modifyFn(fresh.db);
            updatedDb.rev = (Number(updatedDb.rev) || 0) + 1;
            updatedDb.updatedAt = Date.now();

            const text = JSON.stringify(updatedDb);
            const body = {
                message: message || 'تحديث المواعيد',
                content: utf8ToB64(text),
                branch: c.branch,
                sha: fresh.sha
            };

            const r = await fetch(contentsUrl(c, c.path), {
                method: 'PUT',
                headers: ghHeaders(c, { 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
            });

            if (r.ok) {
                const j = await r.json();
                return { ok: true, sha: j.content.sha, rev: updatedDb.rev, db: updatedDb };
            }

            // إذا حدث تعارض ينتظر 200 ملي ثانية ويعيد المحاولة
            await new Promise(res => setTimeout(res, 200));
        } catch (e) {
            if (attempt === 4) throw e;
            await new Promise(res => setTimeout(res, 200));
        }
    }
    throw new Error('فشل الحفظ بعد عدة محاولات');
}

export default {
    async fetch(request, env) {
        const c = cfg(env);
        const url = new URL(request.url);
        const method = request.method.toUpperCase();

        if (url.pathname !== '/api/db') {
            return env.ASSETS.fetch(request);
        }

        try {
            if (method === 'GET' || method === 'HEAD') {
                const fresh = await getFreshDbFromGithub(c);
                return json({ ok: true, sha: fresh.sha, rev: fresh.db.rev, db: fresh.db });
            }

            if (method === 'POST') {
                let body = {};
                try { body = await request.json(); } catch(e) {}
                const op = url.searchParams.get('op') || '';

                if (op === 'patch') {
                    const res = await saveWithAutoRetry(c, (db) => {
                        const upserts = Array.isArray(body.upserts) ? body.upserts : [];
                        const deletes = Array.isArray(body.deletes) ? body.deletes : [];
                        const byId = {};
                        db.appointments.forEach(a => { if (a && a.id != null) byId[key(a.id)] = a; });
                        upserts.forEach(a => { if (a && a.id != null) byId[key(a.id)] = a; });
                        deletes.forEach(id => { delete byId[key(id)]; });

                        db.appointments = Object.values(byId);
                        if (Array.isArray(body.users)) db.users = body.users;
                        if (Array.isArray(body.departments)) db.departments = body.departments;
                        if (body.meta) db.meta = Object.assign({}, db.meta || {}, body.meta);
                        return db;
                    }, body.message || 'تحديث جزئي للمواعيد');

                    return json({ ok: true, sha: res.sha, rev: res.rev });
                } else {
                    const inputDb = body.db || {};
                    const res = await saveWithAutoRetry(c, (db) => {
                        const out = normalize(inputDb);
                        return out;
                    }, body.message || 'تحديث كامل للمواعيد');

                    return json({ ok: true, sha: res.sha, rev: res.rev });
                }
            }
        } catch (e) {
            return json({ ok: false, error: e.message }, 500);
        }
    }
};
