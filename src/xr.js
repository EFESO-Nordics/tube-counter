/*
 * Bore Gauge: Auto mode session (ARCore through Chrome's WebXR).
 *
 * Starts an immersive AR session with raw camera access. Each captured frame
 * (camera image + the phone's tracked pose in metres + projection matrix) goes
 * to the measurement worker. The worker returns the detected edges and, once
 * the phone has moved enough, the bore diameter in millimetres.
 */
(function (root) {
  'use strict';

  const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `#version 300 es
precision mediump float;
in vec2 uv; uniform sampler2D cam; out vec4 o;
void main() { o = texture(cam, uv); }`;

  async function supported() {
    try {
      return !!(navigator.xr && window.XRWebGLBinding && (await navigator.xr.isSessionSupported('immersive-ar')));
    } catch (e) { return false; }
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  /**
   * start({ overlay, workerUrl, onResult(result, frameInfo), onStatus(text), onEnd() })
   * Returns a controller { stop(), reset() }.
   */
  async function start(opts) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available on this phone.');
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['camera-access', 'local'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: opts.overlay },
    });
    await gl.makeXRCompatible();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    const refSpace = await session.requestReferenceSpace('local');
    const binding = new XRWebGLBinding(session, gl);

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const locP = gl.getAttribLocation(prog, 'p');
    const locCam = gl.getUniformLocation(prog, 'cam');

    let fbo = null, fboTex = null, fw = 0, fh = 0;
    function ensureFbo(w, h) {
      if (fbo && fw === w && fh === h) return;
      if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); }
      fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      fw = w; fh = h;
    }

    const worker = new Worker(opts.workerUrl);
    let busy = false, lastSend = 0, stopped = false;
    worker.onmessage = (e) => { busy = false; opts.onResult(e.data, { w: fw, h: fh }); };

    function onFrame(t, frame) {
      if (stopped) return;
      session.requestAnimationFrame(onFrame);
      const pose = frame.getViewerPose(refSpace);
      if (!pose) { opts.onStatus('tracking'); return; }
      const view = pose.views[0];
      if (!view.camera) { opts.onStatus('no-camera'); return; }
      if (pose.emulatedPosition) { opts.onStatus('tracking'); return; }
      if (busy || t - lastSend < 120) return;

      const camTex = binding.getCameraImage(view.camera);
      if (!camTex) return;
      const s = Math.min(1, 1600 / Math.max(view.camera.width, view.camera.height));
      const w = Math.round(view.camera.width * s), h = Math.round(view.camera.height * s);
      ensureFbo(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(locP);
      gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, camTex);
      gl.uniform1i(locCam, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const rgba = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);

      busy = true; lastSend = t;
      worker.postMessage({
        type: 'frame', t, w, h, rgba: rgba.buffer,
        pose: Array.from(view.transform.matrix), projection: Array.from(view.projectionMatrix),
      }, [rgba.buffer]);
      opts.onStatus('ok');
    }
    session.requestAnimationFrame(onFrame);
    session.addEventListener('end', () => { stopped = true; worker.terminate(); opts.onEnd(); });

    return {
      stop() { if (!stopped) session.end().catch(() => {}); },
      reset() { worker.postMessage({ type: 'reset' }); },
    };
  }

  root.TubeXR = { supported, start };
})(typeof self !== 'undefined' ? self : globalThis);
