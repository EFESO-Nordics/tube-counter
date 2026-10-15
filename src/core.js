/*
 * Tube Bore Gauge: measurement core.
 *
 * Pure JavaScript, no dependencies. Runs in the browser (window.TubeCore)
 * and in Node (require('./core.js')) so the same code is used by the app
 * and by the accuracy tests.
 *
 * Pipeline (measureTube)
 *   1. locateTube   find the tube end in the image: seed inside the bore, rays,
 *                   bore edge and outer edge, in pixels
 *   2. scale        'od'    fit an ellipse to the outer edge and map it to a
 *                           circle of the nominal OD (removes tilt, gives mm)
 *                   'fixed' pixels per mm from a one-time holder calibration
 *   3. measureBore  rays again in the corrected millimetre plane, sub-pixel
 *                   edges, robust circle fit, ovality, OD and wall
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- image utils

  function rgbaToGray(rgba, w, h) {
    const n = w * h;
    const g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return g;
  }

  // Box downscale by an integer factor.
  function downscale(gray, w, h, f) {
    if (f <= 1) return { img: gray, w, h };
    const sw = Math.floor(w / f), sh = Math.floor(h / f);
    const out = new Uint8ClampedArray(sw * sh);
    const inv = 1 / (f * f);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = (y * f + dy) * w + x * f;
          for (let dx = 0; dx < f; dx++) s += gray[row + dx];
        }
        out[y * sw + x] = s * inv;
      }
    }
    return { img: out, w: sw, h: sh };
  }

  function bilinear(gray, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0;
    const fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    const a = gray[i], b = gray[i + 1], c = gray[i + w], d = gray[i + w + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  // ---------------------------------------------------------------- linear algebra

  function solve(A, b) {
    // Gaussian elimination with partial pivoting. A is n x n (array of rows).
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  function normalizer(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    const s = Math.SQRT2 / (d / pts.length || 1);
    return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
  }

  function matMul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
    return C;
  }

  function matInv(M) {
    const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    const k = 1 / det;
    return [
      [A * k, -(b * i - c * h) * k, (b * f - c * e) * k],
      [B * k, (a * i - c * g) * k, -(a * f - c * d) * k],
      [C * k, -(a * h - b * g) * k, (a * e - b * d) * k],
    ];
  }

  function applyH(H, x, y) {
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
  }

  // Homography mapping src[i] -> dst[i] (4 correspondences, normalised DLT).
  function homography(src, dst) {
    const Ts = normalizer(src), Td = normalizer(dst);
    const s = src.map((p) => applyH(Ts, p[0], p[1]));
    const d = dst.map((p) => applyH(Td, p[0], p[1]));
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = s[i], [u, v] = d[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    if (!h) return null;
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
    const Tdi = matInv(Td);
    const H = matMul(Tdi, matMul(Hn, Ts));
    const k = 1 / H[2][2];
    return H.map((r) => r.map((v) => v * k));
  }

  // ---------------------------------------------------------------- blobs

  function components(mask, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    const out = [];
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || label[start] >= 0) continue;
      const id = out.length;
      let sp = 0; stack[sp++] = start; label[start] = id;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      let x0 = w, x1 = 0, y0 = h, y1 = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[sp++] = p + w; }
      }
      const cx = sx / n, cy = sy / n;
      const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
      out.push({ n, cx, cy, x0, x1, y0, y1, l1, l2 });
    }
    return out;
  }

  // ---------------------------------------------------------------- circle fitting

  function fitCircleKasa(pts) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p[0]; sy += p[1]; }
    const mx = sx / pts.length, my = sy / pts.length;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const p of pts) {
      const u = p[0] - mx, v = p[1] - my;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-18) return null;
    const bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
    const uc = (bu * svv - bv * suv) / det, vc = (suu * bv - suv * bu) / det;
    const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
    return { cx: uc + mx, cy: vc + my, r };
  }

  function fitCircleGeometric(pts, init) {
    let { cx, cy, r } = init;
    for (let it = 0; it < 12; it++) {
      let JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Jtr = [0, 0, 0];
      for (const p of pts) {
        const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1e-12;
        const J = [-dx / d, -dy / d, -1], res = d - r;
        for (let i = 0; i < 3; i++) { Jtr[i] += J[i] * res; for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j]; }
      }
      const step = solve(JtJ, Jtr.map((v) => -v));
      if (!step) break;
      cx += step[0]; cy += step[1]; r += step[2];
      if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-9) break;
    }
    return { cx, cy, r };
  }

  function median(a) {
    const s = Float64Array.from(a).sort();
    const n = s.length;
    return n ? (n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN;
  }

  // Robust fit: Kasa init, iterative outlier rejection, geometric refinement.
  function robustCircle(pts, minResid) {
    let use = pts.slice();
    let fit = null;
    for (let pass = 0; pass < 4; pass++) {
      if (use.length < 8) return null;
      const k = fitCircleKasa(use);
      if (!k) return null;
      fit = fitCircleGeometric(use, k);
      const res = pts.map((p) => Math.abs(Math.hypot(p[0] - fit.cx, p[1] - fit.cy) - fit.r));
      const mad = median(res);
      const lim = Math.max(minResid, 3 * 1.4826 * mad);
      const next = pts.filter((p, i) => res[i] <= lim);
      if (next.length === use.length) { use = next; break; }
      use = next;
    }
    if (!fit || use.length < 8) return null;
    let ss = 0;
    for (const p of use) { const e = Math.hypot(p[0] - fit.cx, p[1] - fit.cy) - fit.r; ss += e * e; }
    fit.rms = Math.sqrt(ss / use.length);
    fit.inliers = use;
    fit.inlierFraction = use.length / pts.length;
    return fit;
  }

  // ---------------------------------------------------------------- bore measurement

  function gaussSmooth(a, sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let j = -r; j <= r; j++) {
        const t = i + j;
        if (t < 0 || t >= n || Number.isNaN(a[t])) continue;
        s += a[t] * k[j + r]; ws += k[j + r];
      }
      out[i] = ws ? s / ws : NaN;
    }
    return out;
  }

  function pixelsPerMm(H, x, y) {
    const p = applyH(H, x, y), px = applyH(H, x + 1, y), py = applyH(H, x, y + 1);
    return 0.5 * (Math.hypot(px[0] - p[0], px[1] - p[1]) + Math.hypot(py[0] - p[0], py[1] - p[1]));
  }

  // Radial profiles from c (mm). Returns per-ray edge data.
  function castRays(gray, w, h, H, c, R, nRays, dr, ppm) {
    const nS = Math.min(6000, Math.max(20, Math.ceil(R / dr)));
    const rays = [];
    for (let k = 0; k < nRays; k++) {
      const t = (2 * Math.PI * k) / nRays, ct = Math.cos(t), st = Math.sin(t);
      const prof = new Float64Array(nS);
      for (let i = 0; i < nS; i++) {
        const r = (i + 1) * dr;
        const p = applyH(H, c[0] + r * ct, c[1] + r * st);
        prof[i] = bilinear(gray, w, h, p[0], p[1]);
      }
      // smooth over ~0.8 image pixel and differentiate over ~1 pixel, so the
      // derivative is in grey levels per pixel and robust to sensor noise
      const spp = Math.max(1, Math.round(1 / (dr * ppm)));
      const sm = gaussSmooth(prof, Math.max(1.5, 0.8 * spp));
      const d = new Float64Array(nS);
      for (let i = spp; i < nS - spp; i++) d[i] = (sm[i + spp] - sm[i - spp]) / 2;
      let gmax = 0;
      const ad = [];
      for (let i = 1; i < nS - 1; i++) { const v = Math.abs(d[i]); ad.push(v); if (v > gmax) gmax = v; }
      // robust noise level of the derivative along this ray: lower quartile
      // of |d| (a short ray is mostly edges, so the median would read signal)
      const sad = Float64Array.from(ad).sort();
      const noise = sad.length ? sad[Math.floor(sad.length / 4)] / 0.3186 : 0;
      rays.push({ t, ct, st, d, gmax, noise, nS });
    }
    return rays;
  }

  function peakSubpixel(d, i) {
    const a = Math.abs(d[i - 1]), b = Math.abs(d[i]), c = Math.abs(d[i + 1]);
    const den = a - 2 * b + c;
    const off = den !== 0 ? 0.5 * (a - c) / den : 0;
    return i + Math.max(-0.5, Math.min(0.5, off));
  }

  function firstEdge(ray, thr, startIdx) {
    const d = ray.d;
    for (let i = Math.max(2, startIdx); i < ray.nS - 2; i++) {
      const v = Math.abs(d[i]);
      if (v >= thr && v >= Math.abs(d[i - 1]) && v >= Math.abs(d[i + 1])) {
        // climb to the local maximum of this lobe
        let j = i;
        while (j < ray.nS - 2 && Math.abs(d[j + 1]) > Math.abs(d[j]) && Math.sign(d[j + 1]) === Math.sign(d[j])) j++;
        return { idx: peakSubpixel(d, j), sign: Math.sign(d[j]), i: j };
      }
    }
    return null;
  }

  /**
   * Measure the bore around seed, in the coordinates H maps from (mm or px).
   *   searchRadius  how far rays travel (default 15)
   *   maxRms        largest acceptable fit residual
   *   nRays         number of rays (default 180)
   *   measureOuter  also estimate OD / wall (default true)
   */
  function measureBore(gray, w, h, H, seed, opts) {
    opts = opts || {};
    const R = opts.searchRadius || 15;
    const nRays = opts.nRays || 180;
    let c = seed.slice();
    const ppm = pixelsPerMm(H, c[0], c[1]);
    if (!(ppm > 0.5)) return { ok: false, reason: 'scale' };
    const dr = 0.35 / ppm;
    const minResid = 0.6 / ppm;
    let fit = null, rays = null, edges = null, sign = 0, lastThr = 0;

    for (let pass = 0; pass < 4; pass++) {
      rays = castRays(gray, w, h, H, c, R, nRays, dr, ppm);
      const gm = median(rays.map((r) => r.gmax));
      if (!(gm > 3)) return { ok: false, reason: 'contrast' };
      const nz = median(rays.map((r) => r.noise));
      const thr = Math.max(0.08 * gm, Math.min(6 * nz, 0.5 * gm), 2);
      lastThr = thr;
      edges = rays.map((r) => firstEdge(r, thr, 2));
      let pos = 0, neg = 0;
      for (const e of edges) if (e) { if (e.sign > 0) pos++; else neg++; }
      sign = pos >= neg ? 1 : -1;
      const pts = [];
      edges.forEach((e, k) => {
        if (!e || e.sign !== sign) return;
        const r = (e.idx + 1) * dr;
        const p = [c[0] + r * rays[k].ct, c[1] + r * rays[k].st];
        p.k = k;
        pts.push(p);
      });
      if (pts.length < nRays * 0.3) return { ok: false, reason: 'edges' };
      const f2 = robustCircle(pts, minResid);
      if (!f2) return { ok: false, reason: 'fit' };
      const moved = Math.hypot(f2.cx - c[0], f2.cy - c[1]);
      fit = f2;
      // The seed must be inside the circle, otherwise it was not in the bore.
      if (Math.hypot(seed[0] - f2.cx, seed[1] - f2.cy) > f2.r) return { ok: false, reason: 'seed' };
      c = [f2.cx, f2.cy];
      if (moved < 2 * dr) break;
    }

    // Final pass from fitted centre: per-ray radii for ovality.
    const radii = new Float64Array(nRays).fill(NaN);
    const inlierSet = new Set(fit.inliers.map((p) => p.k));
    fit.inliers.forEach((p) => { radii[p.k] = Math.hypot(p[0] - fit.cx, p[1] - fit.cy); });
    const diam = [];
    for (let k = 0; k < nRays / 2; k++) {
      const a = radii[k], b = radii[k + nRays / 2];
      if (!Number.isNaN(a) && !Number.isNaN(b)) diam.push(a + b);
    }
    let dmin = NaN, dmax = NaN;
    if (diam.length >= 6) {
      // light smoothing so single noisy rays do not dominate ovality
      const sm = diam.map((_, i) => median([diam[(i - 1 + diam.length) % diam.length], diam[i], diam[(i + 1) % diam.length]]));
      dmin = Math.min(...sm); dmax = Math.max(...sm);
    }

    // Outer edge (OD) : strongest opposite-sign edge beyond the inner edge.
    let outer = null;
    if (opts.measureOuter !== false) {
      const pts = [];
      rays.forEach((ray, k) => {
        const e = edges[k];
        if (!e || !inlierSet.has(k)) return;
        // next significant edge after the bore edge (either polarity)
        const start = e.i + Math.max(4, Math.round(0.05 / dr));
        const nx = firstEdge(ray, lastThr, start);
        if (nx) {
          const r = (nx.idx + 1) * dr;
          const p = [c[0] + r * ray.ct, c[1] + r * ray.st];
          pts.push(p);
        }
      });
      if (pts.length > nRays * 0.4) {
        const of = robustCircle(pts, minResid);
        if (of && of.inlierFraction > 0.6 && Math.hypot(of.cx - fit.cx, of.cy - fit.cy) < 0.15 * of.r && of.r > fit.r * 1.02) {
          outer = { diameter: 2 * of.r, cx: of.cx, cy: of.cy, rms: of.rms, points: of.inliers.map((p) => [p[0], p[1]]) };
        }
      }
    }

    const quality = {
      rmsMm: fit.rms,
      inlierFraction: fit.inliers.length / nRays,
      pxPerMm: ppm,
      resolutionMm: 1 / ppm,
    };
    const maxRms = opts.maxRms != null ? opts.maxRms : Math.max(0.03, 1.5 / ppm);
    const ok = quality.inlierFraction > 0.6 && fit.rms < maxRms && 2 * fit.r < 2 * R * 0.98;
    // Fewer than ~30 px across the bore is too coarse for a reliable edge.
    const borepx = 2 * fit.r * ppm;
    const warning = borepx < 30 ? 'low-resolution' : null;
    return {
      ok,
      warning,
      borePx: borepx,
      reason: ok ? null : 'quality',
      diameter: 2 * fit.r,
      center: [fit.cx, fit.cy],
      dMin: dmin,
      dMax: dmax,
      ovality: dmax - dmin,
      polarity: sign > 0 ? 'dark-bore' : 'bright-bore',
      outer,
      wall: outer ? (outer.diameter - 2 * fit.r) / 2 : null,
      quality,
      edgePoints: fit.inliers.map((p) => [p[0], p[1]]),
    };
  }

  // Otsu threshold of a histogram (256 bins).
  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  // ---------------------------------------------------------------- ellipse

  // Algebraic ellipse fit. Returns {c:[x,y], M:2x2} with (x-c)^T M (x-c) = 1,
  // plus semi-axes a >= b.
  function fitEllipse(pts) {
    if (pts.length < 8) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sc = 0;
    for (const p of pts) sc += Math.hypot(p[0] - mx, p[1] - my);
    sc = sc / pts.length || 1;
    // a x^2 + b xy + c y^2 + d x + e y = 1 in normalised coordinates
    const A = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    const B = [0, 0, 0, 0, 0];
    for (const p of pts) {
      const x = (p[0] - mx) / sc, y = (p[1] - my) / sc;
      const r = [x * x, x * y, y * y, x, y];
      for (let i = 0; i < 5; i++) { B[i] += r[i]; for (let j = 0; j < 5; j++) A[i][j] += r[i] * r[j]; }
    }
    const q = solve(A, B);
    if (!q) return null;
    const [a, b, c, d, e] = q;
    const det = 4 * a * c - b * b;
    if (!(det > 0)) return null;
    const x0 = (b * e - 2 * c * d) / det, y0 = (b * d - 2 * a * e) / det;
    const F = 1 - (a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + d * x0 + e * y0);
    if (!(F > 0)) return null;
    // back to pixel units: M = [[a, b/2],[b/2, c]] / (F * sc^2)
    const k = 1 / (F * sc * sc);
    const M = [[a * k, (b / 2) * k], [(b / 2) * k, c * k]];
    const tr = M[0][0] + M[1][1], dt = M[0][0] * M[1][1] - M[0][1] * M[0][1];
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    if (!(l2 > 0)) return null;
    return { c: [mx + x0 * sc, my + y0 * sc], M, a: 1 / Math.sqrt(l2), b: 1 / Math.sqrt(l1) };
  }

  // Symmetric 2x2 inverse square root.
  function invSqrt2(M) {
    const a = M[0][0], b = M[0][1], d = M[1][1];
    const tr = a + d, det = a * d - b * b;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    let v1;
    if (Math.abs(b) > 1e-15) v1 = [l1 - d, b]; else v1 = a >= d ? [1, 0] : [0, 1];
    const n = Math.hypot(v1[0], v1[1]); v1 = [v1[0] / n, v1[1] / n];
    const v2 = [-v1[1], v1[0]];
    const s1 = 1 / Math.sqrt(l1), s2 = 1 / Math.sqrt(l2);
    return [
      [s1 * v1[0] * v1[0] + s2 * v2[0] * v2[0], s1 * v1[0] * v1[1] + s2 * v2[0] * v2[1]],
      [s1 * v1[1] * v1[0] + s2 * v2[1] * v2[0], s1 * v1[1] * v1[1] + s2 * v2[1] * v2[1]],
    ];
  }

  // Map from a plane where the ellipse is a circle of radius R (in mm) to pixels.
  function ellipseToH(el, R) {
    const S = invSqrt2(el.M);
    return [[S[0][0] / R, S[0][1] / R, el.c[0]], [S[1][0] / R, S[1][1] / R, el.c[1]], [0, 0, 1]];
  }

  // ---------------------------------------------------------------- finding the tube

  // Candidate seed points (image px): round dark or bright blobs, nearest the
  // image centre first. The operator frames the tube end roughly centred.
  function findSeedsPx(gray, w, h) {
    const f = Math.max(1, Math.ceil(Math.max(w, h) / 640));
    const s = downscale(gray, w, h, f);
    const W = s.w, H = s.h, img = s.img;
    const hist = new Float64Array(256);
    const x0 = Math.floor(W * 0.15), x1 = Math.ceil(W * 0.85), y0 = Math.floor(H * 0.15), y1 = Math.ceil(H * 0.85);
    let cnt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[img[y * W + x]]++; cnt++; }
    const t = otsu(hist, cnt);
    const seeds = [];
    for (const dark of [true, false]) {
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) mask[i] = dark ? img[i] < t : img[i] >= t;
      for (const c of components(mask, W, H)) {
        if (c.n < 12) continue;
        if (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= W - 1 || c.y1 >= H - 1) continue;
        const fill = c.n / (4 * Math.PI * Math.sqrt(c.l1 * c.l2));
        if (fill < 0.75 || fill > 1.25 || Math.sqrt(c.l1 / c.l2) > 1.7) continue;
        const px = (c.cx + 0.5) * f - 0.5, py = (c.cy + 0.5) * f - 0.5;
        const dist = Math.hypot(px - w / 2, py - h / 2) / Math.min(w, h);
        seeds.push({ p: [px, py], score: dist + 0.5 * Math.abs(1 - fill) });
      }
    }
    seeds.sort((a, b) => a.score - b.score);
    return seeds.map((q) => q.p);
  }

  // Stage 1: bore and outer edge in pixel space.
  function locateTube(gray, w, h, seedPx, needOuter) {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const R = 0.48 * Math.min(w, h);
    const base = { searchRadius: R, nRays: 96, measureOuter: true };
    const lenient = (r) => r.diameter && r.quality && r.quality.inlierFraction > 0.6 && r.quality.rmsMm < Math.max(1.5, 0.03 * r.diameter / 2);
    const seeds = [];
    if (seedPx) seeds.push(seedPx);
    for (const s of findSeedsPx(gray, w, h).slice(0, 6)) seeds.push(s);
    seeds.push([w / 2, h / 2]);
    // Seeds are ordered: tap first, then round blobs nearest the centre.
    for (const s of seeds) {
      const r = measureBore(gray, w, h, I, s, base);
      if (!lenient(r)) continue;
      if (needOuter && !r.outer) continue;
      return r;
    }
    return null;
  }

  /**
   * Full pipeline on one grayscale frame, no reference card.
   * opts.mode    'od'     scale from the nominal outer diameter (opts.odMm)
   *              'fixed'  scale from a holder calibration (opts.pxPerMm)
   *              'px'     no scale, results in pixels (used to calibrate)
   * opts.seedPx  optional tap position in image pixels
   */
  function measureTube(gray, w, h, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const mode = opts.mode || 'od';
    if (mode === 'od' && !(opts.odMm > 0)) return { ok: false, stage: 'input', reason: 'Enter the nominal OD' };
    if (mode === 'fixed' && !(opts.pxPerMm > 0)) return { ok: false, stage: 'input', reason: 'Calibrate the holder first' };

    const s1 = locateTube(gray, w, h, opts.seedPx, mode === 'od');
    if (!s1) return { ok: false, stage: 'tube', reason: mode === 'od' ? 'Tube end not found (bore and outer edge)' : 'Bore not found' };

    // Build the mm -> px map.
    let H, R, el = null;
    if (s1.outer) el = fitEllipse(s1.outer.points);
    if (mode === 'od') {
      if (!el) return { ok: false, stage: 'tube', reason: 'Outer edge not clear enough' };
      R = opts.odMm / 2;
      H = ellipseToH(el, R);
    } else {
      const p = mode === 'fixed' ? opts.pxPerMm : 1;
      if (el) {
        // holder: the major axis is not foreshortened by a small tilt
        R = el.a / p;
        H = ellipseToH(el, R);
      } else {
        R = s1.diameter / 2 / p * 1.3;
        H = [[p, 0, s1.center[0]], [0, p, s1.center[1]], [0, 0, 1]];
      }
    }
    const Hi = matInv(H);
    const seed = applyH(Hi, s1.center[0], s1.center[1]);
    const r = measureBore(gray, w, h, H, seed, {
      searchRadius: R * 1.35,
      nRays: opts.nRays || 180,
      maxRms: mode === 'px' ? Math.max(1.5, 0.01 * s1.diameter) : undefined,
    });
    const out = Object.assign({ stage: 'bore', mode, H, ms: Date.now() - t0, ellipse: el }, r);
    if (!r.ok) out.reason = 'Bore edge unclear';
    if (mode === 'od' && r.outer) {
      // The OD found in the rectified plane should equal the nominal OD.
      out.odCheck = r.outer.diameter / opts.odMm - 1;
    }
    return out;
  }

  const api = {
    rgbaToGray, applyH, matInv, homography, measureBore, measureTube, locateTube, findSeedsPx,
    fitEllipse, ellipseToH, fitCircleKasa, robustCircle, pixelsPerMm, median,
  };
  root.TubeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
