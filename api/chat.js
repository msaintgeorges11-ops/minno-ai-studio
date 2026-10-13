const { MODELS, send, auth, readBody, checkQuota, countUse } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const a = await auth(req);
  if (!a.ok) return send(res, 401, { error: 'login' });
  const b = await readBody(req);
  const q = await checkQuota(a.email, 'chat', b);
  if (!q.ok) return send(res, q.status, { error: q.error });
  const ok = async (obj) => { await countUse(a.email, 'chat'); return send(res, 200, obj); };
  const lang = { fr: 'français', ht: 'kreyòl ayisyen', en: 'English', es: 'español' }[b.lang] || 'français';
  let sys = "Tu es MINNO AI, un assistant utile et amical. Réponds toujours dans la langue utilisée par l'utilisateur dans son dernier message (français, kreyòl ayisyen, English, español ou toute autre langue). Langue par défaut : " + lang + '.';
  if (b.instructions) sys += '\nInstructions de l\'utilisateur : ' + String(b.instructions).slice(0, 1000);
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 8000) }))
    .filter(m => m.content);
  if (!msgs.length) return send(res, 400, { error: 'empty' });

  try {
    if (b.model === 'grok') {
      const key = process.env.XAI_API_KEY;
      if (!key) return send(res, 501, { error: 'no_key' });
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: MODELS.chatGrok, messages: [{ role: 'system', content: sys }, ...msgs] })
      });
      const d = await r.json();
      if (r.status === 429) return send(res, 429, { error: 'rate' });
      if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
      return ok({ text: (d.choices && d.choices[0] && d.choices[0].message.content) || '' });
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODELS.chatGemini + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      })
    });
    const d = await r.json();
    if (r.status === 429) return send(res, 429, { error: 'rate' });
    if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return ok({ text: parts.map(p => p.text || '').join('') });
  } catch (e) {
    return send(res, 500, { error: 'server', detail: String((e && e.message) || e) });
  }
};
