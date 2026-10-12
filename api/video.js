const { send, auth } = require('./_lib');

// Videyo poko konekte ak yon sèvis. Isit la w ap ajoute apèl Omni / Grok Imagine Video
// lè ou gen aksè API. Pou kounye a li retounen 501.
module.exports = async (req, res) => {
  const a = await auth(req);
  if (!a.ok) return send(res, 401, { error: 'login' });
  return send(res, 501, { error: 'Videyo a poko konekte ak yon sèvis' });
};
