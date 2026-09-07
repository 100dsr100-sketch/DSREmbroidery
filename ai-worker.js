/* DSR Embroidery – AI render proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Turns the app's framed photo into an "embroidery" render using Cloudflare
 * Workers AI (Stable Diffusion img2img). Free daily allowance, no API key.
 *
 * DEPLOY
 *   1. dash.cloudflare.com -> Compute -> Workers & Pages -> your Worker.
 *   2. Edit code: paste this whole file over what's there, Deploy.
 *   3. Settings -> Bindings -> Add -> "Workers AI"
 *        Variable name:  AI          (exactly this)      -> Save / Deploy.
 *      (You can delete the old GEMINI_API_KEY / GEMINI_MODEL variables.)
 *   4. Copy the Worker URL and paste it into the app:
 *        Embroidery mode -> "AI URL".
 *
 * Optional Worker variables (Settings -> Variables, type Text):
 *   AI_MODEL     default @cf/runwayml/stable-diffusion-v1-5-img2img
 *   AI_STRENGTH  0-1, default 0.62  (lower = closer to the photo, higher = more stylised)
 *   AI_STEPS     default 20
 *   ALLOWED_ORIGINS  e.g. https://100dsr100-sketch.github.io,http://localhost
 * ---------------------------------------------------------------------------
 */

const DEFAULT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'POST') return json({ error: 'POST an image.' }, 405, ch);
    if (!env.AI) return json({ error: 'Worker has no "AI" binding. Settings -> Bindings -> Add -> Workers AI, name it AI.' }, 500, ch);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON body.' }, 400, ch); }

    let data = body.image || '';
    const m = /^data:[^;]+;base64,(.*)$/s.exec(data);
    if (m) data = m[1];
    if (!data || data.length < 100) return json({ error: 'No image supplied.' }, 400, ch);

    let src;
    try { src = bytesFromB64(data); } catch (e) { return json({ error: 'Image was not valid base64.' }, 400, ch); }

    const model = body.model || env.AI_MODEL || DEFAULT_MODEL;
    const strength = Math.max(0.1, Math.min(0.95, parseFloat(body.strength || env.AI_STRENGTH || '0.62')));
    const steps = Math.max(5, Math.min(30, parseInt(body.steps || env.AI_STEPS || '20', 10)));
    const prompt = PROMPT + (body.extra ? ', ' + body.extra : '');

    let out;
    try {
      out = await env.AI.run(model, {
        prompt,
        negative_prompt: NEG,
        image: [...src],
        strength,
        guidance: 7.5,
        num_steps: steps
      });
    } catch (e) {
      const msg = (e && (e.message || e.toString())) || 'unknown';
      const daily = /quota|neuron|limit|exceed/i.test(msg);
      return json({ error: (daily ? 'Cloudflare AI daily free limit reached – try again tomorrow. ' : 'Workers AI error: ') + msg, model }, 502, ch);
    }

    let buf;
    if (out instanceof ReadableStream) buf = await new Response(out).arrayBuffer();
    else if (out instanceof ArrayBuffer) buf = out;
    else if (out && out.image) {
      // some models return { image: "<base64>" }
      return json({ image: String(out.image).replace(/^data:[^,]+,/, ''), mime: 'image/png', model }, 200, ch);
    } else {
      return json({ error: 'Workers AI returned an unexpected result.', model }, 502, ch);
    }
    return json({ image: b64FromBuf(buf), mime: 'image/png', model }, 200, ch);
  }
};
