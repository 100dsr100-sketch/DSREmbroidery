/* DSR Embroidery – AI render proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Turns the app's framed photo into an "embroidery" render using Cloudflare
 * Workers AI (Stable Diffusion img2img). Free daily allowance, no API key.
 *
 * DEPLOY
 *   1. dash.cloudflare.com -> Compute -> Workers & Pages -> your Worker.
 *   2. Edit code: paste this whole file over what's there, Deploy.
 *   3. Bindings tab -> Add binding -> "Workers AI"
 *        Variable name:  AI          (exactly this)      -> Add Binding.
 *      (You can delete the old GEMINI_API_KEY / GEMINI_MODEL variables.)
 *   4. Copy the Worker URL and paste it into the app (Embroidery -> "AI URL").
 *
 * Optional Worker variables (Settings -> Variables, type Text):
 *   AI_MODEL     force one model instead of auto-picking from the list below
 *   AI_STRENGTH  0-1, default 0.62  (lower = closer to the photo, higher = more stylised)
 *   AI_STEPS     default 20
 *   ALLOWED_ORIGINS  e.g. https://100dsr100-sketch.github.io,http://localhost
 * ---------------------------------------------------------------------------
 */

// img2img-capable models, tried in order until the account is allowed one.
const MODELS = [
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/lykon/dreamshaper-8-lcm',
  '@cf/runwayml/stable-diffusion-v1-5-img2img',
  '@cf/bytedance/stable-diffusion-xl-lightning'
];

const PROMPT =
  'hand embroidered thread portrait, dense long-and-short and satin stitches following the ' +
  'contours, individual embroidery floss strands and needle texture clearly visible, soft ' +
  'sheen of stranded cotton, fine stitch shadows and slight relief, mounted on dark textured ' +
  'linen with a clean stitched outline, macro photograph of finished hoop art, highly detailed';

const NEG =
  'blurry, smooth, plastic, 3d render, cartoon, flat vector, text, watermark, signature, frame, low detail';

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
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function b64FromBuf(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) s += String.fromCharCode.apply(null, b.subarray(i, i + chunk));
  return btoa(s);
}
async function toBuf(out) {
  if (out instanceof ReadableStream) return await new Response(out).arrayBuffer();
  if (out instanceof ArrayBuffer) return out;
  if (out && typeof out.image === 'string') return bytesFromB64(out.image.replace(/^data:[^,]+,/, '')).buffer;
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'POST') return json({ error: 'POST an image.' }, 405, ch);
    if (!env.AI) return json({ error: 'Worker has no "AI" binding. Bindings tab -> Add binding -> Workers AI, name it AI.' }, 500, ch);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON body.' }, 400, ch); }

    let data = body.image || '';
    const m = /^data:[^;]+;base64,(.*)$/s.exec(data);
    if (m) data = m[1];
    if (!data || data.length < 100) return json({ error: 'No image supplied.' }, 400, ch);

    let src;
    try { src = bytesFromB64(data); } catch (e) { return json({ error: 'Image was not valid base64.' }, 400, ch); }
    const imgArr = [...src];

    const strength = Math.max(0.1, Math.min(0.95, parseFloat(body.strength || env.AI_STRENGTH || '0.62')));
    const steps = Math.max(5, Math.min(30, parseInt(body.steps || env.AI_STEPS || '20', 10)));
    const prompt = PROMPT + (body.extra ? ', ' + body.extra : '');
    const list = (body.model || env.AI_MODEL) ? [body.model || env.AI_MODEL] : MODELS;

    const inputs = {
      prompt,
      negative_prompt: NEG,
      image: imgArr,
      image_b64: data,
      strength,
      guidance: 7.5,
      num_steps: steps
    };

    let lastErr = '';
    for (const model of list) {
      try {
        const out = await env.AI.run(model, inputs);
        const buf = await toBuf(out);
        if (buf && buf.byteLength > 500) {
          return json({ image: b64FromBuf(buf), mime: 'image/png', model }, 200, ch);
        }
        lastErr = model + ': empty result';
      } catch (e) {
        const msg = (e && (e.message || e.toString())) || 'unknown';
        if (/quota|neuron|\b(limit|exceed)/i.test(msg) && !/not allowed|5018/i.test(msg)) {
          return json({ error: 'Cloudflare AI daily free limit reached – try again tomorrow.', model }, 502, ch);
        }
        lastErr = model + ' -> ' + msg;
        // try the next model
      }
    }
    return json({ error: 'No usable Workers AI image model for this account. Last: ' + lastErr }, 502, ch);
  }
};
