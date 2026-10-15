/*
 * Tube Counter: counting core.
 *
 * Finds the tube ends in a photo of a bundle and counts them. Each tube end
 * shows a bore (dark, or bright when lit from behind) enclosed by its own
 * wall, so bores stay separate even when the tubes touch.
 *
 * Method (maximally stable regions, no learned model):
 *   1. Threshold the image at many grey levels. A bore appears as a compact
 *      region that stays round and changes area slowly over a range of
 *      levels, until the level reaches the brightness of its wall.
 *   2. Track each region from level to level by the pixel it started from,
 *      and keep the level where it is most stable.
 *   3. Keep round regions near the dominant size (the shadows between tubes
 *      are much smaller and triangular, a recessed tube's whole face larger).
 *   4. Remove duplicates closer than about half a bore diameter.
 *
 * Pure JavaScript, no dependencies. Runs in the browser (window.TubeCount)
 * and in Node (require('./count.js')).
 */
(function (root) {
  'use strict';

  function rgbaToGray(rgba, w, h) {
    const n = w * h, g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }

  // Area-average resize to (W, H).
  function resize(gray, w, h, W, H) {
    if (W === w && H === h) return gray;
    const out = new Uint8ClampedArray(W * H);
    const fx = w / W, fy = h / H;
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < h; yy++) {
          const row = yy * w;
          for (let xx = x0; xx < x1 && xx < w; xx++) { s += gray[row + xx]; n++; }
        }
        out[y * W + x] = n ? s / n : 0;
      }
    }
    return out;
  }

  function percentile(img, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < img.length; i++) hist[img[i]]++;
    const target = p * img.length;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  // Label 4-connected pixels where mask(v) holds; returns per-component stats.
  function label(img, W, H, thr, dark, lab, stack) {
    lab.fill(-1);
    const comps = [];
    const N = W * H;
    for (let s = 0; s < N; s++) {
      const v0 = img[s];
      if ((dark ? v0 >= thr : v0 <= thr) || lab[s] >= 0) continue;
      const id = comps.length;
      let sp = 0; stack[sp++] = s; lab[s] = id;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sv = 0;
      let x0 = W, x1 = 0, y0 = H, y1 = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sv += img[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        let q;
        q = p - 1; if (x > 0 && lab[q] < 0 && (dark ? img[q] < thr : img[q] > thr)) { lab[q] = id; stack[sp++] = q; }
        q = p + 1; if (x < W - 1 && lab[q] < 0 && (dark ? img[q] < thr : img[q] > thr)) { lab[q] = id; stack[sp++] = q; }
        q = p - W; if (y > 0 && lab[q] < 0 && (dark ? img[q] < thr : img[q] > thr)) { lab[q] = id; stack[sp++] = q; }
        q = p + W; if (y < H - 1 && lab[q] < 0 && (dark ? img[q] < thr : img[q] > thr)) { lab[q] = id; stack[sp++] = q; }
      }
      const cx = sx / n, cy = sy / n;
      const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
      comps.push({
        n, cx, cy, seed: s, mean: sv / n,
        fill: n / (4 * Math.PI * Math.sqrt(l1 * l2) || 1),
        aspect: Math.sqrt(l1 / l2),
        border: x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1,
      });
    }
    return comps;
  }

  // Stable round regions of one polarity.
  function stableRegions(img, W, H, dark, opts) {
    const levels = opts.levels || 28;
    const lo = percentile(img, 0.01), hi = percentile(img, 0.99);
    if (hi - lo < 12) return [];
    const thr = [];
    for (let k = 0; k < levels; k++) {
      const t = lo + ((hi - lo) * (k + 1)) / (levels + 1);
      thr.push(dark ? t : hi - (t - lo));
    }
    const lab = new Int32Array(W * H), stack = new Int32Array(W * H);
    const minArea = opts.minArea || 12;
    const maxArea = opts.maxArea || W * H * 0.08;
    const clusters = [];   // {seed, entries: [{k, n, cx, cy, fill, aspect, border, mean}], open}
    let open = [];
    for (let k = 0; k < levels; k++) {
      const comps = label(img, W, H, thr[k], dark, lab, stack);
      const owner = new Int32Array(comps.length).fill(-1);
      const shared = new Uint8Array(comps.length);
      const next = [];
      for (const c of open) {
        const id = lab[c.seed];
        if (id < 0) continue;
        if (owner[id] >= 0) shared[id] = 1; else owner[id] = clusters.indexOf(c) >= 0 ? clusters.indexOf(c) : -1;
      }
      // second pass so that merged regions end every cluster that fed them
      for (const c of open) {
        const id = lab[c.seed];
        if (id < 0) continue;
        if (shared[id]) { c.open = false; continue; }
        const q = comps[id];
        c.entries.push({ k, t: thr[k], n: q.n, cx: q.cx, cy: q.cy, fill: q.fill, aspect: q.aspect, border: q.border, mean: q.mean });
        q.taken = true;
        if (q.n > maxArea) c.open = false; else next.push(c);
      }
      for (let id = 0; id < comps.length; id++) {
        const q = comps[id];
        if (q.taken || shared[id] || q.n < minArea || q.n > maxArea) continue;
        const c = { seed: q.seed, entries: [{ k, t: thr[k], n: q.n, cx: q.cx, cy: q.cy, fill: q.fill, aspect: q.aspect, border: q.border, mean: q.mean }], open: true };
        clusters.push(c); next.push(c);
      }
      open = next;
    }
    // Most stable round entry of every cluster.
    const out = [];
    for (const c of clusters) {
      const E = c.entries;
      let best = null;
      for (let i = 0; i < E.length; i++) {
        const e = E[i];
        if (e.border || e.n < minArea) continue;
        if (e.fill < 0.86 || e.fill > 1.12 || e.aspect > 1.8) continue;
        const a = E[Math.max(0, i - 1)].n, b = E[Math.min(E.length - 1, i + 1)].n;
        const span = Math.min(E.length - 1, i + 1) - Math.max(0, i - 1);
        if (span < 1) continue;
        const growth = (b - a) / (e.n * span);
        // how many levels the region stayed round: robust bores live long
        if (!best || growth < best.growth) best = Object.assign({ growth, life: E.length }, e);
      }
      if (best) out.push(best);
    }
    return out;
  }

  function sample(img, W, H, x, y) {
    if (x < 0 || y < 0 || x > W - 1.001 || y > H - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
    return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + W] * (1 - fx) + img[i + W + 1] * fx) * fy;
  }

  // Wall test. A tube's bore is ringed all the way round by its own wall; an
  // empty position in the bundle is bounded by neighbouring tubes, with dark
  // cusps where they meet. Returns per-direction wall contrast relative to
  // the median, and the derived scores.
  function wallProfile(img, W, H, c, dark) {
    const r = Math.sqrt(c.n / Math.PI);
    const n = 48, vals = new Float64Array(n);
    const r1 = r * 1.15 + 1, step = Math.max(0.5, r / 40);
    for (let k = 0; k < n; k++) {
      const ct = Math.cos((2 * Math.PI * k) / n), st = Math.sin((2 * Math.PI * k) / n);
      let best = dark ? -1 : 256;
      for (let rho = r; rho <= r1; rho += step) {
        const v = sample(img, W, H, c.cx + rho * ct, c.cy + rho * st);
        if (Number.isNaN(v)) continue;
        if (dark ? v > best : v < best) best = v;
      }
      vals[k] = best;
    }
    const sorted = Float64Array.from(vals).sort();
    const ref = sorted[n >> 1];
    const contrast = dark ? ref - c.mean : c.mean - ref;
    const rel = new Float64Array(n);
    for (let k = 0; k < n; k++) rel[k] = contrast > 0 ? (dark ? vals[k] - c.mean : c.mean - vals[k]) / contrast : 0;
    return { rel, contrast };
  }
  function wallScores(p) {
    const n = p.rel.length;
    let f45 = 0, f25 = 0, minRel = Infinity;
    for (let k = 0; k < n; k++) { if (p.rel[k] >= 0.45) f45++; if (p.rel[k] >= 0.25) f25++; }
    // lowest wall contrast over any 3 consecutive directions (a cusp)
    for (let k = 0; k < n; k++) {
      const m = Math.max(p.rel[k], p.rel[(k + 1) % n], p.rel[(k + 2) % n]);
      if (m < minRel) minRel = m;
    }
    return { f45: f45 / n, f25: f25 / n, minRun: minRel, contrast: p.contrast };
  }
  // Edge fit: 36 rays from the centre, strongest dark-to-bright step (or the
  // reverse for bright bores) between 0.4 r and 1.8 r, sub-pixel position,
  // then circle fit. Returns refined centre and radius, roundness (robust
  // spread of the per-ray radius) and edge strength per ray.
  function refine(img, W, H, c, dark) {
    const r0 = Math.sqrt(c.n / Math.PI);
    const nr = 36, step = Math.max(0.35, r0 / 60);
    const a = 0.4 * r0, b = 1.8 * r0 + 2;
    const ns = Math.ceil((b - a) / step) + 1;
    const pts = [], strength = new Float64Array(nr), radii = new Float64Array(nr);
    const prof = new Float64Array(ns);
    for (let k = 0; k < nr; k++) {
      const ct = Math.cos((2 * Math.PI * k) / nr), st = Math.sin((2 * Math.PI * k) / nr);
      for (let i = 0; i < ns; i++) {
        const v = sample(img, W, H, c.cx + (a + i * step) * ct, c.cy + (a + i * step) * st);
        prof[i] = Number.isNaN(v) ? (i ? prof[i - 1] : 0) : v;
      }
      const sp = Math.max(1, Math.round(1 / step));
      // strongest step within 35 % of the region's rim sets the scale
      let gmax = 0;
      const wlo = Math.max(sp, Math.floor((0.65 * r0 - a) / step)), whi = Math.min(ns - sp - 1, Math.ceil((1.35 * r0 - a) / step));
      for (let i = wlo; i <= whi; i++) { const d = (prof[i + sp] - prof[i - sp]) * (dark ? 1 : -1); if (d > gmax) gmax = d; }
      // the rising step nearest the region's rim = the bore edge (not a
      // neighbour's face, not this tube's own outer edge)
      let bi = -1, bd = Infinity;
      const i0 = (r0 - a) / step;
      for (let i = sp + 1; i < ns - sp - 1; i++) {
        const d = (prof[i + sp] - prof[i - sp]) * (dark ? 1 : -1);
        if (d < 0.3 * gmax) continue;
        const dl = (prof[i - 1 + sp] - prof[i - 1 - sp]) * (dark ? 1 : -1);
        const dr = (prof[i + 1 + sp] - prof[i + 1 - sp]) * (dark ? 1 : -1);
        if (d < dl || d < dr) continue;
        if (Math.abs(i - i0) < bd) { bd = Math.abs(i - i0); bi = i; }
      }
      const bv = bi >= 0 ? (prof[bi + sp] - prof[bi - sp]) * (dark ? 1 : -1) : 0;
      strength[k] = bv;
      if (bi < 0) { radii[k] = NaN; continue; }
      const d0 = (prof[Math.min(ns - 1, bi - 1 + sp)] - prof[Math.max(0, bi - 1 - sp)]) * (dark ? 1 : -1);
      const d2 = (prof[Math.min(ns - 1, bi + 1 + sp)] - prof[Math.max(0, bi + 1 - sp)]) * (dark ? 1 : -1);
      const den = d0 - 2 * bv + d2;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (d0 - d2)) / den)) : 0;
      const rr = a + (bi + off) * step;
      radii[k] = rr;
      pts.push([c.cx + rr * ct, c.cy + rr * st]);
    }
    const valid = Array.from(radii).filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
    if (valid.length < nr * 0.7) return null;
    // robust circle fit (Kasa, then drop outliers and refit)
    const kasa = (P) => {
      let mx = 0, my = 0;
      for (const p of P) { mx += p[0]; my += p[1]; }
      mx /= P.length; my /= P.length;
      let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
      for (const p of P) {
        const u = p[0] - mx, v = p[1] - my;
        suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
      }
      const det = suu * svv - suv * suv;
      if (Math.abs(det) < 1e-12) return null;
      const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det;
      const vc = (suu * 0.5 * (svvv + svuu) - suv * 0.5 * (suuu + suvv)) / det;
      return { x: mx + uc, y: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / P.length) };
    };
    let use = pts, f = null;
    for (let pass = 0; pass < 3; pass++) {
      if (use.length < 8) return null;
      f = kasa(use);
      if (!f) return null;
      const res = pts.map((p) => Math.abs(Math.hypot(p[0] - f.x, p[1] - f.y) - f.r));
      const sorted = res.slice().sort((x, y) => x - y);
      const lim = Math.max(1, 3 * 1.4826 * sorted[sorted.length >> 1]);
      use = pts.filter((p, i) => res[i] <= lim);
    }
    const res = use.map((p) => Math.abs(Math.hypot(p[0] - f.x, p[1] - f.y) - f.r)).sort((x, y) => x - y);
    const R = f.r, mx = f.x, my = f.y, uc = 0, vc = 0;
    const inlier = use.length / nr;
    const sstr = Float64Array.from(strength).sort();
    const medStr = sstr[nr >> 1];
    let weak = 0;
    for (let k = 0; k < nr; k++) if (strength[k] < 0.35 * medStr) weak++;
    return {
      cx: mx + uc, cy: my + vc, r: R,
      roundness: res[Math.floor(res.length * 0.8)] / R,   // 80th percentile radial residual of inliers
      inlier, weak: weak / nr, edge: medStr,
    };
  }

  // Mode of log(area) with a smoothed histogram.
  function areaMode(cands) {
    if (!cands.length) return NaN;
    const bins = new Float64Array(120);
    const lo = Math.log(4), step = 0.08;
    for (const c of cands) {
      const b = Math.floor((Math.log(c.n) - lo) / step);
      const wgt = Math.min(1, c.life / 6) * (1 - Math.min(0.9, c.growth * 2));
      for (let d = -2; d <= 2; d++) if (b + d >= 0 && b + d < bins.length) bins[b + d] += wgt * Math.exp(-(d * d) / 2);
    }
    let bi = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[bi]) bi = i;
    return Math.exp(lo + (bi + 0.5) * step);
  }

  function selectTubes(img, W, H, dark, cands, mode) {
    const lo = mode / 3.2, hi = mode * 2.6;
    const ok = [];
    for (const c of cands) {
      if (c.n < lo || c.n > hi || c.life < 2) continue;
      const ws = wallScores(wallProfile(img, W, H, c, dark));
      if (!(ws.contrast > 8)) continue;
      const f = refine(img, W, H, c, dark);
      if (!f) continue;
      // A tube: the bore edge fits a circle tightly, or the region is walled
      // in every direction. A gap between tubes is neither.
      if (!(f.roundness <= 0.12 || (ws.f25 >= 0.98 && f.roundness <= 0.3))) continue;
      c.cx = f.cx; c.cy = f.cy; c.rr = f.r; c.roundness = f.roundness;
      ok.push(c);
    }
    // Prefer stable, long-lived regions when removing duplicates.
    ok.sort((a, b) => a.growth - b.growth || b.life - a.life);
    const kept = [];
    const cell = Math.sqrt(mode / Math.PI) * 2;
    const grid = new Map();
    const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    for (const c of ok) {
      const r = c.rr;
      const gx = Math.floor(c.cx / cell), gy = Math.floor(c.cy / cell);
      let clash = false;
      for (let dx = -1; dx <= 1 && !clash; dx++) for (let dy = -1; dy <= 1 && !clash; dy++) {
        const list = grid.get((gx + dx) + ',' + (gy + dy));
        if (!list) continue;
        for (const o of list) {
          if (Math.hypot(o.cx - c.cx, o.cy - c.cy) < 0.6 * (r + o.rr)) { clash = true; break; }
        }
      }
      if (clash) continue;
      kept.push(c);
      const k = key(c.cx, c.cy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }
    return kept;
  }

  function analyse(img, W, H, opts) {
    const res = {};
    for (const dark of [true, false]) {
      const cands = stableRegions(img, W, H, dark, opts);
      const mode = areaMode(cands);
      const tubes = Number.isNaN(mode) ? [] : selectTubes(img, W, H, dark, cands, mode);
      // score: how many consistent round regions this polarity explains
      const sizes = tubes.map((t) => t.rr);
      const m = sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1);
      const cv = Math.sqrt(sizes.reduce((a, b) => a + (b - m) ** 2, 0) / (sizes.length || 1)) / (m || 1);
      res[dark ? 'dark' : 'bright'] = { tubes, mode, cv, score: tubes.length * (1 - Math.min(0.8, cv)) };
    }
    const pick = res.dark.score >= res.bright.score ? 'dark' : 'bright';
    return Object.assign({ polarity: pick }, res[pick]);
  }

  /**
   * Count tube ends in one grayscale image.
   * Returns { count, tubes: [{x, y, r}], boreDiameterPx, polarity, ms }
   * in the coordinates of the input image.
   */
  function countTubes(gray, w, h, opts) {
    opts = opts || {};
    const t0 = Date.now();
    // Pass 1 at low resolution to learn the bore size.
    const s1 = Math.min(1, 900 / Math.max(w, h));
    const W1 = Math.round(w * s1), H1 = Math.round(h * s1);
    let img = resize(gray, w, h, W1, H1);
    let A = analyse(img, W1, H1, { levels: 24 });
    let scale = s1;
    const d1 = Number.isNaN(A.mode) ? 0 : 2 * Math.sqrt(A.mode / Math.PI);
    // Pass 2 at higher resolution when bores are small at low resolution.
    if (s1 < 1 && (d1 < 16 || A.tubes.length < 3)) {
      const target = d1 > 0 ? Math.min(1, Math.max(s1 * 1.5, (s1 * 22) / d1)) : Math.min(1, 2000 / Math.max(w, h));
      const s2 = Math.min(target, 2400 / Math.max(w, h), 1);
      if (s2 > s1 * 1.15) {
        const W2 = Math.round(w * s2), H2 = Math.round(h * s2);
        img = resize(gray, w, h, W2, H2);
        const B = analyse(img, W2, H2, { levels: 24 });
        if (B.tubes.length >= A.tubes.length * 0.9) { A = B; scale = s2; }
      }
    }
    const tubes = A.tubes.map((t) => ({ x: (t.cx + 0.5) / scale - 0.5, y: (t.cy + 0.5) / scale - 0.5, r: t.rr / scale }));
    tubes.sort((a, b) => a.y - b.y || a.x - b.x);
    const med = tubes.length ? tubes.map((t) => t.r).sort((a, b) => a - b)[tubes.length >> 1] : NaN;
    return {
      count: tubes.length, tubes, boreDiameterPx: 2 * med, polarity: A.polarity,
      sizeSpread: A.cv, workScale: scale, ms: Date.now() - t0,
    };
  }

  const api = { rgbaToGray, resize, countTubes };
  root.TubeCount = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
