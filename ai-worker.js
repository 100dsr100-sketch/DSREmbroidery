/* DSR Embroidery – AI render proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Turns the app's framed photo into a realistic "finished embroidery" image
 * using Google's Gemini image model ("Nano Banana"). The API key lives here
 * as a Worker secret so it is never exposed in the app.
 *
 * DEPLOY
 *   1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create  ->  Worker
 *      Name it e.g.  dsr-embroidery-ai   ->  Deploy  ->  Edit code
 *   2. Paste this whole file over the sample, Deploy.
 *   3. Worker  ->  Settings  ->  Variables and Secrets:
 *        Add secret   GEMINI_API_KEY   = <your key from https://aistudio.google.com/apikey>
 *        (optional)   GEMINI_MODEL     = gemini-3.1-flash-lite-image     (default if unset)
 *        (optional)   ALLOWED_ORIGINS  = https://100dsr100-sketch.github.io,http://localhost
 *   4. Copy the Worker URL (…​.workers.dev) and paste it into the app:
 *        Embroidery mode  ->  "AI render service URL".
 * ---------------------------------------------------------------------------
 */

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-image';

const PROMPT =
  'Reproduce this photograph as a hyper-realistic hand-embroidered thread portrait, ' +
  'as if photographed close up after being finished. Dense directional thread painting: ' +
  'long-and-short and satin stitches that follow the fur, hair and contours; individual ' +
  'floss strands and needle texture clearly visible; soft sheen of stranded cotton; fine ' +
  'stitch shadows and slight relief. Mount it on dark textured linen with a clean stitched ' +
  'outline around the subject. Keep the exact likeness, pose, colours, framing and ' +
  'composition of the original. Photorealistic result, no added text, no watermark, no border.';

function cors(origin, allowed) {
  const ok = !allowed.length || allowed.includes('*') || allowed.some(a => origin && origin.startsWith(a));
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

// Pull the first base64 image blob out of whatever shape the API returns.
function findImage(node, depth) {
  if (!node || depth > 8) return null;
  if (typeof node === 'string') {
    return node.length > 4000 && /^[A-Za-z0-9+/=\s]+$/.test(node.slice(0, 200)) ? node.replace(/\s+/g, '') : null;
  }
  if (Array.isArray(node)) {
    for (const v of node) { const r = findImage(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node === 'object') {
    // common explicit spots first
    const direct = node.data || (node.inlineData && node.inlineData.data) ||
      (node.inline_data && node.inline_data.data) ||
      (node.output_image && node.output_image.data);
    if (typeof direct === 'string' && direct.length > 4000) return direct.replace(/\s+/g, '');
    for (const k of Object.keys(node)) { const r = findImage(node[k], depth + 1); if (r) return r; }
  }
  return null;
}

async function callGemini(key, model, mime, b64, extra) {
  const text = PROMPT + (extra ? ' ' + extra : '');

  // 1) new Interactions API
  let res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        { type: 'text', text },
        { type: 'image', mime_type: mime, data: b64 }
      ]
    })
  });
  if (res.ok) {
    const img = findImage(await res.json(), 0);
    if (img) return { img };
  }
  const firstErr = res.ok ? 'no image in response' : (await res.text()).slice(0, 500);

  // 2) classic generateContent
  res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
    ':generateContent?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text },
          { inline_data: { mime_type: mime, data: b64 } }
        ] }],
        generationConfig: { responseModalities: ['IMAGE'] }
      })
    }
  );
  if (res.ok) {
    const img = findImage(await res.json(), 0);
    if (img) return { img };
    return { error: 'Model returned no image (generateContent).' };
  }
  return { error: 'Gemini error. interactions: ' + firstErr + ' | generateContent: ' + (await res.text()).slice(0, 500) };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'POST') return json({ error: 'POST an image.' }, 405, ch);
    if (!env.GEMINI_API_KEY) return json({ error: 'Worker missing GEMINI_API_KEY secret.' }, 500, ch);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON body.' }, 400, ch); }

    let data = body.image || '';
    let mime = body.mime || 'image/jpeg';
    const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
    if (m) { mime = m[1]; data = m[2]; }
    if (!data || data.length < 100) return json({ error: 'No image supplied.' }, 400, ch);
    if (data.length > 9 * 1024 * 1024) return json({ error: 'Image too large – send <= ~6 MP JPEG.' }, 413, ch);

    const model = body.model || env.GEMINI_MODEL || DEFAULT_MODEL;

    let out;
    try {
      out = await callGemini(env.GEMINI_API_KEY, model, mime, data, body.extra || '');
    } catch (e) {
      return json({ error: 'Request failed: ' + (e && e.message || e) }, 502, ch);
    }
    if (out.error) return json({ error: out.error, model }, 502, ch);
    return json({ image: out.img, mime: 'image/png', model }, 200, ch);
  }
};
