/*
 * Tube Counter: per-tube size measurement.
 *
 * For every counted tube, the bore edge and the outer edge are located with
 * sub-pixel precision (TubeCore.measureBore: rays from the centre, robust
 * circle fits). Then:
 *
 *   ratio  = ID / OD per tube, from the two fitted circles. Both circles are
 *            distorted the same way by a tilted camera, so the ratio does not
 *            depend on the tilt.
 *   scale  = the photo scale varies across a tilted bundle end. On a plane,
 *            pixels per mm change linearly across the image, so a robust
 *            linear fit of the outer diameters over the image gives the local
 *            scale at every tube. Each tube's OD relative to that fit is its
 *            size relative to the bundle.
 *   mm     = one number turns relative sizes into millimetres: the bundle OD
 *            from the AR step (no input), or a nominal OD if one was entered.
 *
 * Tubes clearly larger or smaller than the rest are flagged.
 */
(function (root) {
  'use strict';
  const C = root.TubeCore || (typeof require !== 'undefined' ? require('./core.js') : null);
  const T = root.TubeCount || (typeof require !== 'undefined' ? require('./count.js') : null);

  function median(a) {
    const s = Float64Array.from(a).sort();
    const n = s.length;
    return n ? (n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN;
  }

  // Robust plane fit z = p0 + p1 x + p2 y (iteratively reweighted, Huber-like).
  function fitPlane(xs, ys, zs) {
    const n = xs.length;
    let w = new Float64Array(n).fill(1);
    let p = [median(zs), 0, 0];
    for (let it = 0; it < 6; it++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const r = [1, xs[i], ys[i]];
        for (let a = 0; a < 3; a++) { b[a] += w[i] * r[a] * zs[i]; for (let c = 0; c < 3; c++) A[a][c] += w[i] * r[a] * r[c]; }
      }
      const q = solve3(A, b);
      if (!q) break;
      p = q;
      const res = zs.map((z, i) => z - (p[0] + p[1] * xs[i] + p[2] * ys[i]));
      const s = 1.4826 * median(res.map(Math.abs)) || 1e-9;
      w = Float64Array.from(res, (r) => { const u = Math.abs(r) / (2.5 * s); return u <= 1 ? 1 : 1 / u; });
    }
    return p;
  }
  function solve3(A, b) {
    const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
    const C0 = e * i - f * h, C1 = -(d * i - f * g), C2 = d * h - e * g;
    const det = a * C0 + bb * C1 + c * C2;
    if (Math.abs(det) < 1e-12) return null;
    const inv = [[C0, -(bb * i - c * h), bb * f - c * e], [C1, a * i - c * g, -(a * f - c * d)], [C2, -(a * h - bb * g), a * e - bb * d]];
    return [0, 1, 2].map((r) => (inv[r][0] * b[0] + inv[r][1] * b[1] + inv[r][2] * b[2]) / det);
  }

  function measureOneRaw(ctx, t, nnDist) {
    const { s, W, H, img, rMed, pitch } = ctx;
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const seed = [t.x * s, t.y * s];
    const R = Math.min((nnDist || pitch) * 0.62, pitch * 0.62, rMed * 2.2) * s;
    const r = C.measureBore(img, W, H, I, seed, { searchRadius: R, nRays: 96, maxRms: Math.max(1.5, 0.04 * rMed * s) });
    const o = { x: t.x, y: t.y, ok: false };
    if (!r.diameter || !r.outer || r.quality.inlierFraction < 0.6) return o;
    // the bore circle must be inside the outer circle, nearly concentric
    if (Math.hypot(r.outer.cx - r.center[0], r.outer.cy - r.center[1]) > 0.08 * r.outer.diameter) return o;
    o.ok = true;
    o.idPx = r.diameter / s;
    o.odPx = r.outer.diameter / s;
    o.ratio = r.diameter / r.outer.diameter;
    o.ovalPx = r.ovality / s;
    o.x = r.center[0] / s; o.y = r.center[1] / s;
    return o;
  }

  // Relative size and flag of one measured tube, from the bundle context.
  function relate(ctx, o) {
    const { p, cx, cy, sc, relMed, ratioMed, madRel, madRatio } = ctx;
    const fit = p[0] + p[1] * (o.x - cx) / sc + p[2] * (o.y - cy) / sc;
    o.rel = o.odPx / fit / relMed;
    const idRel = (o.rel * o.ratio) / ratioMed;
    o.idRel = idRel;
    o.flag = (Math.abs(o.rel - 1) > Math.max(0.03, 5 * madRel)) || (Math.abs(idRel - 1) > Math.max(0.03, 5 * (madRatio / ratioMed + madRel)));
    return o;
  }

  /** Measure one more tube (added by hand) in a bundle already measured. */
  function measureOne(m, t) {
    if (!m.ctx || !m.ctx.p) return { x: t.x, y: t.y, ok: false };
    const o = measureOneRaw(m.ctx, t, m.ctx.pitch);
    if (o.ok) {
      relate(m.ctx, o);
      if (m.odMm) { o.odMm = m.odMm * o.rel; o.idMm = o.odMm * o.ratio; o.wallMm = (o.odMm - o.idMm) / 2; }
    }
    return o;
  }

  /**
   * gray, w, h: the full photo. tubes: [{x, y, r}] from TubeCount.countTubes.
   * Returns { tubes: [{x, y, ok, idPx, odPx, ratio, rel, flag}], stats }
   * Sizes in mm are added later by applyScale().
   */
  function measureTubes(gray, w, h, tubes, opts) {
    opts = opts || {};
    const t0 = Date.now();
    if (!tubes.length) return { tubes: [], stats: null, ms: 0 };
    // Work at a resolution where a bore is about 70 px across.
    const rMed = median(tubes.map((t) => t.r));
    const s = Math.min(1, 35 / rMed);
    const W = Math.round(w * s), H = Math.round(h * s);
    const img = s < 1 ? T.resize(gray, w, h, W, H) : gray;
    // Tube pitch: median distance to the nearest neighbour.
    const nn = tubes.map((t, i) => {
      let best = Infinity;
      for (let j = 0; j < tubes.length; j++) if (j !== i) { const d = Math.hypot(tubes[j].x - t.x, tubes[j].y - t.y); if (d < best) best = d; }
      return best;
    });
    const pitch = median(nn.filter(Number.isFinite)) || rMed * 3;
    const ctx = { s, W, H, img, rMed, pitch, w, h };
    const out = tubes.map((t, i) => measureOneRaw(ctx, t, nn[i]));
    const ok = out.filter((o) => o.ok);
    if (ok.length < 3) return { tubes: out, stats: null, ctx, ms: Date.now() - t0 };
    // Local scale across the bundle: linear fit of OD in pixels over the image.
    const cx = w / 2, cy = h / 2, sc = Math.max(w, h);
    const xs = ok.map((o) => (o.x - cx) / sc), ys = ok.map((o) => (o.y - cy) / sc);
    const p = fitPlane(xs, ys, ok.map((o) => o.odPx));
    for (const o of ok) {
      const fit = p[0] + p[1] * (o.x - cx) / sc + p[2] * (o.y - cy) / sc;
      o.rel = o.odPx / fit;           // OD relative to the bundle (1 = typical)
    }
    const relMed = median(ok.map((o) => o.rel));
    for (const o of ok) o.rel /= relMed;
    const ratioMed = median(ok.map((o) => o.ratio));
    const madRel = 1.4826 * median(ok.map((o) => Math.abs(o.rel - 1)));
    const madRatio = 1.4826 * median(ok.map((o) => Math.abs(o.ratio - ratioMed)));
    // Flag clearly different tubes: beyond 3 % in OD or 3 % in ID, and beyond
    // 5 spreads of the bundle (so normal variation and noise are not flagged).
    Object.assign(ctx, { p, cx, cy, sc, relMed, ratioMed, madRel, madRatio });
    for (const o of ok) relate(ctx, o);
    const wallPx = median(ok.map((o) => (o.odPx - o.idPx) / 2));
    const borePx = median(ok.map((o) => o.idPx));
    const stats = {
      wallPx, borePx,
      // below ~5 px of wall or ~40 px of bore the edges blur together
      lowRes: wallPx < 5 || borePx < 40,
      measured: ok.length, total: out.length, ratio: ratioMed, spreadOd: madRel, spreadId: madRatio / ratioMed,
      flagged: ok.filter((o) => o.flag).length, odPxCentre: p[0], scaleTilt: [p[1] / p[0], p[2] / p[0]],
    };
    return { tubes: out, stats, ctx, ms: Date.now() - t0 };
  }

  /**
   * Turn relative sizes into millimetres. odMm: the typical (median) OD of the
   * bundle in mm, from the AR step or a nominal value.
   */
  function applyScale(m, odMm) {
    m.odMm = odMm;
    if (!m.stats) return m;
    const ok = m.tubes.filter((o) => o.ok);
    for (const o of ok) {
      o.odMm = odMm * o.rel;
      o.idMm = o.odMm * o.ratio;
      o.wallMm = (o.odMm - o.idMm) / 2;
    }
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const stat = (a) => {
      const mean = sum(a) / a.length;
      return { mean, min: Math.min(...a), max: Math.max(...a), sd: Math.sqrt(sum(a.map((v) => (v - mean) ** 2)) / Math.max(1, a.length - 1)) };
    };
    const good = ok.filter((o) => !o.flag);
    if (!good.length) return m;
    m.mm = { odMm, id: stat(good.map((o) => o.idMm)), od: stat(good.map((o) => o.odMm)), wall: stat(good.map((o) => o.wallMm)) };
    return m;
  }

  const api = { measureTubes, measureOne, applyScale };
  root.TubeMeasure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
