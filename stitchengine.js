/* DSR Embroidery - photo -> counted cross-stitch / embroidery-by-numbers chart.
   Pure client-side. Needs dmc.js loaded first (window.DMC).

   window.StitchEngine
     decodeToImageData(file)              -> Promise<ImageData>   (handles EXIF + HEIC if heic2any present)
     build(imageData, opts)              -> chart
        opts = { stitchesWide, colours, matchDmc }
     renderToCanvas(chart, mode, cellPx) -> HTMLCanvasElement     mode: 'colour' | 'stitch' | 'symbol'
     buildPrintDoc(chart, opts)          -> HTML string           opts = { title, count, unit, includeColour, symbolsWhite }

   chart = { w, h, idx:Int16Array(w*h), palette:[{r,g,b,hex,code,name,symbol,count,near}], srcW, srcH }
*/
(function () {
  'use strict';

  var SYMBOLS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxy+=/\\<>~^%&@$#*';

  /* ---------- colour maths (sRGB <-> CIE Lab, D65) ---------- */

  function slin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function rgb2lab(r, g, b) {
    var R = slin(r), G = slin(g), B = slin(b);
    var x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    var y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    var z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    var fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
    var fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
    var fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function de2(a, b) { var l = a[0] - b[0], m = a[1] - b[1], n = a[2] - b[2]; return l * l + m * m + n * n; }
  function hex(r, g, b) { return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase(); }
  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function dmcLab() {
    if (window.DMC_LAB) return window.DMC_LAB;
    window.DMC_LAB = window.DMC.map(function (d) { return rgb2lab(d[2], d[3], d[4]); });
    return window.DMC_LAB;
  }
  function nearestDmc(lab) {
    var L = dmcLab(), best = 0, bd = 1e18;
    for (var i = 0; i < L.length; i++) { var d = de2(lab, L[i]); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  /* ---------- decode ---------- */

  function idFromBitmapSource(src) {
    var c = document.createElement('canvas');
    c.width = src.width || src.naturalWidth; c.height = src.height || src.naturalHeight;
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function decodeBlob(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var fin = function (id) { URL.revokeObjectURL(url); res(id); };
      var viaImg = function () {
        var im = new Image();
        im.onload = function () { try { fin(idFromBitmapSource(im)); } catch (e) { rej(e); } };
        im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read that image.')); };
        im.src = url;
      };
      if (window.createImageBitmap) {
        createImageBitmap(blob, { imageOrientation: 'from-image' })
          .then(function (bm) { try { fin(idFromBitmapSource(bm)); } catch (e) { rej(e); } })
          .catch(viaImg);
      } else viaImg();
    });
  }

  function decodeToImageData(file) {
    var isHeic = /\.hei[cf]$/i.test(file.name || '') || /hei[cf]/i.test(file.type || '');
    if (isHeic && window.heic2any) {
      return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
        .then(function (out) { return decodeBlob(Array.isArray(out) ? out[0] : out); })
        .catch(function () { return decodeBlob(file); });
    }
    return decodeBlob(file);
  }

  /* ---------- helpers ---------- */

  function idToCanvas(id) {
    var c = document.createElement('canvas');
    c.width = id.width; c.height = id.height;
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  // progressive box-average downscale to a small grid
  function downscale(srcCanvas, gw, gh) {
    var cur = srcCanvas, cw = cur.width, ch = cur.height;
    while (cw > gw * 2 || ch > gh * 2) {
      var nw = Math.max(gw, Math.round(cw / 2)), nh = Math.max(gh, Math.round(ch / 2));
      var t = document.createElement('canvas'); t.width = nw; t.height = nh;
      var tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, 0, 0, nw, nh);
      cur = t; cw = nw; ch = nh;
    }
    var f = document.createElement('canvas'); f.width = gw; f.height = gh;
    var fc = f.getContext('2d');
    fc.imageSmoothingEnabled = true; fc.imageSmoothingQuality = 'high';
    fc.drawImage(cur, 0, 0, gw, gh);
    return fc.getImageData(0, 0, gw, gh).data;
  }

  /* ---------- build chart ---------- */

  function build(srcId, opts) {
    opts = opts || {};
    var stitchesWide = Math.max(20, Math.min(320, opts.stitchesWide | 0 || 120));
    var K = Math.max(2, Math.min(48, opts.colours | 0 || 12));
    var matchDmc = opts.matchDmc !== false;

    var gw = stitchesWide;
    var gh = Math.max(1, Math.round(stitchesWide * srcId.height / srcId.width));
    var data = downscale(idToCanvas(srcId), gw, gh);
    var n = gw * gh;

    var labs = new Float32Array(n * 3);
    var px = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b;
      var L = rgb2lab(r, g, b);
      labs[i * 3] = L[0]; labs[i * 3 + 1] = L[1]; labs[i * 3 + 2] = L[2];
    }

    // sample subset for the clustering loop
    var maxS = 12000;
    var samp = n <= maxS ? null : (function () {
      var a = new Int32Array(maxS);
      for (var s = 0; s < maxS; s++) a[s] = (Math.random() * n) | 0;
      return a;
    })();
    var sc = samp ? maxS : n;
    var si = function (k) { return (samp ? samp[k] : k); };

    // k-means++ seeding
    var cent = new Float32Array(K * 3);
    var f0 = si((Math.random() * sc) | 0) * 3;
    cent[0] = labs[f0]; cent[1] = labs[f0 + 1]; cent[2] = labs[f0 + 2];
    var dmin = new Float32Array(sc); dmin.fill(1e18);
    for (var c = 1; c < K; c++) {
      var sum = 0, pc = (c - 1) * 3;
      for (var p = 0; p < sc; p++) {
        var o = si(p) * 3;
        var dl = labs[o] - cent[pc], da = labs[o + 1] - cent[pc + 1], db = labs[o + 2] - cent[pc + 2];
        var d = dl * dl + da * da + db * db;
        if (d < dmin[p]) dmin[p] = d;
        sum += dmin[p];
      }
      var pick = Math.random() * sum, acc = 0, ch = sc - 1;
      for (var p2 = 0; p2 < sc; p2++) { acc += dmin[p2]; if (acc >= pick) { ch = p2; break; } }
      var oc = si(ch) * 3;
      cent[c * 3] = labs[oc]; cent[c * 3 + 1] = labs[oc + 1]; cent[c * 3 + 2] = labs[oc + 2];
    }

    // Lloyd iterations on the sample
    var asg = new Int16Array(sc).fill(-1);
    var sL = new Float64Array(K), sA = new Float64Array(K), sB = new Float64Array(K);
    var sR = new Float64Array(K), sG = new Float64Array(K), sBl = new Float64Array(K), cnt = new Int32Array(K);
    for (var it = 0; it < 16; it++) {
      sL.fill(0); sA.fill(0); sB.fill(0); sR.fill(0); sG.fill(0); sBl.fill(0); cnt.fill(0);
      var moved = 0;
      for (var q = 0; q < sc; q++) {
        var idx = si(q), o2 = idx * 3, best = 0, bd = 1e18;
        for (var k = 0; k < K; k++) {
          var x = labs[o2] - cent[k * 3], y = labs[o2 + 1] - cent[k * 3 + 1], z = labs[o2 + 2] - cent[k * 3 + 2];
          var dd = x * x + y * y + z * z;
          if (dd < bd) { bd = dd; best = k; }
        }
        if (asg[q] !== best) { asg[q] = best; moved++; }
        sL[best] += labs[o2]; sA[best] += labs[o2 + 1]; sB[best] += labs[o2 + 2];
        sR[best] += px[idx * 3]; sG[best] += px[idx * 3 + 1]; sBl[best] += px[idx * 3 + 2];
        cnt[best]++;
      }
      for (var k2 = 0; k2 < K; k2++) {
        if (cnt[k2]) {
          cent[k2 * 3] = sL[k2] / cnt[k2];
          cent[k2 * 3 + 1] = sA[k2] / cnt[k2];
          cent[k2 * 3 + 2] = sB[k2] / cnt[k2];
        }
      }
      if (!moved && it > 1) break;
    }

    // candidate colours from live centroids
    var cand = [];               // {lab,r,g,b}
    var seenDmc = {};
    for (var kk = 0; kk < K; kk++) {
      if (!cnt[kk]) continue;
      var clab = [cent[kk * 3], cent[kk * 3 + 1], cent[kk * 3 + 2]];
      var di = nearestDmc(clab);
      if (matchDmc) {
        if (seenDmc[di] != null) continue;
        seenDmc[di] = 1;
        var dd = window.DMC[di];
        cand.push({ lab: window.DMC_LAB[di], r: dd[2], g: dd[3], b: dd[4], code: dd[0], name: dd[1], near: di });
      } else {
        var r2 = Math.round(sR[kk] / cnt[kk]), g2 = Math.round(sG[kk] / cnt[kk]), b2 = Math.round(sBl[kk] / cnt[kk]);
        cand.push({ lab: rgb2lab(r2, g2, b2), r: r2, g: g2, b: b2, code: '', name: '', near: di });
      }
    }
    if (!cand.length) cand.push({ lab: [50, 0, 0], r: 128, g: 128, b: 128, code: '', name: '', near: 0 });

    // assign every cell to nearest candidate
    var idxArr = new Int16Array(n);
    var used = new Int32Array(cand.length);
    for (var m = 0; m < n; m++) {
      var mo = m * 3, bb = 0, bbd = 1e18;
      for (var j = 0; j < cand.length; j++) {
        var cl = cand[j].lab;
        var u = labs[mo] - cl[0], v = labs[mo + 1] - cl[1], w = labs[mo + 2] - cl[2];
        var e = u * u + v * v + w * w;
        if (e < bbd) { bbd = e; bb = j; }
      }
      idxArr[m] = bb; used[bb]++;
    }

    // drop unused, sort by usage desc, assign symbols
    var order = [];
    for (var t = 0; t < cand.length; t++) if (used[t]) order.push(t);
    order.sort(function (a, b) { return used[b] - used[a]; });
    var remap = new Int16Array(cand.length).fill(-1);
    var palette = order.map(function (oldIdx, newIdx) {
      remap[oldIdx] = newIdx;
      var cc = cand[oldIdx];
      var nd = window.DMC[cc.near];
      return {
        r: cc.r, g: cc.g, b: cc.b, hex: hex(cc.r, cc.g, cc.b),
        code: cc.code || nd[0], name: cc.name || nd[1],
        exact: !!cc.code,
        symbol: SYMBOLS[newIdx] || '?',
        count: used[oldIdx]
      };
    });
    for (var y2 = 0; y2 < n; y2++) idxArr[y2] = remap[idxArr[y2]];

    return { w: gw, h: gh, idx: idxArr, palette: palette, srcW: srcId.width, srcH: srcId.height };
  }

  /* ---------- on-screen rendering ---------- */

  function renderToCanvas(chart, mode, cellPx) {
    cellPx = Math.max(2, cellPx | 0 || 8);
    var w = chart.w, h = chart.h, P = chart.palette, id = chart.idx;
    var c = document.createElement('canvas');
    c.width = w * cellPx; c.height = h * cellPx;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    if (mode === 'symbol') {
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var pi = id[y * w + x]; if (pi < 0) continue;
        var p = P[pi], X = x * cellPx, Y = y * cellPx;
        if (mode === 'colour') {
          g.fillStyle = p.hex; g.fillRect(X, Y, cellPx, cellPx);
        } else if (mode === 'stitch') {
          // pale "aida" ground then an X in the thread colour
          g.fillStyle = 'rgba(' + p.r + ',' + p.g + ',' + p.b + ',0.16)';
          g.fillRect(X, Y, cellPx, cellPx);
          g.strokeStyle = p.hex;
          g.lineWidth = Math.max(1, cellPx / 5);
          g.lineCap = 'round';
          var m = cellPx * 0.18;
          g.beginPath();
          g.moveTo(X + m, Y + m); g.lineTo(X + cellPx - m, Y + cellPx - m);
          g.moveTo(X + cellPx - m, Y + m); g.lineTo(X + m, Y + cellPx - m);
          g.stroke();
        } else { // symbol
          var a = 0.34;
          g.fillStyle = 'rgba(' + p.r + ',' + p.g + ',' + p.b + ',' + a + ')';
          g.fillRect(X, Y, cellPx, cellPx);
          if (cellPx >= 7) {
            var bl = 255 * (1 - a) + lum(p.r, p.g, p.b) * a;
            g.fillStyle = bl < 140 ? '#fff' : '#111';
            g.font = (cellPx * 0.72) + 'px "Segoe UI",system-ui,sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(p.symbol, X + cellPx / 2, Y + cellPx / 2 + cellPx * 0.04);
          }
        }
      }
    }

    // grid
    if (mode !== 'stitch' && cellPx >= 4) {
      g.lineWidth = 1;
      g.strokeStyle = mode === 'symbol' ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.10)';
      g.beginPath();
      for (var gx = 0; gx <= w; gx++) { g.moveTo(gx * cellPx + 0.5, 0); g.lineTo(gx * cellPx + 0.5, c.height); }
      for (var gy = 0; gy <= h; gy++) { g.moveTo(0, gy * cellPx + 0.5); g.lineTo(c.width, gy * cellPx + 0.5); }
      g.stroke();
      // heavy every 10
      g.lineWidth = Math.max(1.5, cellPx / 7);
      g.strokeStyle = mode === 'symbol' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)';
      g.beginPath();
      for (var hx = 0; hx <= w; hx += 10) { g.moveTo(hx * cellPx + 0.5, 0); g.lineTo(hx * cellPx + 0.5, c.height); }
      for (var hy = 0; hy <= h; hy += 10) { g.moveTo(0, hy * cellPx + 0.5); g.lineTo(c.width, hy * cellPx + 0.5); }
      g.stroke();
    }
    return c;
  }

  /* ---------- printable document ---------- */

  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }

  // One chart page as a PNG data URL. Canvas keeps the print document light
  // (one <img> per page) so big charts don't choke a phone's print renderer.
  function rasterTile(chart, cx, cy, cols, rows, symbolsWhite) {
    var CELL = 22, PADL = 42, PADT = 30;
    var c = document.createElement('canvas');
    c.width = PADL + cols * CELL + 1;
    c.height = PADT + rows * CELL + 1;
    var g = c.getContext('2d');
    var P = chart.palette, id = chart.idx, gw = chart.w;

    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = Math.round(CELL * 0.6) + 'px "Segoe UI",Arial,sans-serif';
    for (var r = 0; r < rows; r++) {
      for (var k = 0; k < cols; k++) {
        var pi = id[(cy + r) * gw + (cx + k)]; if (pi < 0) continue;
        var p = P[pi], X = PADL + k * CELL, Y = PADT + r * CELL;
        if (!symbolsWhite) { g.fillStyle = p.hex; g.fillRect(X, Y, CELL, CELL); }
        g.fillStyle = symbolsWhite ? '#000' : (lum(p.r, p.g, p.b) > 150 ? '#000' : '#fff');
        g.fillText(p.symbol, X + CELL / 2, Y + CELL / 2 + 1);
      }
    }

    g.strokeStyle = '#c8c8c8'; g.lineWidth = 1; g.beginPath();
    for (var a = 0; a <= cols; a++) { g.moveTo(PADL + a * CELL + 0.5, PADT); g.lineTo(PADL + a * CELL + 0.5, PADT + rows * CELL); }
    for (var b = 0; b <= rows; b++) { g.moveTo(PADL, PADT + b * CELL + 0.5); g.lineTo(PADL + cols * CELL, PADT + b * CELL + 0.5); }
    g.stroke();

    g.strokeStyle = '#000'; g.lineWidth = 1.6; g.beginPath();
    for (var a2 = 0; a2 <= cols; a2++) {
      if (a2 !== 0 && a2 !== cols && (cx + a2) % 10 !== 0) continue;
      g.moveTo(PADL + a2 * CELL + 0.5, PADT); g.lineTo(PADL + a2 * CELL + 0.5, PADT + rows * CELL);
    }
    for (var b2 = 0; b2 <= rows; b2++) {
      if (b2 !== 0 && b2 !== rows && (cy + b2) % 10 !== 0) continue;
      g.moveTo(PADL, PADT + b2 * CELL + 0.5); g.lineTo(PADL + cols * CELL, PADT + b2 * CELL + 0.5);
    }
    g.stroke();

    g.fillStyle = '#000'; g.font = '12px "Segoe UI",Arial,sans-serif';
    g.textAlign = 'center';
    for (var a3 = 0; a3 <= cols; a3++) { if ((cx + a3) % 10 === 0) g.fillText(String(cx + a3), PADL + a3 * CELL, PADT - 12); }
    g.textAlign = 'right';
    for (var b3 = 0; b3 <= rows; b3++) { if ((cy + b3) % 10 === 0) g.fillText(String(cy + b3), PADL - 7, PADT + b3 * CELL); }

    return c.toDataURL('image/png');
  }

  function buildPrintDoc(chart, opts) {
    opts = opts || {};
    var count = +opts.count || 14;
    var unit = opts.unit === 'cm' ? 'cm' : 'in';
    var symbolsWhite = !!opts.symbolsWhite;
    var includeColour = !!opts.includeColour;
    var title = opts.title || 'Embroidery chart';

    var totalStitches = 0, P = chart.palette;
    P.forEach(function (p) { totalStitches += p.count; });
    var wIn = chart.w / count, hIn = chart.h / count;
    var toU = function (v) { return unit === 'cm' ? (v * 2.54).toFixed(1) : v.toFixed(1); };

    var legend = P.map(function (p, i) {
      var skeins = Math.max(1, Math.ceil(p.count / 1700));
      return '<tr>' +
        '<td><span class="sw" style="background:' + p.hex + '"></span></td>' +
        '<td class="sym">' + esc(p.symbol) + '</td>' +
        '<td>' + esc(p.code) + (p.exact ? '' : ' <span class="approx">≈</span>') + '</td>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td class="num">' + p.count + '</td>' +
        '<td class="num">' + skeins + '</td>' +
        '</tr>';
    }).join('');

    // tiles
    var TC = 50, TR = 70;
    function pages(white) {
      var out = '';
      for (var ty = 0; ty < chart.h; ty += TR) {
        for (var tx = 0; tx < chart.w; tx += TC) {
          var cols = Math.min(TC, chart.w - tx), rows = Math.min(TR, chart.h - ty);
          out += '<div class="page"><div class="plabel">' + (white ? 'Symbols' : 'Colour blocks') +
            ' &mdash; columns ' + (tx + 1) + '&ndash;' + (tx + cols) + ', rows ' + (ty + 1) + '&ndash;' + (ty + rows) + '</div>' +
            '<img class="tile" src="' + rasterTile(chart, tx, ty, cols, rows, white) + '"></div>';
        }
      }
      return out;
    }
    var tiles = pages(symbolsWhite);
    var colourPages = includeColour ? pages(false) : '';

    var preview = renderToCanvas(chart, 'colour', 6).toDataURL('image/png');

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      '*{box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;margin:0;color:#111;background:#fff}' +
      '.bar{position:sticky;top:0;background:#000;color:#FFD700;padding:10px 16px;display:flex;gap:12px;align-items:center}' +
      '.bar button{font:inherit;font-weight:700;background:#FFD700;color:#000;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}' +
      '.bar span{font-size:12px;color:#D4AF42}' +
      '.wrap{padding:18px;max-width:900px;margin:0 auto}' +
      'h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;border-bottom:2px solid #000;padding-bottom:3px}' +
      '.meta{font-size:13px;line-height:1.5}.meta b{display:inline-block;min-width:130px}' +
      'img.pv{max-width:360px;border:1px solid #999;margin-top:8px;image-rendering:pixelated}' +
      'table{border-collapse:collapse;width:100%;font-size:12px}' +
      'th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}th{background:#eee}' +
      '.num{text-align:right}.sym{font-weight:700;text-align:center}' +
      '.sw{display:inline-block;width:20px;height:14px;border:1px solid #333;vertical-align:middle}' +
      '.approx,.note{color:#a60;font-size:11px}' +
      '.plabel{font-size:11px;font-weight:700;margin:14px 0 4px}' +
      'img.tile{display:block;width:100%;max-width:940px;border:1px solid #000;height:auto}' +
      '@media print{.bar{display:none}.wrap{padding:0}.page{page-break-after:always}img.tile{max-width:100%}}' +
      '</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">Print / Save as PDF</button><span>Use your browser\'s print dialog. Choose &ldquo;Save as PDF&rdquo; for a file.</span></div>' +
      '<div class="wrap">' +
      '<h1>' + esc(title) + '</h1>' +
      '<div class="meta">' +
      '<div><b>Chart size</b> ' + chart.w + ' &times; ' + chart.h + ' stitches</div>' +
      '<div><b>Finished size</b> ' + toU(wIn) + ' &times; ' + toU(hIn) + ' ' + unit + ' on ' + count + '-count fabric</div>' +
      '<div><b>Total stitches</b> ' + totalStitches + '</div>' +
      '<div><b>Thread colours</b> ' + P.length + ' DMC shade(s)</div>' +
      '</div>' +
      '<img class="pv" src="' + preview + '" alt="colour preview">' +
      '<h2>Thread key</h2>' +
      '<table><thead><tr><th>Colour</th><th>Sym</th><th>DMC</th><th>Name</th><th class="num">Stitches</th><th class="num">Skeins*</th></tr></thead><tbody>' + legend + '</tbody></table>' +
      '<p class="note">* Rough skein estimate (~1700 full cross-stitches per skein, 2 strands on 14-count). DMC numbers marked &ldquo;≈&rdquo; are the nearest match, not exact. Thread RGB values are community approximations &ndash; check against a real DMC shade card before buying.</p>' +
      '<h2>Symbol chart</h2>' + tiles +
      (includeColour ? '<h2>Colour-block chart</h2>' + colourPages : '') +
      '</div></body></html>';
  }

  window.StitchEngine = {
    decodeToImageData: decodeToImageData,
    build: build,
    renderToCanvas: renderToCanvas,
    buildPrintDoc: buildPrintDoc
  };
})();
