const { LIMITS, send, auth, enforced, getPlan, getUsage } = require('./_lib');

module.exports = async (req, res) => {
  const a = await auth(req);
  if (!a.ok) return send(res, 401, { error: 'login' });
  if (!enforced(a.email)) return send(res, 200, { enforced: false, plan: 0, limits: LIMITS[0], usage: { chat: 0, photo: 0, video: 0 } });
  const plan = await getPlan(a.email);
  const usage = await getUsage(a.email);
  return send(res, 200, { enforced: true, plan, limits: LIMITS[plan], usage });
};
      
