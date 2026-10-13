const { MODELS, send, auth, readBody, checkQuota, countUse } = require('./_lib');

const RATIOS = ['1:1', '16:9', '9:16', '4:3'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const a = await auth(req);
  if (!a.ok) return send(res, 401, { error: 'login' });
  const b = await readBody(req);
  const q = await checkQuota(a.email, 'photo', b);
  if (!q.ok) return send(res, q.status, { error: q.error });
  const ok = async (obj) => { await countUse(a.email, 'photo'); return send(res, 200, obj); };
  const prompt = String(b.prompt || '').slice(0, 4000);
  if (!prompt) return send(res, 400, { error: 'empty' });
  const ratio = RATIOS.includes(b.ratio) ? b.ratio : '1:1';

  try {
    if (b.model === 'grok-imagine') {
      const key = process.env.XAI_API_KEY;
      if (!key) return send(res, 501, { error: 'no_key' });
      const r = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: MODELS.imageGrok, prompt, n: 1, response_format: 'b64_json' })
      });
      const d = await r.json();
      if (r.status === 429) return send(res, 429, { error: 'rate' });
      if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
      const img = d.data && d.data[0] && d.data[0].b64_json;
      if (!img) return send(res, 502, { error: 'noimage' });
      return ok({ image: 'data:image/png;base64,' + img });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    const parts = [{ text: prompt }];
    const m = typeof b.reference === 'string' && b.reference.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    const call = (withCfg) => fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODELS.imageNano + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: Object.assign({ responseModalities: ['TEXT', 'IMAGE'] },
          withCfg ? { imageConfig: { aspectRatio: ratio } } : {})
      })
    });
    let r = await call(true);
    if (r.status === 400) r = await call(false);
    const d = await r.json();
    if (r.status === 429) return send(res, 429, { error: 'rate' });
    if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
    const ps = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const ip = ps.find(p => p.inlineData || p.inline_data);
    const idata = ip && (ip.inlineData || ip.inline_data);
    if (!idata) return send(res, 502, { error: 'noimage' });
    return ok({ image: 'data:' + (idata.mimeType || idata.mime_type || 'image/png') + ';base64,' + idata.data });
  } catch (e) {
    return send(res, 500, { error: 'server', detail: String((e && e.message) || e) });
  }
};
