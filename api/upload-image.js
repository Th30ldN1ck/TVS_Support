// Vercel Node.js serverless function.
// Handles image uploads from the CMS's Image block. Same trust boundary as
// save-article.js — password-gated, holds the GitHub token — but writes to
// a new file under uploads/ instead of updating articles.json.
//
// POST body: { password, filename, dataUrl }
//   dataUrl is a data: URL as produced by FileReader.readAsDataURL() on the
//   client (e.g. "data:image/png;base64,iVBOR...").
//
// On success, commits the image straight to the repo's default branch and
// returns its relative path (e.g. "uploads/1721_cover.png"), which becomes
// live at that path once Vercel's auto-deploy picks up the commit.

const OWNER = 'Th30ldN1ck';
const REPO = 'TVS_Support';
const BRANCH = 'main';
const UPLOAD_DIR = 'uploads';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB decoded (~2.7MB as base64) — Vercel's serverless body limit is ~4.5MB
const ALLOWED_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = request.body;
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    response.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  body = body || {};

  if (!process.env.CMS_PASSWORD) {
    response.status(500).json({ error: 'Server not configured (missing CMS_PASSWORD)' });
    return;
  }
  if (!body.password || body.password !== process.env.CMS_PASSWORD) {
    response.status(401).json({ error: 'Incorrect password' });
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    response.status(500).json({ error: 'Server not configured (missing GITHUB_TOKEN)' });
    return;
  }

  const dataUrl = body.dataUrl;
  if (!dataUrl || typeof dataUrl !== 'string') {
    response.status(400).json({ error: 'Missing image data' });
    return;
  }
  const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    response.status(400).json({ error: 'Malformed image data URL' });
    return;
  }
  const mime = match[1];
  const base64Data = match[2];
  const ext = ALLOWED_MIME_EXT[mime];
  if (!ext) {
    response.status(400).json({ error: 'Unsupported image type: ' + mime + ' (use PNG, JPEG, GIF, or WebP)' });
    return;
  }

  const approxBytes = Math.ceil((base64Data.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    response.status(400).json({ error: 'Image is too large (max 3MB)' });
    return;
  }

  var rawName = (typeof body.filename === 'string' && body.filename) ? body.filename : 'image';
  var safeName = rawName.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  var finalPath = UPLOAD_DIR + '/' + Date.now() + '-' + safeName + '.' + ext;

  const apiBase = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + finalPath;
  const ghHeaders = {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tvn-support-cms',
  };

  try {
    const putResp = await fetch(apiBase, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders),
      body: JSON.stringify({
        message: 'CMS: upload image "' + finalPath + '"',
        content: base64Data,
        branch: BRANCH,
      }),
    });

    if (!putResp.ok) {
      const t = await putResp.text();
      throw new Error('GitHub write failed (' + putResp.status + '): ' + t.slice(0, 300));
    }

    response.status(200).json({ ok: true, path: finalPath });
  } catch (err) {
    console.error('upload-image error:', err);
    response.status(500).json({ error: err.message || 'Unknown server error' });
  }
};
