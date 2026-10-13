const { send, auth, readBody, checkQuota, countUse } = require('./_lib');

const OMNI_MODEL = process.env.OMNI_MODEL || 'gemini-omni-1.1-flash';
const GROK_VIDEO_MODEL = process.env.XAI_VIDEO_MODEL || 'grok-imagine-video-1.5';
const GBASE = 'https://generativelanguage.googleapis.com/v1beta';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const a = await auth(req);
  if (!a.ok) return send(res, 401, { error: 'login' });
  try {
    if (req.method === 'GET') return await handleGet(req, res, a);
    if (req.method === 'POST') return await handlePost(req, res, a);
    return send(res, 405, { error: 'method' });
  } catch (e) {
    return send(res, 500, { error: 'server', detail: String((e && e.message) || e) });
  }
};

/* ---------- Kreye videyo ---------- */
async function handlePost(req, res, a) {
  const b = await readBody(req);
  const prompt = String(b.prompt || '').slice(0, 2000);
  if (!prompt) return send(res, 400, { error: 'empty' });
  const q = await checkQuota(a.email, 'video', b);
  if (!q.ok) return send(res, q.status, { error: q.error });
  const m = typeof b.reference === 'string' && b.reference.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
  const dur = Math.max(1, Math.min(15, parseInt(b.duration, 10) || 5));

  if (b.model === 'grok-imagine') {
    const key = process.env.XAI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    const body = {
      model: GROK_VIDEO_MODEL,
      prompt,
      duration: dur,
      resolution: String(b.resolution) === '480' ? '480p' : '720p'
    };
    if (m) body.image = { url: b.reference };
    const r = await fetch('https://api.x.ai/v1/videos/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) return send(res, 429, { error: 'rate', detail: d });
    if (!r.ok || !d.request_id) return send(res, 502, { error: 'upstream', detail: d });
    await countUse(a.email, 'video');
    return send(res, 200, { job: d.request_id });
  }

  // Omni 1.1 Flash (Gemini)
  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 501, { error: 'no_key' });
  const resMap = { '480': '360p', '720': '720p', '1080': '1080p', '2160': '4k' };
  const text = prompt + '\n(Durée souhaitée : ' + Math.min(10, dur) + ' secondes)';
  const input = m
    ? [{ type: 'image', data: m[2], mime_type: m[1] }, { type: 'text', text }]
    : text;
  const body = {
    model: OMNI_MODEL,
    input,
    response_format: { type: 'video', resolution: resMap[String(b.resolution)] || '360p', delivery: 'uri' }
  };
  if (m) body.generation_config = { video_config: { task: 'image_to_video' } };
  const r = await fetch(GBASE + '/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000)
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) return send(res, 429, { error: 'rate', detail: d });
  if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
  const item = findVideo(d);
  if (!item) return send(res, 502, { error: 'novideo', detail: JSON.stringify(d).slice(0, 300) });
  await countUse(a.email, 'video');
  if (item.uri) {
    const id = fileId(item.uri);
    if (!id) return send(res, 502, { error: 'nouri', detail: String(item.uri).slice(0, 200) });
    return send(res, 200, { url: '/api/video?file=' + encodeURIComponent(id) });
  }
  if (item.data && item.data.length < 3.2e6) {
    return send(res, 200, { url: 'data:' + (item.mime_type || 'video/mp4') + ';base64,' + item.data });
  }
  return send(res, 502, { error: 'toolarge' });
}

function findVideo(d) {
  const steps = (d && d.steps) || [];
  for (const s of steps) {
    if (s && s.type === 'model_output') {
      const arr = Array.isArray(s.content) ? s.content : [s.content];
      for (const c of arr) if (c && c.type === 'video') return c;
    }
  }
  if (d && d.output_video) return d.output_video;
  return null;
}

function fileId(uri) {
  const mm = String(uri).match(/files\/([A-Za-z0-9_-]+)/);
  return mm ? mm[1] : null;
}

/* ---------- Gade eta / telechaje ---------- */
async function handleGet(req, res) {
  const url = new URL(req.url, 'http://x');
  const job = url.searchParams.get('job');
  const file = url.searchParams.get('file');

  if (job) {
    const key = process.env.XAI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    if (!/^[A-Za-z0-9_-]+$/.test(job)) return send(res, 400, { error: 'bad_id' });
    const r = await fetch('https://api.x.ai/v1/videos/' + job, { headers: { Authorization: 'Bearer ' + key } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: 'upstream', detail: d });
    if (d.status === 'done' && d.video && d.video.url) return send(res, 200, { url: d.video.url });
    if (d.status === 'failed' || d.status === 'expired') return send(res, 502, { error: 'failed', detail: d });
    return send(res, 200, { job, status: d.status || 'pending' });
  }

  if (file) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res, 501, { error: 'no_key' });
    if (!/^[A-Za-z0-9_-]+$/.test(file)) return send(res, 400, { error: 'bad_id' });
    for (let i = 0; i < 20; i++) {
      const s = await fetch(GBASE + '/files/' + file, { headers: { 'x-goog-api-key': key } });
      const sd = await s.json().catch(() => ({}));
      if (sd.state === 'ACTIVE' || (!sd.state && s.ok)) break;
      if (sd.state === 'FAILED' || !s.ok) return send(res, 502, { error: 'failed', detail: sd });
      await wait(2000);
    }
    const headers = { 'x-goog-api-key': key };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(GBASE + '/files/' + file + ':download?alt=media', { headers });
    if (!r.ok && r.status !== 206) return send(res, 502, { error: 'download', detail: String(r.status) });
    res.statusCode = r.status;
    res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }

  return send(res, 400, { error: 'missing' });
}
