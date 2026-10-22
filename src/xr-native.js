/*
 * Tube Counter: AR size step inside the iPhone app (ARKit).
 *
 * Inside the native iPhone app, Safari's engine has no WebXR. The app runs
 * ARKit itself: it shows the camera behind this page, measures each frame
 * with the same JavaScript (core.js, auto.js, worker.js) in JavaScriptCore,
 * and calls window.TubeNative.onResult with the worker's result. This file
 * gives the page the same TubeXR interface as the browser version, so
 * app.js does not change.
 *
 * Native -> page:  TubeNative.onResult(result, view), onStatus(text), onEnded()
 *   view = { a, b, c, d, tx, ty, iw, ih, vw, vh }: the display transform from
 *   normalised image coordinates to normalised view coordinates, the image
 *   size in pixels and the view size in points (CSS pixels).
 * Page -> native:  webkit.messageHandlers.tubeAR.postMessage({cmd: 'start' |
 *   'stop' | 'reset' | 'share', text, filename})
 */
(function (root) {
  'use strict';
  const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.tubeAR;
  if (!root.TC_NATIVE || !handler) return;
  const post = (m) => { try { handler.postMessage(m); } catch (e) { /* app gone */ } };
  document.documentElement.classList.add('native');

  let current = null;

  // Image pixel -> view CSS pixel, using ARKit's display transform.
  function mapper(v) {
    return (p) => {
      const x = p[0] / v.iw, y = p[1] / v.ih;
      return [(v.a * x + v.c * y + v.tx) * v.vw, (v.b * x + v.d * y + v.ty) * v.vh];
    };
  }

  function end() {
    document.documentElement.classList.remove('ar-native-on');
    const c = current;
    current = null;
    if (c && c.onEnd) c.onEnd();
  }

  root.TubeNative = {
    onResult(data, view) {
      if (!current) return;
      const map = mapper(view);
      const d = Object.assign({}, data);
      if (d.idPts) d.idPts = d.idPts.map(map);
      if (d.odPts) d.odPts = d.odPts.map(map);
      if (d.center) d.center = map(d.center);
      current.onResult(d, { w: view.vw, h: view.vh });
    },
    onStatus(s) { if (current && current.onStatus) current.onStatus(s); },
    onEnded() { end(); },
    onError(message) {
      const c = current;
      end();
      if (c && c.onError) c.onError(message);
    },
  };

  root.TubeXR = {
    supported: async () => !!(root.TC_NATIVE && root.TC_NATIVE.ar),
    start: async (opts) => {
      current = opts;
      document.documentElement.classList.add('ar-native-on');
      post({ cmd: 'start' });
      return {
        stop() { post({ cmd: 'stop' }); end(); },
        reset() { post({ cmd: 'reset' }); },
      };
    },
  };

  // CSV exports go through the iPhone share sheet (Save to Files, Mail, ...).
  root.TubeNativeShare = (text, filename) => post({ cmd: 'share', text, filename });
})(typeof self !== 'undefined' ? self : globalThis);
