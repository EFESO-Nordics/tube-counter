/* Bore Gauge: measurement worker for Auto mode. Keeps the camera loop smooth. */
/* global TubeCore, TubeAuto */
importScripts('core.js', 'auto.js');

let est = new TubeAuto.AutoScale({ unitsPerMm: 1000, maxSamples: 60 });
let seed = null;
let lastSeen = 0;
let frameCount = 0;
let lastEstimate = null;
let target = null;   // 3D point (metres) of the tracked tube end
let misses = 0;

// Pixel position of world point P in a frame (pose: camera-to-world, column-major).
function project(K, m, P) {
  const v = [P[0] - m[12], P[1] - m[13], P[2] - m[14]];
  const x = v[0] * m[0] + v[1] * m[1] + v[2] * m[2];
  const y = v[0] * m[4] + v[1] * m[5] + v[2] * m[6];
  const z = v[0] * m[8] + v[1] * m[9] + v[2] * m[10];
  if (z >= 0) return null; // behind the camera (camera looks down -z)
  return [K.cx + K.fx * (x / -z), K.cy - K.fy * (y / -z)];
}

function toGray(rgba, w, h) {
  // rows arrive bottom-up from readPixels; flip to top-down
  const g = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w;
    for (let x = 0; x < w; x++) {
      const j = src + x * 4;
      g[dst + x] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
  }
  return g;
}

function subsample(pts, k) {
  const out = [];
  for (let i = 0; i < pts.length; i += k) out.push(pts[i]);
  return out;
}

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'reset') { est.reset(); seed = null; lastEstimate = null; target = null; misses = 0; return; }
  if (msg.type !== 'frame') return;
  const t0 = performance.now();
  const { w, h } = msg;
  // WebXR sends RGBA rows bottom-up; the iPhone app (ARKit) sends the camera's
  // luminance plane top-down as msg.gray.
  const gray = msg.gray ? msg.gray : toGray(new Uint8Array(msg.rgba), w, h);
  // Predict where the tracked tube end appears in this frame: project its 3D
  // position (triangulated so far, or a first guess along the first ray).
  // Camera intrinsics: given directly (ARKit) or from the projection (WebXR).
  const Kp = msg.K ? msg.K : TubeAuto.intrinsics(msg.projection, w, h);
  let predicted = null;
  if (target) {
    const P = est.samples.length >= 4 ? (TubeAuto.triangulate(est.samples.map((sm) => TubeAuto.pixelRay(sm.K, sm.m, sm.u, sm.v))) || {}).P || target : target;
    predicted = project(Kp, msg.pose, P);
    if (predicted && (predicted[0] < 0 || predicted[1] < 0 || predicted[0] >= w || predicted[1] >= h)) predicted = null;
  }
  const r = TubeCore.measureTube(gray, w, h, { mode: 'px', seedPx: predicted || seed || undefined, nRays: 120 });
  const out = { type: 'result', found: false, estimate: lastEstimate, ms: 0 };
  if (r.ok) {
    const toPx = (p) => TubeCore.applyH(r.H, p[0], p[1]);
    const c = toPx(r.center);
    const idPts = r.edgePoints.map(toPx);
    const odPts = r.outer ? r.outer.points.map(toPx) : null;
    // a clearly different bore means a different tube: start over
    const prev = est.samples.length ? est.samples[est.samples.length - 1] : null;
    if (prev && Math.abs(r.diameter / prev.idPxD - 1) > 0.25) { est.reset(); lastEstimate = null; target = null; }
    // In a bundle the neighbours look the same: keep the frame only if the
    // tube found is the one predicted from the phone's movement.
    if (predicted && Math.hypot(c[0] - predicted[0], c[1] - predicted[1]) > 0.45 * r.diameter) {
      if (++misses > 6) { est.reset(); lastEstimate = null; target = null; misses = 0; }
      out.found = false;
      out.ms = Math.round(performance.now() - t0);
      postMessage(out);
      return;
    }
    misses = 0;
    seed = c;
    lastSeen = msg.t;
    if (!target) {
      // first sighting: a point 0.25 m along the ray (refined by triangulation)
      const ray = TubeAuto.pixelRay(Kp, msg.pose, c[0], c[1]);
      target = [ray.o[0] + 0.25 * ray.d[0], ray.o[1] + 0.25 * ray.d[1], ray.o[2] + 0.25 * ray.d[2]];
    }
    est.add({ m: msg.pose, K: Kp, u: c[0], v: c[1], idPts, odPts, idPxD: r.diameter });
    out.found = true;
    out.center = c;
    out.idPts = subsample(idPts, 3);
    out.odPts = odPts ? subsample(odPts, 3) : null;
    out.warning = r.warning;
    if (++frameCount % 3 === 0 || !lastEstimate || !lastEstimate.ready) {
      lastEstimate = est.estimate();
      // Rays to one tube end meet closely; a mix of neighbouring tubes does
      // not. Start over rather than report a wrong size.
      if (lastEstimate.ready && lastEstimate.rayResidMm > Math.max(1.6, 0.1 * (lastEstimate.od || lastEstimate.id * 1.3))) {
        est.reset(); target = null;
        lastEstimate = { ready: false, reason: 'restart', progress: 0, n: 0 };
      }
      out.estimate = lastEstimate;
    }
  } else {
    seed = null;
    if (msg.t - lastSeen > 1500 && est.samples.length) { est.reset(); lastEstimate = null; out.estimate = null; target = null; }
  }
  out.ms = Math.round(performance.now() - t0);
  postMessage(out);
};
