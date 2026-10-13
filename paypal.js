const { send, auth, readBody, redis, enforced, ppSubscription, subValid, planFromPaypalId } = require('./_lib');

// Kliyan an voye subscriptionID apre li fin apwouve sou PayPal. Nou verifye l ak PayPal dirèkteman.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const a = await auth(req);
  if (!a.ok || !a.email) return send(res, 401, { error: 'login' });
  if (!enforced(a.email)) return send(res, 501, { error: 'no_db' });
  const b = await readBody(req);
  const id = String(b.subscriptionID || '').slice(0, 64);
  if (!/^[A-Za-z0-9-]+$/.test(id)) return send(res, 400, { error: 'bad_id' });
  try {
    const s = await ppSubscription(id);
    if (!s) return send(res, 400, { error: 'not_found' });
    const plan = planFromPaypalId(s.plan_id);
    if (!plan || s.status !== 'ACTIVE') return send(res, 402, { error: 'not_active' });
    // Yon abònman ka sèvi pou yon sèl kont
    const ok = await redis(['SET', 'sub:' + id, a.email, 'NX']);
    if (!ok) {
      const owner = await redis(['GET', 'sub:' + id]);
      if (owner !== a.email) return send(res, 409, { error: 'already_used' });
    }
    await redis(['SET', 'plan:' + a.email, JSON.stringify({ plan, sub: id, checked: Date.now() })]);
    return send(res, 200, { plan });
  } catch (e) {
    return send(res, 500, { error: 'server' });
  }
};
