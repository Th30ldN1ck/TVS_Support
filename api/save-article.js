// Vercel Node.js serverless function.
// Support-team CMS writes go through here rather than touching GitHub directly:
// this is the one place that holds the GitHub token and checks the CMS password.
//
// POST body shapes:
//   Save/update: { password, slug, article: { title, category, catSlug, body, related? } }
//   Delete:      { password, deleteSlug }
//
// On success, commits the updated articles.json straight to the repo's default
// branch. Vercel is already wired to auto-deploy on push, so a save here goes
// live within about a minute — no separate deploy step.

const OWNER = 'Th30ldN1ck';
const REPO = 'TVS_Support';
const BRANCH = 'main';
const FILE_PATH = 'articles.json';
const KNOWN_CAT_SLUGS = ['account', 'streaming', 'devices', 'plans', 'parental', 'downloads'];

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

  const isDelete = !!body.deleteSlug;
  const targetSlug = isDelete ? body.deleteSlug : body.slug;

  if (!targetSlug || typeof targetSlug !== 'string' || !/^[a-z0-9-]+$/.test(targetSlug)) {
    response.status(400).json({ error: 'Missing or invalid slug (lowercase letters, numbers, hyphens only)' });
    return;
  }

  let article = null;
  if (!isDelete) {
    article = body.article;
    if (!article || typeof article !== 'object') {
      response.status(400).json({ error: 'Missing article data' });
      return;
    }
    for (const field of ['title', 'category', 'catSlug', 'body']) {
      if (!article[field] || typeof article[field] !== 'string') {
        response.status(400).json({ error: 'Missing or invalid field: ' + field });
        return;
      }
    }
    if (KNOWN_CAT_SLUGS.indexOf(article.catSlug) === -1) {
      response.status(400).json({ error: 'catSlug must be one of: ' + KNOWN_CAT_SLUGS.join(', ') });
      return;
    }
    if (article.related !== undefined && !Array.isArray(article.related)) {
      response.status(400).json({ error: 'related must be an array of slugs' });
      return;
    }
  }

  const apiBase = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH;
  const ghHeaders = {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tvn-support-cms',
  };

  try {
    const getResp = await fetch(apiBase + '?ref=' + BRANCH, { headers: ghHeaders });
    if (!getResp.ok) {
      const t = await getResp.text();
      throw new Error('GitHub read failed (' + getResp.status + '): ' + t.slice(0, 300));
    }
    const getData = await getResp.json();
    const currentJson = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    let action;
    if (isDelete) {
      if (!(targetSlug in currentJson)) {
        response.status(404).json({ error: 'Article not found: ' + targetSlug });
        return;
      }
      delete currentJson[targetSlug];
      action = 'delete';
    } else {
      action = targetSlug in currentJson ? 'update' : 'add';
      currentJson[targetSlug] = {
        title: article.title,
        category: article.category,
        catSlug: article.catSlug,
        updated: new Date().toISOString().slice(0, 10),
        body: article.body,
        related: Array.isArray(article.related) ? article.related : [],
      };
    }

    const newContent = Buffer.from(JSON.stringify(currentJson, null, 1), 'utf-8').toString('base64');
    const commitMessage = 'CMS: ' + action + ' article "' + targetSlug + '"';

    const putResp = await fetch(apiBase, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders),
      body: JSON.stringify({
        message: commitMessage,
        content: newContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putResp.ok) {
      const t = await putResp.text();
      throw new Error('GitHub write failed (' + putResp.status + '): ' + t.slice(0, 300));
    }

    response.status(200).json({ ok: true, slug: targetSlug, action: action });
  } catch (err) {
    console.error('save-article error:', err);
    response.status(500).json({ error: err.message || 'Unknown server error' });
  }
};
