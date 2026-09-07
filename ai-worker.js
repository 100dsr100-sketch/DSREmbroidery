/* DSR Embroidery – AI render proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Turns the app's framed photo into an "embroidery" render.
 * Tries, in order:
 *   1. Cloudflare Workers AI img2img  (needs an "AI" binding + model access)
 *   2. Pollinations Flux img2img      (keyless, no account – with one retry)
 *
 * DEPLOY
 *   1. Edit code: paste this whole file over what's there, Deploy.
 *   2. Bindings tab -> Add binding -> "Workers AI", Variable name: AI
 *      (still worth adding even if the models are blocked – harmless).
 *   3. Copy the Worker URL into the app (Embroidery -> "AI URL").
 *
 * Optional Worker variables (Settings -> Variables, type Text):
 *   AI_MODEL     force one Workers-AI model instead of the list below
 *   AI_STRENGTH  0-1, default 0.6
 *   AI_STEPS     default 20
 *   NO_POLLINATIONS  "1" disables the keyless fallback
 *   ALLOWED_ORIGINS  e.g. https://100dsr100-sketch.github.io,http://localhost
 * ---------------------------------------------------------------------------
 */

// [model, how to pass the source image]
const CF_MODELS = [
  ['@cf/lykon/dreamshaper-8-lcm', 'b64'],
  ['@cf/runwayml/stable-diffusion-v1-5-img2img', 'arr']
];

const PROMPT =
  'hand embroidered thread portrait, dense long-and-short and satin stitches following the ' +
  'contours, individual embroidery floss strands and needle texture visible, soft sheen of ' +
  'stranded cotton, fine stitch shadows, mounted on dark textured linen with a clean stitched ' +
  'outline, macro photo of finished hoop art, highly detailed';
const NEG = 'blurry, smooth, plastic, 3d render, cartoon, flat vector, text, watermark, frame, low detail';

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
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function toBuf(out) {
  if (out instanceof ReadableStream) return await new Response(out).arrayBuffer();
  if (out instanceof ArrayBuffer) return out;
  if (out && typeof out.image === 'string') return bytesFromB64(out.image.replace(/^data:[^,]+,/, '')).buffer;
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (request.method === 'GET' && url.pathname.startsWith('/_img/')) {
      const hit = await caches.default.match(new Request(url.origin + url.pathname));
      return hit || new Response('gone', { status: 404 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'POST') return json({ error: 'POST an image.' }, 405, ch);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON body.' }, 400, ch); }
    let data = body.image || '';
    const m = /^data:[^;]+;base64,(.*)$/s.exec(data);
    if (m) data = m[1];
    if (!data || data.length < 100) return json({ error: 'No image supplied.' }, 400, ch);
    let src;
    try { src = bytesFromB64(data); } catch (e) { return json({ error: 'Image was not valid base64.' }, 400, ch); }

    const strength = Math.max(0.1, Math.min(0.95, parseFloat(body.strength || env.AI_STRENGTH || '0.6')));
    const steps = Math.max(5, Math.min(30, parseInt(body.steps || env.AI_STEPS || '20', 10)));
    const prompt = PROMPT + (body.extra ? ', ' + body.extra : '');
    const errs = [];

    // ---- 1. Cloudflare Workers AI ----
    if (env.AI) {
      const list = (body.model || env.AI_MODEL) ? [[body.model || env.AI_MODEL, 'b64']] : CF_MODELS;
      for (const [model, how] of list) {
        const inp = { prompt, negative_prompt: NEG, strength, guidance: 7.5, num_steps: steps };
        if (how === 'b64') inp.image_b64 = data; else inp.image = [...src];
        try {
          const buf = await toBuf(await env.AI.run(model, inp));
          if (buf && buf.byteLength > 500) return json({ image: b64FromBuf(buf), mime: 'image/png', model }, 200, ch);
          errs.push(model + ': empty');
        } catch (e) {
          const msg = (e && (e.message || e.toString())) || 'unknown';
          if (/\bdaily\b|neuron|\bquota\b/i.test(msg) && !/not allowed|5018/i.test(msg)) {
            return json({ error: 'Cloudflare AI daily free limit reached – try again tomorrow.', model }, 502, ch);
          }
          errs.push(model + ': ' + msg);
        }
      }
    } else {
      errs.push('no AI binding');
    }

    // ---- 2. Pollinations (keyless), one retry on 429/5xx ----
    if (env.NO_POLLINATIONS !== '1') {
      const id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '' + Math.random());
      const stashUrl = url.origin + '/_img/' + id + '.jpg';
      await caches.default.put(new Request(stashUrl), new Response(src, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' }
      }));
      // fresh seed + nonce so Pollinations can't hand back a cached generation
      const seed = Math.floor(Math.random() * 2147483647);
      const p = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
        '?width=768&height=768&nologo=true&nofeed=true&safe=false&model=flux&seed=' + seed +
        '&strength=' + strength + '&image=' + encodeURIComponent(stashUrl) + '&_=' + seed;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const pr = await fetch(p, { headers: { Accept: 'image/*' } });
          const ctype = pr.headers.get('content-type') || '';
          if (pr.ok && ctype.startsWith('image')) {
            const buf = await pr.arrayBuffer();
            if (buf.byteLength > 500) return json({ image: b64FromBuf(buf), mime: ctype, model: 'pollinations/flux' }, 200, ch);
            errs.push('pollinations: tiny response');
            break;
          }
          const txt = (await pr.text()).slice(0, 160);
          errs.push('pollinations: HTTP ' + pr.status + ' ' + txt);
          if ((pr.status === 429 || pr.status >= 500) && attempt < 2) { await sleep(12000); continue; }
          break;
        } catch (e) {
          errs.push('pollinations: ' + ((e && e.message) || e));
          if (attempt < 2) { await sleep(8000); continue; }
          break;
        }
      }
    }

    return json({ error: 'All render backends failed.', tried: errs }, 502, ch);
  }
};
