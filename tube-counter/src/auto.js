/*
 * Bore Gauge: scale from motion (no reference, no input).
 *
 * ARCore tracks the phone's position in real millimetres. While the operator
 * holds the phone at the tube end and moves it slightly, the bore centre is
 * seen along a different ray from every frame. Intersecting those rays gives
 * the 3D position of the tube end, hence its distance from the camera in each
 * frame, hence millimetres per pixel.
 *
 * Conventions follow WebXR: camera space x right, y up, looking down -z.
 * Poses are column-major 4x4 camera-to-world matrices (XRRigidTransform.matrix).
 */
(function (root) {
  'use strict';

  // Intrinsics (top-left pixel origin) from a WebXR projection matrix and the
  // size of the image that matches the view's viewport.
  function intrinsics(p, W, H) {
    return { fx: (p[0] * W) / 2, fy: (p[5] * H) / 2, cx: ((1 - p[8]) * W) / 2, cy: ((1 + p[9]) * H) / 2 };
  }

  function pixelRay(K, m, u, v) {
    let x = (u - K.cx) / K.fx, y = -(v - K.cy) / K.fy, z = -1;
    const n = Math.hypot(x, y, z); x /= n; y /= n; z /= n;
    const d = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
    return { o: [m[12], m[13], m[14]], d };
  }

  function solve3(A, b) {
    const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
    const C0 = e * i - f * h, C1 = -(d * i - f * g), C2 = d * h - e * g;
    const det = a * C0 + bb * C1 + c * C2;
    if (Math.abs(det) < 1e-18) return null;
    const inv = [
      [C0, -(bb * i - c * h), bb * f - c * e],
      [C1, a * i - c * g, -(a * f - c * d)],
      [C2, -(a * h - bb * g), a * e - bb * d],
    ];
    return [0, 1, 2].map((r) => (inv[r][0] * b[0] + inv[r][1] * b[1] + inv[r][2] * b[2]) / det);
  }

  // Least-squares intersection of rays, with a robust second pass.
  function triangulate(rays) {
    if (rays.length < 4) return null;
    let use = rays, P = null;
    for (let pass = 0; pass < 2; pass++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (const r of use) {
        const d = r.d;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          const q = (i === j ? 1 : 0) - d[i] * d[j];
          A[i][j] += q; b[i] += q * r.o[j];
        }
      }
      P = solve3(A, b);
      if (!P) return null;
      const dist = rays.map((r) => rayDistance(r, P));
      const sorted = dist.slice().sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      const rng = rays.reduce((s, r) => s + Math.hypot(P[0] - r.o[0], P[1] - r.o[1], P[2] - r.o[2]), 0) / rays.length;
      const next = rays.filter((r, k) => dist[k] <= Math.max(3 * med, 0.003 * rng));
      if (next.length < 4 || next.length === use.length) break;
      use = next;
    }
    // Baseline: spread of camera positions across the viewing direction.
    let md = [0, 0, 0];
    for (const r of use) { md[0] += r.d[0]; md[1] += r.d[1]; md[2] += r.d[2]; }
    const nm = Math.hypot(md[0], md[1], md[2]); md = md.map((v) => v / nm);
    let base = 0;
    for (let i = 0; i < use.length; i++) for (let j = i + 1; j < use.length; j++) {
      const dx = [use[i].o[0] - use[j].o[0], use[i].o[1] - use[j].o[1], use[i].o[2] - use[j].o[2]];
      const along = dx[0] * md[0] + dx[1] * md[1] + dx[2] * md[2];
      const perp = Math.sqrt(Math.max(0, dx[0] ** 2 + dx[1] ** 2 + dx[2] ** 2 - along * along));
      if (perp > base) base = perp;
    }
    const range = use.reduce((s, r) => s + Math.hypot(P[0] - r.o[0], P[1] - r.o[1], P[2] - r.o[2]), 0) / use.length;
    const resid = Math.sqrt(use.reduce((s, r) => s + rayDistance(r, P) ** 2, 0) / use.length);
    return { P, baseline: base, range, resid, used: use.length };
  }

  function rayDistance(r, P) {
    const v = [P[0] - r.o[0], P[1] - r.o[1], P[2] - r.o[2]];
    const t = v[0] * r.d[0] + v[1] * r.d[1] + v[2] * r.d[2];
    return Math.hypot(v[0] - t * r.d[0], v[1] - t * r.d[1], v[2] - t * r.d[2]);
  }

  // Distance from the camera to P along the optical axis (the depth).
  function depthOf(m, P) {
    const v = [P[0] - m[12], P[1] - m[13], P[2] - m[14]];
    // camera -z axis in world coordinates is -(m[8], m[9], m[10])
    return -(v[0] * m[8] + v[1] * m[9] + v[2] * m[10]);
  }

  // ---------------------------------------------------------------- 3D circle

  function norm3(v) { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // Circle fit (Kasa) on 2D points; returns {r, rms}.
  function circle2(xs, ys, n) {
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (let i = 0; i < n; i++) {
      const u = xs[i] - mx, v = ys[i] - my;
      suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-30) return null;
    const bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
    const uc = (bu * svv - bv * suv) / det, vc = (suu * bv - suv * bu) / det;
    const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    let ss = 0;
    for (let i = 0; i < n; i++) { const e = Math.hypot(xs[i] - mx - uc, ys[i] - my - vc) - r; ss += e * e; }
    return { r, rms: Math.sqrt(ss / n), cx: uc + mx, cy: vc + my };
  }

  // Back-project a frame's edge pixels onto the plane (P, n); fit a circle there.
  function frameCircle(sample, pts, P, n, e1, e2, step) {
    const K = sample.K, m = sample.m;
    const o = [m[12], m[13], m[14]];
    const cnt = Math.ceil(pts.length / step);
    const xs = new Float64Array(cnt), ys = new Float64Array(cnt);
    let k = 0;
    const PO = [P[0] - o[0], P[1] - o[1], P[2] - o[2]];
    const num = dot(n, PO);
    for (let i = 0; i < pts.length; i += step) {
      const x = (pts[i][0] - K.cx) / K.fx, y = -(pts[i][1] - K.cy) / K.fy;
      const d = [m[0] * x + m[4] * y - m[8], m[1] * x + m[5] * y - m[9], m[2] * x + m[6] * y - m[10]];
      const den = dot(n, d);
      if (Math.abs(den) < 1e-9) continue;
      const t = num / den;
      const X = [o[0] + t * d[0] - P[0], o[1] + t * d[1] - P[1], o[2] + t * d[2] - P[2]];
      xs[k] = dot(X, e1); ys[k] = dot(X, e2); k++;
    }
    return k >= 8 ? circle2(xs, ys, k) : null;
  }

  function planeBasis(n) {
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm3(cross(n, a));
    return [e1, cross(n, e1)];
  }

  // Cost of a plane (P, n): every frame's back-projected edge must be a circle,
  // with the same radius and the same centre in every frame. A plane at the
  // wrong depth or angle makes the centres drift between viewpoints.
  function planeCost(S, key, P, n, step) {
    const [e1, e2] = planeBasis(n);
    const rs = [], cxs = [], cys = [];
    let fitErr = 0;
    for (const s of S) {
      const c = frameCircle(s, s[key], P, n, e1, e2, step);
      if (!c) continue;
      rs.push(c.r); cxs.push(c.cx); cys.push(c.cy); fitErr += (c.rms / c.r) ** 2;
    }
    if (rs.length < 4) return { cost: Infinity };
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const vr = (a) => { const m = mean(a); return a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length; };
    const rm = mean(rs);
    const cost = fitErr / rs.length + vr(rs) / (rm * rm) + (vr(cxs) + vr(cys)) / (rm * rm);
    return { cost, rs };
  }

  function searchNormal(S, key, P, n0, spans) {
    const [u, v] = planeBasis(n0);
    const at = (a, b) => norm3([n0[0] + a * u[0] + b * v[0], n0[1] + a * u[1] + b * v[1], n0[2] + a * u[2] + b * v[2]]);
    let best = { a: 0, b: 0, cost: planeCost(S, key, P, n0, 2).cost };
    for (const [span, stepDeg, ptsStep] of spans) {
      const ca = best.a, cb = best.b;
      for (let i = -span; i <= span + 1e-9; i += stepDeg) for (let j = -span; j <= span + 1e-9; j += stepDeg) {
        const a = Math.tan(Math.atan(ca) + (i * Math.PI) / 180), b = Math.tan(Math.atan(cb) + (j * Math.PI) / 180);
        const r = planeCost(S, key, P, at(a, b), ptsStep);
        if (r.cost < best.cost) best = { a, b, cost: r.cost };
      }
    }
    return { n: at(best.a, best.b), cost: best.cost };
  }

  function searchDepth(S, key, P, n, range) {
    let best = { d: 0, cost: planeCost(S, key, P, n, 2).cost };
    for (const [span, step] of [[0.1, 0.005], [0.006, 0.0005], [0.0006, 0.00005]]) {
      const c0 = best.d;
      for (let k = -span; k <= span + 1e-12; k += step) {
        const d = c0 + k * range;
        const Q = [P[0] + d * n[0], P[1] + d * n[1], P[2] + d * n[2]];
        const r = planeCost(S, key, Q, n, 2);
        if (r.cost < best.cost) best = { d, cost: r.cost };
      }
    }
    return [P[0] + best.d * n[0], P[1] + best.d * n[1], P[2] + best.d * n[2]];
  }

  // Plane of the tube end: orientation and depth that make all views agree.
  function findPlane(S, key, P, range) {
    let c = [0, 0, 0];
    for (const s of S) { c[0] += s.m[12] - P[0]; c[1] += s.m[13] - P[1]; c[2] += s.m[14] - P[2]; }
    const n0 = norm3(c);
    const sub = S.length > 12 ? S.filter((_, i) => i % Math.ceil(S.length / 12) === 0) : S;
    const tilt = (n) => (Math.acos(Math.min(1, Math.abs(dot(n, n0)))) * 180) / Math.PI;
    // Radius as seen from the cameras: a circle that subtends a small angle
    // does not reveal its own tilt reliably, so assume it faces the cameras.
    const pc = planeCost(sub, key, P, n0, 2);
    const rAng = pc.rs ? pc.rs.reduce((a, b) => a + b, 0) / pc.rs.length / range : 0;
    let n = n0, Q = P, fixedTilt = rAng < 0.03;
    if (!fixedTilt) {
      n = searchNormal(sub, key, P, n0, [[28, 4, 4], [5, 1, 2]]).n;
      Q = searchDepth(sub, key, P, n, range);
      n = searchNormal(sub, key, Q, n, [[3, 0.5, 2], [0.6, 0.1, 1]]).n;
      if (tilt(n) > 25) { n = n0; Q = P; fixedTilt = true; }
    }
    Q = searchDepth(sub, key, Q, n, range);
    return { n, P: Q, tiltDeg: tilt(n), fixedTilt };
  }

  /**
   * Accumulates per-frame observations and produces a millimetre reading.
   * Each sample: { m: pose (column-major), K, u, v, idPts: [[x,y]...], odPts }
   * with edge points in image pixels. unitsPerMm: 1000 if poses are in metres
   * (WebXR), 1 if in millimetres.
   */
  function AutoScale(opts) {
    opts = opts || {};
    this.unitsPerMm = opts.unitsPerMm || 1000;
    this.max = opts.maxSamples || 60;
    this.samples = [];
  }
  AutoScale.prototype.reset = function () { this.samples = []; };
  AutoScale.prototype.add = function (s) {
    this.samples.push(s);
    if (this.samples.length > this.max) this.samples.shift();
  };
  AutoScale.prototype.estimate = function () {
    const S = this.samples;
    if (S.length < 6) return { ready: false, reason: 'collecting', n: S.length, progress: (S.length / 6) * 0.3 };
    const rays = S.map((s) => pixelRay(s.K, s.m, s.u, s.v));
    const tri = triangulate(rays);
    if (!tri) return { ready: false, reason: 'geometry', n: S.length, progress: 0.3 };
    const baseMm = tri.baseline * this.unitsPerMm, rangeMm = tri.range * this.unitsPerMm;
    // Sideways movement of at least ~10 % of the distance (min 12 mm).
    const need = Math.max(12, 0.1 * rangeMm);
    const progress = Math.min(1, 0.3 + (0.7 * baseMm) / need);
    if (baseMm < need) return { ready: false, reason: 'move', n: S.length, progress, baselineMm: baseMm, rangeMm, needMm: need };

    // Fit the plane on the larger circle (outer edge) when most frames have it.
    const withOdAll = S.filter((s) => s.odPts && s.odPts.length >= 8);
    const planeSet = withOdAll.length >= Math.max(6, 0.6 * S.length) ? withOdAll : S;
    const plane = findPlane(planeSet, planeSet === S ? 'idPts' : 'odPts', tri.P, tri.range);
    const { n, tiltDeg, fixedTilt } = plane;
    const idc = planeCost(S, 'idPts', plane.P, n, 1);
    if (!idc.rs) return { ready: false, reason: 'geometry', n: S.length, progress };
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); const k = b.length; return k % 2 ? b[k >> 1] : (b[k / 2 - 1] + b[k / 2]) / 2; };
    const toMm = this.unitsPerMm;
    const ids = idc.rs.map((r) => 2 * r * toMm);
    const idm = med(ids);
    const sd = Math.sqrt(ids.reduce((a, v) => a + (v - idm) ** 2, 0) / Math.max(1, ids.length - 1));
    let od = null;
    const withOd = S.filter((s) => s.odPts && s.odPts.length >= 8);
    if (withOd.length >= 4) {
      const oc = planeCost(withOd, 'odPts', plane.P, n, 1);
      if (oc.rs) od = med(oc.rs.map((r) => 2 * r * toMm));
    }
    return {
      ready: true, n: ids.length, progress: 1, id: idm, idSd: sd, od,
      distanceMm: rangeMm, baselineMm: baseMm, tiltDeg, rayResidMm: tri.resid * toMm,
      warning: fixedTilt ? 'small-bore' : null,
    };
  };

  const api = { intrinsics, pixelRay, triangulate, depthOf, AutoScale };
  root.TubeAuto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
