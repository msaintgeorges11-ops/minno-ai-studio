// Fonksyon pataje: modèl yo, otantifikasyon Google, plan + limit chak jou (Redis), PayPal
const MODELS = {
  chatGemini: process.env.GEMINI_CHAT_MODEL || 'gemini-3.8-flash',
  chatGrok: process.env.GROK_CHAT_MODEL || 'grok-4',
  imageNano: process.env.NANO_BANANA_MODEL || 'gemini-3.1-flash-image',
  imageGrok: process.env.GROK_IMAGE_MODEL || 'grok-2-image'
};

// Limit chak jou pou chak plan (0 = gratis, 1 = Pro, 2 = Ultra)
const LIMITS = [
  { chat: 100, photo: 20, video: 3 },
  { chat: 2000, photo: 100, video: 10 },
  { chat: 5000, photo: 300, video: 30 }
];
// Plan minimòm pou chak kalite/rezolisyon
const MIN_PLAN = {
  photo: { std: 0, hd: 1, '2k': 2 },
  video: { '480': 0, '720': 1, '1080': 1, '2160': 2 }
};

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

// Verifye token Google. Si GOOGLE_CLIENT_ID pa defini, kite pase (mòd tès, san limit sèvè).
async function auth(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return { ok: true, email: null };
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return { ok: false };
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
    if (!r.ok) return { ok: false };
    const d = await r.json();
    if (d.aud !== clientId || !d.email) return { ok: false };
    if (d.email_verified === 'false' || d.email_verified === false) return { ok: false };
    return { ok: true, email: String(d.email).toLowerCase() };
  } catch (e) { return { ok: false }; }
}

/* ---------- Redis (Upstash / Vercel KV, via REST) ---------- */
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const hasRedis = () => !!(RURL && RTOK);

async function redis(cmd) {
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// Sèvè a aplike limit sèlman si login Google + Redis konfigire
const enforced = (email) => !!(email && hasRedis());

const today = () => new Date().toISOString().slice(0, 10);

/* ---------- PayPal ---------- */
const PP_BASE = process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

async function ppToken() {
  const id = process.env.PAYPAL_CLIENT_ID, sec = process.env.PAYPAL_SECRET;
  if (!id || !sec) throw new Error('paypal_not_configured');
  const r = await fetch(PP_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + sec).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('paypal_auth');
  return d.access_token;
}

async function ppSubscription(id) {
  const tok = await ppToken();
  const r = await fetch(PP_BASE + '/v1/billing/subscriptions/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  return r.json();
}

function planFromPaypalId(planId) {
  if (planId && planId === process.env.PAYPAL_PLAN_PRO) return 1;
  if (planId && planId === process.env.PAYPAL_PLAN_ULTRA) return 2;
  return 0;
}

// Abònman an toujou valab? (ACTIVE, oswa anile men peryòd peye a poko fini)
function subValid(s) {
  if (!s) return false;
  if (s.status === 'ACTIVE') return true;
  if (s.status === 'CANCELLED' || s.status === 'SUSPENDED') {
    const bi = s.billing_info || {};
    const next = bi.next_billing_time && Date.parse(bi.next_billing_time);
    if (next && next > Date.now()) return true;
    const last = bi.last_payment && bi.last_payment.time && Date.parse(bi.last_payment.time);
    if (last && last + 31 * 864e5 > Date.now()) return true;
  }
  return false;
}

// Retounen plan itilizatè a (re-verifye ak PayPal chak 6 èdtan)
async function getPlan(email) {
  if (!enforced(email)) return 0;
  let rec = null;
  try { const v = await redis(['GET', 'plan:' + email]); rec = v ? JSON.parse(v) : null; } catch (e) { return 0; }
  if (!rec || !rec.sub) return 0;
  if (Date.now() - (rec.checked || 0) > 6 * 3600e3) {
    try {
      const s = await ppSubscription(rec.sub);
      const p = s && subValid(s) ? planFromPaypalId(s.plan_id) : 0;
      rec.plan = p; rec.checked = Date.now();
      await redis(['SET', 'plan:' + email, JSON.stringify(rec)]);
    } catch (e) { /* si PayPal pa reponn, kenbe dènye plan konnen an */ }
  }
  return rec.plan | 0;
}

async function getUsage(email) {
  const d = today();
  const out = {};
  for (const k of ['chat', 'photo', 'video']) {
    try { out[k] = parseInt(await redis(['GET', 'u:' + email + ':' + k + ':' + d]), 10) || 0; } catch (e) { out[k] = 0; }
  }
  return out;
}

// Tcheke plan + limit + kalite avan yon apèl. Retounen {ok, status, error, plan}
async function checkQuota(email, kind, b) {
  if (!enforced(email)) return { ok: true, plan: 0, enforced: false };
  const plan = await getPlan(email);
  const q = kind === 'photo' ? MIN_PLAN.photo[b.quality || 'std'] : kind === 'video' ? MIN_PLAN.video[String(b.resolution || '480')] : 0;
  if (q === undefined) return { ok: false, status: 400, error: 'bad_option' };
  if (q > plan) return { ok: false, status: 403, error: 'locked' };
  const u = await getUsage(email);
  if (u[kind] >= LIMITS[plan][kind]) return { ok: false, status: 429, error: 'limit' };
  return { ok: true, plan, enforced: true };
}

async function countUse(email, kind) {
  if (!enforced(email)) return;
  const key = 'u:' + email + ':' + kind + ':' + today();
  try { await redis(['INCR', key]); await redis(['EXPIRE', key, 172800]); } catch (e) { /* ignore */ }
}

module.exports = { MODELS, LIMITS, send, auth, readBody, redis, enforced, getPlan, getUsage, checkQuota, countUse, ppSubscription, subValid, planFromPaypalId };
