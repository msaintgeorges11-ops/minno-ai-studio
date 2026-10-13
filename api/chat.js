const { MODELS, send, auth, readBody, checkQuota, countUse } = require('./_lib');


// Li yon repons SSE (data: {...}) epi voye chak mòso tèks bay kliyan an
async function pipeSSE(r, res, pick) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const t = pick(JSON.parse(data));
        if (t) { total += t.length; res.write(t); }
      } catch (e) { /* liy ki pa JSON, inyore */ }
    }
  }
  return total;
}

function startStream(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
}

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
        body: JSON.stringify(Object.assign({ model: MODELS.chatGrok, messages: [{ role: 'system', content: sys }, ...msgs] }, b.stream ? { stream: true } : {}))
      });
      if (b.stream && r.ok && r.body) {
        startStream(res);
        try { await pipeSSE(r, res, (j) => j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content); }
        catch (e) { res.write('\u0001ERR:' + String((e && e.message) || e)); }
        await countUse(a.email, 'chat');
        return res.end();
      }
      const d = await r.json();
      if (r.status === 429) return send(res, 429, { error: 'rate', detail: d });
      if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
      return ok({ text: (d.choices && d.choices[0] && d.choices[0].message.content) || '' });
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODELS.chatGemini + (b.stream ? ':streamGenerateContent?alt=sse' : ':generateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      })
    });
    if (b.stream && r.ok && r.body) {
      startStream(res);
      try {
        await pipeSSE(r, res, (j) => {
          const ps = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
          return ps.map(p => p.text || '').join('');
        });
      } catch (e) { res.write('\u0001ERR:' + String((e && e.message) || e)); }
      await countUse(a.email, 'chat');
      return res.end();
    }
    const d = await r.json();
    if (r.status === 429) return send(res, 429, { error: 'rate', detail: d });
    if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return ok({ text: parts.map(p => p.text || '').join('') });
  } catch (e) {
    return send(res, 500, { error: 'server', detail: String((e && e.message) || e) });
  }
};
