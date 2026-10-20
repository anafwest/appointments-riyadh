export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/whatsapp' && request.method === 'POST') {
            return handleWhatsApp(request);
        }
        return env.ASSETS.fetch(request);
    }
};

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
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
    if (!/^\+[0-9]{8,15}$/.test(from)) return json({ ok: false, error: 'رقم مرسل غير صالح: ' + from }, 400);
    if (!msg) return json({ ok: false, error: 'نص الرسالة فارغ' }, 400);

    const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + btoa(sid + ':' + token),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: to, From: from, Body: msg }).toString()
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
        return json({ ok: false, error: data && data.message ? data.message : ('HTTP ' + res.status) });
    }
    return json({ ok: true, sid: data && data.sid ? data.sid : '' });
}
