/* DSR Embroidery – AI render proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Turns the app's framed photo into an "embroidery" render.
 * Tries, in order (first one that's configured + works wins):
 *   1. Google Gemini "Nano Banana"   (needs GEMINI_API_KEY + billing enabled)
 *   2. Leonardo.ai image-to-image   (needs LEONARDO_API_KEY)
 *   3. Hugging Face image-to-image  (needs HF_TOKEN)
 *   4. Cloudflare Workers AI img2img(needs an "AI" binding)
 *   5. Pollinations                 (keyless, text-driven)
 *
 * DEPLOY
 *   1. Edit code: paste this whole file over what's there, Deploy.
 *   2. Settings -> Variables and Secrets -> Add (type Secret):
 *        LEONARDO_API_KEY = key from  app.leonardo.ai -> API Access -> Create Key
 *      (optional) HF_TOKEN = a Hugging Face fine-grained inference token
 *   3. (optional) Bindings tab -> Add binding -> Workers AI, name it AI.
 *   4. Copy the Worker URL into the app (Embroidery -> "AI URL").
 *
 * Optional Worker variables (Settings -> Variables, type Text):
 *   LEONARDO_MODEL   force a Leonardo model id (else it auto-picks an SDXL one)
 *   LEONARDO_STRENGTH  init_strength 0.1-0.9, default 0.35 (lower = closer to photo)
 *   HF_MODEL / AI_MODEL / AI_STRENGTH (0.6) / AI_STEPS (20)
 *   NO_POLLINATIONS  "1" disables the keyless fallback
 *   ALLOWED_ORIGINS  e.g. https://100dsr100-sketch.github.io,http://localhost
 * ---------------------------------------------------------------------------
 */

const LEO = 'https://cloud.leonardo.ai/api/rest/v1';
const LEO_MODELS_FALLBACK = [
  '2067ae52-33fd-4a82-bb92-c2c55e7d2786', // AlbedoBase XL
  'aa77f04e-3eec-4034-9c07-d0f619684628', // Kino XL
  '1e60896f-3c26-4296-8ecc-53e2afecc132'  // Leonardo Diffusion XL
];

// Hugging Face image-to-image / image-editing models, tried in order.
const HF_MODELS = [
  'black-forest-labs/FLUX.1-Kontext-dev',
  'timbrooks/instruct-pix2pix'
];
const HF_PROMPT =
  'Turn this photo into a hyper-detailed hand-embroidered thread portrait: dense directional ' +
  'long-and-short and satin stitches following the fur and contours, individual embroidery ' +
  'floss strands and needle texture clearly visible, soft sheen of stranded cotton, fine ' +
  'stitch shadows, mounted on dark textured linen with a clean stitched outline. Keep the ' +
  'exact subject, pose, colours and composition.';

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

// find the first base64 image blob anywhere in a JSON response
function deepFindB64(node, d) {
  d = d || 0;
  if (!node || d > 9) return null;
  if (typeof node === 'string') return (node.length > 3000 && /^[A-Za-z0-9+/=\s]+$/.test(node.slice(0, 120))) ? node.replace(/\s+/g, '') : null;
  if (Array.isArray(node)) { for (const v of node) { const r = deepFindB64(v, d + 1); if (r) return r; } return null; }
  if (typeof node === 'object') {
    const direct = (node.inlineData && node.inlineData.data) || (node.inline_data && node.inline_data.data) || node.b64_json;
    if (typeof direct === 'string' && direct.length > 3000) return direct.replace(/\s+/g, '');
    for (const k in node) { const r = deepFindB64(node[k], d + 1); if (r) return r; }
  }
  return null;
}

// Leonardo.ai image-to-image: upload init image -> start generation -> poll -> fetch result
async function tryLeonardo(env, jpgBytes, prompt, errs) {
  const H = { Authorization: 'Bearer ' + env.LEONARDO_API_KEY, 'content-type': 'application/json', accept: 'application/json' };
  const strength = Math.max(0.1, Math.min(0.9, parseFloat(env.LEONARDO_STRENGTH || '0.35')));

  let up;
  try {
    const r = await fetch(LEO + '/init-image', { method: 'POST', headers: H, body: JSON.stringify({ extension: 'jpg' }) });
    if (!r.ok) { errs.push('leo/init: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 180)); return null; }
    up = (await r.json()).uploadInitImage;
  } catch (e) { errs.push('leo/init: ' + ((e && e.message) || e)); return null; }
  if (!up || !up.url || !up.id) { errs.push('leo/init: no upload slot'); return null; }

  try {
    const fields = typeof up.fields === 'string' ? JSON.parse(up.fields) : (up.fields || {});
    const fd = new FormData();
    for (const k in fields) fd.append(k, fields[k]);
    fd.append('file', new Blob([jpgBytes], { type: 'image/jpeg' }), 'src.jpg');
    const ur = await fetch(up.url, { method: 'POST', body: fd });
    if (!ur.ok && ur.status !== 204) { errs.push('leo/upload: HTTP ' + ur.status + ' ' + (await ur.text()).slice(0, 160)); return null; }
  } catch (e) { errs.push('leo/upload: ' + ((e && e.message) || e)); return null; }

  const models = env.LEONARDO_MODEL ? [env.LEONARDO_MODEL] : LEO_MODELS_FALLBACK;
  let genId = null, usedModel = '';
  for (const modelId of models) {
    try {
      const gr = await fetch(LEO + '/generations', {
        method: 'POST', headers: H,
        body: JSON.stringify({ prompt, modelId, init_image_id: up.id, init_strength: strength, num_images: 1, width: 768, height: 768, public: false })
      });
      const gj = await gr.json().catch(() => ({}));
      if (gr.ok && gj.sdGenerationJob && gj.sdGenerationJob.generationId) { genId = gj.sdGenerationJob.generationId; usedModel = modelId; break; }
      errs.push('leo/gen(' + modelId.slice(0, 8) + '): HTTP ' + gr.status + ' ' + JSON.stringify(gj).slice(0, 200));
    } catch (e) { errs.push('leo/gen: ' + ((e && e.message) || e)); }
  }
  if (!genId) return null;

  for (let i = 0; i < 26; i++) {
    await sleep(3000);
    try {
      const pr = await fetch(LEO + '/generations/' + genId, { headers: H });
      const g = (await pr.json().catch(() => ({}))).generations_by_pk;
      if (g && g.status === 'FAILED') { errs.push('leo/gen: FAILED'); return null; }
      if (g && g.status === 'COMPLETE' && g.generated_images && g.generated_images[0] && g.generated_images[0].url) {
        const ir = await fetch(g.generated_images[0].url);
        if (ir.ok) { const buf = await ir.arrayBuffer(); if (buf.byteLength > 500) return { buf, model: 'leonardo/' + usedModel.slice(0, 8) }; }
        errs.push('leo/image: HTTP ' + ir.status); return null;
      }
    } catch (e) { errs.push('leo/poll: ' + ((e && e.message) || e)); }
  }
  errs.push('leo/poll: timed out');
  return null;
}

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

    const okImage = (b64, mime, model) => json({ image: b64, mime, model, tried: errs }, 200, ch);
    const editPrompt = HF_PROMPT + (body.extra ? ' ' + body.extra : '');

    // ---- 1. Google Gemini image ("Nano Banana") – needs billing enabled ----
    if (env.GEMINI_API_KEY) {
      const model = env.GEMINI_MODEL || 'gemini-2.5-flash-image';
      try {
        const gr = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
          ':generateContent?key=' + encodeURIComponent(env.GEMINI_API_KEY),
          {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: editPrompt }, { inline_data: { mime_type: 'image/jpeg', data } }] }],
              generationConfig: { responseModalities: ['IMAGE'] }
            })
          }
        );
        const gj = await gr.json().catch(() => ({}));
        const img = deepFindB64(gj);
        if (gr.ok && img) return okImage(img, 'image/png', 'gemini/' + model);
        errs.push('gemini(' + model + '): HTTP ' + gr.status + ' ' + JSON.stringify(gj.error || gj).slice(0, 240));
      } catch (e) { errs.push('gemini: ' + ((e && e.message) || e)); }
    }

    // ---- 2. Leonardo.ai image-to-image ----
    if (env.LEONARDO_API_KEY) {
      try {
        const lo = await tryLeonardo(env, src, editPrompt, errs);
        if (lo) return okImage(b64FromBuf(lo.buf), 'image/jpeg', lo.model);
      } catch (e) { errs.push('leo: ' + ((e && e.message) || e)); }
    }

    // ---- 3. Hugging Face image-to-image ----
    if (env.HF_TOKEN) {
      const list = env.HF_MODEL ? [env.HF_MODEL] : HF_MODELS;
      const hfPrompt = HF_PROMPT + (body.extra ? ' ' + body.extra : '');
      for (const model of list) {
        try {
          const hr = await fetch('https://router.huggingface.co/hf-inference/models/' + model, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.HF_TOKEN, 'Content-Type': 'application/json', Accept: 'image/png' },
            body: JSON.stringify({
              inputs: data,
              parameters: { prompt: hfPrompt, negative_prompt: NEG, guidance_scale: 7.5, num_inference_steps: steps }
            })
          });
          const ct = hr.headers.get('content-type') || '';
          if (hr.ok && ct.startsWith('image')) {
            const buf = await hr.arrayBuffer();
            if (buf.byteLength > 500) return okImage(b64FromBuf(buf), ct, 'hf/' + model);
            errs.push('hf/' + model + ': tiny');
          } else {
            errs.push('hf/' + model + ': HTTP ' + hr.status + ' ct=' + ct + ' ' + (await hr.text()).slice(0, 220));
          }
        } catch (e) {
          errs.push('hf/' + model + ': ' + ((e && e.message) || e));
        }
      }
    }

    // ---- 4. Cloudflare Workers AI ----
    if (env.AI) {
      const list = (body.model || env.AI_MODEL) ? [[body.model || env.AI_MODEL, 'b64']] : CF_MODELS;
      for (const [model, how] of list) {
        const inp = { prompt, negative_prompt: NEG, strength, guidance: 7.5, num_steps: steps };
        if (how === 'b64') inp.image_b64 = data; else inp.image = [...src];
        try {
          const buf = await toBuf(await env.AI.run(model, inp));
          if (buf && buf.byteLength > 500) return okImage(b64FromBuf(buf), 'image/png', model);
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

    // ---- 5. Pollinations (keyless), one retry on 429/5xx ----
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
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const pr = await fetch(p, { headers: { Accept: 'image/*' } });
          const ctype = pr.headers.get('content-type') || '';
          if (pr.ok && ctype.startsWith('image')) {
            const buf = await pr.arrayBuffer();
            if (buf.byteLength > 500) return okImage(b64FromBuf(buf), ctype, 'pollinations/flux');
            errs.push('pollinations: tiny response');
            break;
          }
          const txt = (await pr.text()).slice(0, 160);
          errs.push('pollinations: HTTP ' + pr.status + ' ' + txt);
          if ((pr.status === 429 || pr.status >= 500) && attempt < 1) { await sleep(10000); continue; }
          break;
        } catch (e) {
          errs.push('pollinations: ' + ((e && e.message) || e));
          if (attempt < 1) { await sleep(6000); continue; }
          break;
        }
      }
    }

    return json({ error: 'All render backends failed.', tried: errs }, 502, ch);
  }
};
