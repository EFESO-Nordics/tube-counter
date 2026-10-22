/* Tube Counter app: photo, counting, per-tube sizes, AR size step, edits, saved counts. */
(function () {
  'use strict';
  const core = window.TubeCount;
  const M = window.TubeMeasure;
  const $ = (s) => document.querySelector(s);
  const SAMPLE = { url: window.TC_SAMPLE || 'assets/sample.jpg', odMm: 25.0 };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tc.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tc.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  let log = store.get('log2', []);
  // scale: { odMm, source: 'ar' | 'nominal' | 'sample' }
  let scale = null;

  const view = $('#view'), ctx = view.getContext('2d');
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const ui = {
    count: $('#val-count'), detail: $('#val-detail'), sub: $('#lcd-sub'), status: $('#status'), statusText: $('#status-text'),
    save: $('#btn-save'), undo: $('#btn-undo'), recount: $('#btn-recount'), finder: $('#finder'),
    id: $('#val-id'), od: $('#val-od'), wall: $('#val-wall'), flag: $('#val-flag'),
    rid: $('#rng-id'), rod: $('#rng-od'), rwall: $('#rng-wall'), rflag: $('#rng-flag'),
    scaleState: $('#scale-state'), info: $('#tube-info'), btnAr: $('#btn-ar'),
  };

  // state
  let photo = null;     // { img, w, h, gray, sample, name }
  let auto = null;      // result of countTubes
  let meas = null;      // result of measureTubes (sizes per tube)
  let marks = [];       // [{x, y, r, src: 'auto'|'added', size}]
  let history = [];
  let tapMode = 'fix';
  let selected = null;

  function setStatus(level, text) { ui.status.dataset.level = level; ui.statusText.textContent = text; }
  const added = () => marks.filter((m) => m.src === 'added').length;
  const removed = () => (auto ? auto.count - marks.filter((m) => m.src === 'auto').length : 0);
  const f2 = (v) => (v == null || Number.isNaN(v) ? '--' : v.toFixed(2));
  const pctTxt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + ' %';
  const scaleOd = () => (photo && photo.sample && !scale ? SAMPLE.odMm : scale ? scale.odMm : null);

  // Number tubes row by row from the top.
  function numberMarks() {
    if (!marks.length) return;
    const rTyp = auto && auto.boreDiameterPx ? auto.boreDiameterPx / 2 : 10;
    const rowH = Math.max(4, rTyp * 1.2);
    const sorted = marks.slice().sort((a, b) => a.y - b.y);
    let row = 0, y0 = sorted[0].y;
    for (const m of sorted) { if (m.y - y0 > rowH) { row++; y0 = m.y; } m.row = row; }
    sorted.sort((a, b) => a.row - b.row || a.x - b.x);
    sorted.forEach((m, i) => { m.no = i + 1; });
  }

  // ------------------------------------------------------------ display
  function draw() {
    if (!photo) return;
    const k = Math.min(1, 2400 / photo.w);
    const W = Math.round(photo.w * k), H = Math.round(photo.h * k);
    if (view.width !== W || view.height !== H) { view.width = W; view.height = H; }
    ctx.drawImage(photo.img, 0, 0, W, H);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#E8631C';
    const lw = Math.max(1.5, W / 700);
    for (const m of marks) {
      const x = m.x * k, y = m.y * k, r = Math.max(3, m.r * k);
      const off = m.size && m.size.ok && m.size.flag;
      ctx.lineWidth = off ? lw * 1.8 : lw;
      ctx.strokeStyle = off ? '#FF4D4D' : m.src === 'added' ? '#4FC3F7' : accent;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
      if (m === selected) {
        ctx.lineWidth = lw * 2; ctx.strokeStyle = '#FFD54F';
        ctx.beginPath(); ctx.arc(x, y, r * 1.35, 0, 2 * Math.PI); ctx.stroke();
      }
      // tube number, readable when zoomed in
      if (m.no && r > 7) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = `600 ${Math.round(Math.min(r * 0.55, 28))}px "IBM Plex Mono", ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(m.no), x, y);
      }
    }
  }

  function renderSizes() {
    const sizes = marks.map((m) => m.size).filter((s) => s && s.ok);
    const odMm = scaleOd();
    const flagged = marks.filter((m) => m.size && m.size.ok && m.size.flag);
    ui.flag.textContent = meas && meas.stats ? String(flagged.length) : '--';
    ui.rflag.textContent = meas && meas.stats ? `${sizes.length} of ${marks.length} sized` : ' ';
    if (!sizes.length) {
      [ui.id, ui.od, ui.wall].forEach((e) => { e.textContent = '--'; });
      [ui.rid, ui.rod, ui.rwall].forEach((e) => { e.innerHTML = '&nbsp;'; });
      return;
    }
    const good = sizes.filter((s) => !s.flag);
    const st = (a) => { const mean = a.reduce((x, y) => x + y, 0) / a.length; return { mean, min: Math.min(...a), max: Math.max(...a) }; };
    if (odMm) {
      const id = st(good.map((s) => s.idMm)), od = st(good.map((s) => s.odMm)), wall = st(good.map((s) => s.wallMm));
      ui.id.textContent = f2(id.mean) + ' mm'; ui.rid.textContent = `${f2(id.min)} to ${f2(id.max)}`;
      ui.od.textContent = f2(od.mean) + ' mm'; ui.rod.textContent = `${f2(od.min)} to ${f2(od.max)}`;
      ui.wall.textContent = f2(wall.mean) + ' mm'; ui.rwall.textContent = `${f2(wall.min)} to ${f2(wall.max)}`;
    } else {
      const idr = st(good.map((s) => s.idRel - 1)), odr = st(good.map((s) => s.rel - 1));
      ui.id.textContent = 'relative'; ui.rid.textContent = `${pctTxt(idr.min)} to ${pctTxt(idr.max)}`;
      ui.od.textContent = 'relative'; ui.rod.textContent = `${pctTxt(odr.min)} to ${pctTxt(odr.max)}`;
      ui.wall.textContent = `ID/OD ${meas.stats.ratio.toFixed(3)}`; ui.rwall.textContent = 'ratio, no scale';
    }
  }

  function renderScale() {
    const odMm = scaleOd();
    if (scale && scale.source === 'ar') ui.scaleState.innerHTML = `Sizes in mm: OD <b>${scale.odMm.toFixed(2)} mm</b> from AR`;
    else if (scale && scale.source === 'nominal') ui.scaleState.innerHTML = `Sizes in mm: nominal OD <b>${scale.odMm.toFixed(2)} mm</b>`;
    else if (odMm) ui.scaleState.innerHTML = `Sample photo: OD <b>${odMm.toFixed(2)} mm</b> (known for the sample)`;
    else ui.scaleState.textContent = 'Sizes: relative to the bundle (no mm scale yet)';
  }

  function renderTubeList() {
    const tb = $('#tubes-body'); tb.textContent = '';
    const odMm = scaleOd();
    const rows = marks.slice().sort((a, b) => ((b.size && b.size.flag) ? 1 : 0) - ((a.size && a.size.flag) ? 1 : 0) || a.no - b.no);
    for (const m of rows) {
      const s = m.size;
      const tr = document.createElement('tr');
      if (s && s.flag) tr.className = 'off';
      const cells = !s || !s.ok
        ? [m.no, '--', '--', '--', '--', 'not sized']
        : [m.no, odMm ? f2(s.idMm) : '--', odMm ? f2(s.odMm) : '--', odMm ? f2(s.wallMm) : '--', pctTxt(s.idRel - 1), s.flag ? 'off-size' : 'ok'];
      cells.forEach((v, i) => { const td = document.createElement('td'); td.textContent = String(v); if (i < 5) td.className = 'num'; tr.appendChild(td); });
      tb.appendChild(tr);
    }
    $('#tubes-note').textContent = marks.length
      ? `${marks.length} tubes, numbered row by row from the top. Off-size tubes are listed first.${odMm ? '' : ' No mm scale yet: sizes are relative to the bundle.'}`
      : 'Count a bundle to see every tube here.';
  }

  function renderInfo() {
    if (!selected) { ui.info.hidden = true; return; }
    const s = selected.size, odMm = scaleOd();
    ui.info.hidden = false;
    ui.info.classList.toggle('off', !!(s && s.flag));
    if (!s || !s.ok) { ui.info.innerHTML = `<b>Tube ${selected.no}</b><br>Edges not clear enough to size this tube.`; return; }
    const mm = odMm ? `ID ${f2(s.idMm)} mm · OD ${f2(s.odMm)} mm · wall ${f2(s.wallMm)} mm<br>` : '<i>For mm, type the tube OD at the top and press Show mm.</i><br>';
    ui.info.innerHTML = `<b>Tube ${selected.no}${s.flag ? ' · off-size' : ''}</b><br>${mm}ID ${pctTxt(s.idRel - 1)}, OD ${pctTxt(s.rel - 1)} vs the bundle · ID/OD ${s.ratio.toFixed(3)}`;
  }

  function render() {
    ui.count.textContent = photo ? String(marks.length) : '---';
    const a = added(), rm = removed();
    if (auto) {
      const parts = [`auto ${auto.count}`];
      if (a) parts.push(`+${a} added`);
      if (rm) parts.push(`−${rm} removed`);
      if (meas && meas.stats && meas.stats.lowRes) parts.push('sizes approximate: move closer');
      ui.detail.textContent = parts.join(' · ');
    } else ui.detail.innerHTML = '&nbsp;';
    ui.save.disabled = !photo;
    ui.undo.disabled = history.length === 0;
    ui.recount.disabled = !photo || (a === 0 && rm === 0);
    renderScale(); renderSizes(); renderTubeList(); renderInfo();
    draw();
  }

  // ------------------------------------------------------------ counting and sizing
  async function loadImage(src) {
    if (window.createImageBitmap && src instanceof Blob) {
      try { return await createImageBitmap(src, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    return await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not read this image.'));
      im.src = src instanceof Blob ? URL.createObjectURL(src) : src;
    });
  }
  function grayOf(img, w, h) {
    work.width = w; work.height = h;
    wctx.drawImage(img, 0, 0, w, h);
    return core.rgbaToGray(wctx.getImageData(0, 0, w, h).data, w, h);
  }
  const paint = () => new Promise((r) => setTimeout(r, 30));

  async function usePhoto(src, label, sample) {
    setStatus('busy', 'Counting');
    ui.count.textContent = '...';
    try {
      const img = await loadImage(src);
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const k = Math.min(1, 4200 / Math.max(iw, ih));
      const w = Math.round(iw * k), h = Math.round(ih * k);
      photo = { img, w, h, gray: grayOf(img, w, h), sample: !!sample, name: label };
      ui.sub.textContent = sample ? 'sample photo' : `photo ${w}×${h}`;
      await paint();
      await runCount();
    } catch (e) {
      setStatus('bad', e.message || 'Could not read this image.');
    }
  }

  async function runCount() {
    auto = core.countTubes(photo.gray, photo.w, photo.h);
    marks = auto.tubes.map((t) => ({ x: t.x, y: t.y, r: t.r, src: 'auto' }));
    history = []; selected = null; meas = null;
    numberMarks();
    render();
    if (!auto.count) {
      setStatus('bad', 'No tube ends found. Take the photo square to the bundle end, closer and sharper, with even light.');
      return;
    }
    setStatus('busy', `Counted ${auto.count}. Measuring each tube`);
    await paint();
    meas = M.measureTubes(photo.gray, photo.w, photo.h, marks);
    marks.forEach((m, i) => { m.size = meas.tubes[i]; });
    applyScaleToAll();
    const flagged = marks.filter((m) => m.size && m.size.flag).length;
    if (auto.boreDiameterPx < 10) setStatus('warn', `Bores are only about ${Math.round(auto.boreDiameterPx)} px across. Move closer or count the bundle in two halves.`);
    else if (meas.stats && meas.stats.lowRes) setStatus('warn', `Counted ${marks.length}. The tube walls are small in this photo, so sizes are approximate: move closer for sizes.`);
    else setStatus('good', `Counted ${marks.length} and sized them in ${((auto.ms + meas.ms) / 1000).toFixed(1)} s.${flagged ? ` ${flagged} off-size (red).` : ''} Zoom in to check the marks.`);
    render();
  }

  function applyScaleToAll() {
    if (!meas) return;
    const odMm = scaleOd();
    if (odMm) M.applyScale(meas, odMm);
    else { meas.odMm = null; for (const o of meas.tubes) { delete o.idMm; delete o.odMm; delete o.wallMm; } }
    for (const m of marks) {
      if (m.size && m.size.ok && odMm) { m.size.odMm = odMm * m.size.rel; m.size.idMm = m.size.odMm * m.size.ratio; m.size.wallMm = (m.size.odMm - m.size.idMm) / 2; }
    }
  }

  ['#photo-input', '#upload-input'].forEach((sel) => $(sel).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) usePhoto(f, f.name || 'photo', false);
    e.target.value = '';
  }));
  // On a computer: drop an image anywhere on the page, or paste one (Ctrl/Cmd+V).
  const imageOf = (items) => Array.from(items || []).find((f) => f && f.type && f.type.startsWith('image/'));
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    const f = imageOf(e.dataTransfer && e.dataTransfer.files);
    if (f) usePhoto(f, f.name || 'photo', false);
  });
  document.addEventListener('paste', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const it = Array.from((e.clipboardData && e.clipboardData.items) || []).find((i) => i.type.startsWith('image/'));
    const f = it && it.getAsFile();
    if (f) { e.preventDefault(); usePhoto(f, 'pasted image', false); }
  });

  // ------------------------------------------------------------ taps
  view.addEventListener('click', (e) => {
    if (!photo || !auto) return;
    const rect = view.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * photo.w;
    const y = ((e.clientY - rect.top) / rect.height) * photo.h;
    let bi = -1, bd = Infinity;
    marks.forEach((m, i) => { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; bi = i; } });
    const hit = bi >= 0 && bd <= Math.max(marks[bi].r * 1.25, (8 * photo.w) / rect.width);
    if (tapMode === 'info') {
      selected = hit ? marks[bi] : null;
      render();
      return;
    }
    const rTyp = auto.boreDiameterPx > 0 ? auto.boreDiameterPx / 2 : 12;
    if (hit) {
      history.push({ type: 'remove', mark: marks[bi], index: bi });
      if (selected === marks[bi]) selected = null;
      marks.splice(bi, 1);
    } else {
      const m = { x, y, r: rTyp, src: 'added' };
      if (meas) m.size = M.measureOne(meas, m);
      if (m.size && m.size.ok) { m.x = m.size.x; m.y = m.size.y; m.r = m.size.idPx / 2; }
      history.push({ type: 'add', mark: m });
      marks.push(m);
    }
    numberMarks();
    setStatus('good', hit ? 'Mark removed.' : 'Tube added.');
    render();
  });
  ui.undo.addEventListener('click', () => {
    const h = history.pop();
    if (!h) return;
    if (h.type === 'add') marks.splice(marks.indexOf(h.mark), 1);
    else marks.splice(h.index, 0, h.mark);
    numberMarks(); render();
  });
  ui.recount.addEventListener('click', () => { if (photo) runCount(); });
  document.querySelectorAll('[data-tap]').forEach((b) => b.addEventListener('click', () => {
    tapMode = b.dataset.tap;
    document.querySelectorAll('[data-tap]').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
    $('#tap-tip').textContent = tapMode === 'info'
      ? 'Tap a tube to see its size. Red marks are off-size tubes.'
      : 'Tap a mark to remove it. Tap a tube without a mark to add it. Zoom in to check dense bundles. Red marks are off-size tubes.';
    if (tapMode === 'fix') selected = null;
    render();
  }));

  // ------------------------------------------------------------ zoom
  document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const z = +b.dataset.zoom, f = ui.finder;
    const cx = (f.scrollLeft + f.clientWidth / 2) / (f.scrollWidth || 1);
    const cy = (f.scrollTop + f.clientHeight / 2) / (f.scrollHeight || 1);
    view.style.width = z * 100 + '%';
    document.querySelectorAll('[data-zoom]').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
    requestAnimationFrame(() => { f.scrollLeft = cx * f.scrollWidth - f.clientWidth / 2; f.scrollTop = cy * f.scrollHeight - f.clientHeight / 2; });
  }));

  // ------------------------------------------------------------ scale: nominal OD
  function parseOd(str) {
    let s = String(str || '').trim().replace(',', '.').toLowerCase();
    let inch = false;
    if (/("|in|inch)$/.test(s)) { inch = true; s = s.replace(/("|inch|in)$/, '').trim(); }
    let v;
    const m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/), fr = s.match(/^(\d+)\/(\d+)$/);
    if (m) v = +m[1] + m[2] / m[3]; else if (fr) v = fr[1] / fr[2]; else v = parseFloat(s);
    return v > 0 ? (inch ? v * 25.4 : v) : NaN;
  }
  $('#btn-od-apply').addEventListener('click', () => {
    const v = parseOd($('#od-input').value);
    if (!(v > 0 && v < 500)) { setStatus('warn', 'Enter the OD in mm, or in inches with " (for example 1/2").'); return; }
    scale = { odMm: v, source: 'nominal' };
    store.set('nominalOd', v);
    applyScaleToAll(); render();
    setStatus('good', `Sizes now in mm, from a nominal OD of ${v.toFixed(2)} mm.`);
  });
  $('#od-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-od-apply').click(); });
  $('#btn-scale-clear').addEventListener('click', () => { scale = null; store.set('nominalOd', null); $('#od-input').value = ''; applyScaleToAll(); render(); setStatus('idle', 'Scale cleared. Sizes are relative to the bundle.'); });

  // ------------------------------------------------------------ scale: AR (no input)
  const xui = { overlay: $('#xr-overlay'), canvas: $('#xr-canvas'), status: $('#xr-status'), bar: $('#xr-progress'), od: $('#xr-od'), sub: $('#xr-sub'), use: $('#xr-use') };
  const xctx = xui.canvas.getContext('2d');
  let xr = null, arLast = null;
  function drawXr(data, frame) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(xui.canvas.clientWidth * dpr), H = Math.round(xui.canvas.clientHeight * dpr);
    if (xui.canvas.width !== W || xui.canvas.height !== H) { xui.canvas.width = W; xui.canvas.height = H; }
    xctx.clearRect(0, 0, W, H);
    if (!data.found || !frame.w) return;
    const sx = W / frame.w, sy = H / frame.h;
    const line = (pts, color, dash) => {
      if (!pts || pts.length < 3) return;
      xctx.beginPath();
      pts.forEach((p, i) => (i ? xctx.lineTo(p[0] * sx, p[1] * sy) : xctx.moveTo(p[0] * sx, p[1] * sy)));
      xctx.closePath(); xctx.setLineDash(dash ? [6 * dpr, 5 * dpr] : []);
      xctx.strokeStyle = color; xctx.lineWidth = 2.5 * dpr; xctx.stroke();
    };
    line(data.odPts, 'rgba(255,255,255,0.9)', true);
    line(data.idPts, '#F07A36', false);
  }
  function onXr(data, frame) {
    drawXr(data, frame);
    const e = data.estimate;
    let pct = e ? Math.round((e.progress || 0) * 100) : 0;
    if (e && e.reason === 'restart') xui.status.textContent = 'Lost track of the tube. Hold on one tube near the middle and move slowly.';
    else if (!data.found && !(e && e.ready)) { xui.status.textContent = 'Point at a tube near the middle of the bundle, 15 to 30 cm away.'; pct = 0; }
    else if (!e || !e.ready) xui.status.textContent = e && e.reason === 'move' ? `Now move the phone slowly sideways. ${Math.round(e.baselineMm)} of ${Math.round(e.needMm)} mm.` : 'Tube found. Hold on it.';
    else { xui.status.textContent = e.od ? 'Size found. Use it, or keep moving slightly to refine.' : 'Keep moving: the outer edge is not clear yet.'; pct = 100; }
    xui.bar.style.width = pct + '%';
    if (e && e.ready && e.od) {
      arLast = e;
      xui.od.textContent = e.od.toFixed(2);
      xui.sub.textContent = `ID ${e.id.toFixed(2)} mm · ${e.distanceMm.toFixed(0)} mm away · ${e.n} views`;
      xui.use.disabled = false;
    }
  }
  ui.btnAr.addEventListener('click', async () => {
    if (xr) return;
    xui.overlay.hidden = false; xui.status.textContent = 'Starting camera'; xui.bar.style.width = '0%';
    xui.od.textContent = '--.--'; xui.use.disabled = true; arLast = null;
    try {
      xr = await window.TubeXR.start({
        overlay: xui.overlay, workerUrl: window.TC_WORKER_URL || 'src/worker.js', onResult: onXr,
        onStatus: (st) => {
          if (st === 'tracking') xui.status.textContent = 'Finding its bearings. Move the phone gently.';
          if (st === 'no-camera') xui.status.textContent = 'Camera access was not granted to the AR session.';
        },
        onEnd: () => { xr = null; xui.overlay.hidden = true; },
        onError: (msg) => { xr = null; xui.overlay.hidden = true; setStatus('bad', 'Could not start the AR camera: ' + msg); },
      });
    } catch (err) {
      xr = null; xui.overlay.hidden = true;
      setStatus('bad', 'Could not start the AR camera: ' + (err && err.message ? err.message : 'unknown error') + '. Check that Google Play Services for AR is installed.');
    }
  });
  $('#xr-exit').addEventListener('click', () => { if (xr) xr.stop(); });
  $('#xr-reset').addEventListener('click', () => { if (xr) xr.reset(); arLast = null; xui.od.textContent = '--.--'; xui.use.disabled = true; xui.bar.style.width = '0%'; });
  xui.use.addEventListener('click', () => {
    if (!arLast || !arLast.od) return;
    scale = { odMm: arLast.od, source: 'ar', idMm: arLast.id };
    if (xr) xr.stop();
    applyScaleToAll(); render();
    setStatus('good', `Size learned: OD ${arLast.od.toFixed(2)} mm. Now photograph the bundle${photo && !photo.sample ? ', or keep the current photo' : ''}.`);
  });

  // ------------------------------------------------------------ saved counts and exports
  function renderLog() {
    const tb = $('#log-body'); tb.textContent = '';
    for (const row of log.slice().reverse()) {
      const tr = document.createElement('tr');
      const t = new Date(row.t);
      const edits = (row.added ? '+' + row.added : '') + (row.added && row.removed ? ' ' : '') + (row.removed ? '−' + row.removed : '');
      const cells = [
        [row.label || '-', ''], [String(row.count), 'num'], [edits || '0', 'num'],
        [row.idMm != null ? f2(row.idMm) : '--', 'num'], [row.odMm != null ? f2(row.odMm) : '--', 'num'], [row.offSize != null ? String(row.offSize) : '--', 'num'],
        [t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + t.toLocaleDateString([], { day: '2-digit', month: 'short' }), 'time'],
      ];
      for (const [v, cls] of cells) { const td = document.createElement('td'); td.textContent = v; if (cls) td.className = cls; tr.appendChild(td); }
      tb.appendChild(tr);
    }
    $('#log-empty').hidden = log.length > 0;
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.textContent = ''; }, 2500);
    if ($('#panel-log').hidden) setStatus(ui.status.dataset.level, msg);
  }
  ui.save.addEventListener('click', () => {
    if (!photo || !auto) return;
    const sizes = marks.map((m) => m.size).filter((s) => s && s.ok && !s.flag);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const odMm = scaleOd();
    log.push({
      t: Date.now(), label: $('#label-input').value.trim(), count: marks.length, auto: auto.count, added: added(), removed: removed(),
      idMm: odMm ? mean(sizes.map((s) => s.idMm)) : null, odMm: odMm ? mean(sizes.map((s) => s.odMm)) : null,
      offSize: meas && meas.stats ? marks.filter((m) => m.size && m.size.flag).length : null,
      scale: scale ? scale.source : photo.sample ? 'sample' : 'none', photo: photo.sample ? 'sample' : photo.name,
    });
    store.set('log2', log); renderLog();
    toast('Count saved');
  });
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const num = (v, d) => (v == null || Number.isNaN(v) ? '' : v.toFixed(d));
  function csvCounts() {
    const head = 'time,label,tubes,auto_count,added,removed,mean_id_mm,mean_od_mm,off_size,scale,photo';
    return [head].concat(log.map((r) => [new Date(r.t).toISOString(), q(r.label), r.count, r.auto, r.added, r.removed, num(r.idMm, 3), num(r.odMm, 3), r.offSize == null ? '' : r.offSize, r.scale, q(r.photo)].join(','))).join('\n');
  }
  function csvTubes() {
    const odMm = scaleOd();
    const head = 'tube_no,x_px,y_px,id_mm,od_mm,wall_mm,id_vs_bundle_pct,od_vs_bundle_pct,id_od_ratio,off_size,source';
    return [head].concat(marks.slice().sort((a, b) => a.no - b.no).map((m) => {
      const s = m.size && m.size.ok ? m.size : null;
      return [m.no, m.x.toFixed(1), m.y.toFixed(1), s && odMm ? num(s.idMm, 3) : '', s && odMm ? num(s.odMm, 3) : '', s && odMm ? num(s.wallMm, 3) : '',
        s ? num((s.idRel - 1) * 100, 2) : '', s ? num((s.rel - 1) * 100, 2) : '', s ? num(s.ratio, 4) : '', s ? (s.flag ? 'yes' : 'no') : 'not sized', m.src].join(',');
    })).join('\n');
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Select and copy the text manually'); }
    ta.remove();
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => fallbackCopy(text));
    else fallbackCopy(text);
  }
  function download(text, name) {
    if (window.TubeNativeShare) { window.TubeNativeShare(text, name); return; } // iPhone app: share sheet
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  $('#btn-copy').addEventListener('click', () => copy(csvCounts()));
  $('#btn-download').addEventListener('click', () => download(csvCounts(), 'tube-counts.csv'));
  $('#btn-copy-tubes').addEventListener('click', () => copy(csvTubes()));
  $('#btn-download-tubes').addEventListener('click', () => download(csvTubes(), 'tube-sizes.csv'));
  $('#btn-clear').addEventListener('click', () => { $('#clear-confirm').hidden = false; });
  $('#btn-clear-no').addEventListener('click', () => { $('#clear-confirm').hidden = true; });
  $('#btn-clear-yes').addEventListener('click', () => { log = []; store.set('log2', log); renderLog(); $('#clear-confirm').hidden = true; toast('Counts cleared'); });

  // ------------------------------------------------------------ tabs
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((o) => { o.setAttribute('aria-selected', String(o === b)); $('#' + o.dataset.panel).hidden = o !== b; });
  }));

  // ------------------------------------------------------------ start
  renderLog();
  if (window.TC_DEMO) { $('#btn-download').hidden = true; $('#btn-download-tubes').hidden = true; }
  (window.TubeXR ? window.TubeXR.supported() : Promise.resolve(false)).then((ok) => {
    if (!ok) {
      ui.btnAr.disabled = true;
      $('#scale-note').textContent = 'For sizes in mm, type the tube OD below (the no-input AR step needs Chrome on an ARCore Android phone). Without it, sizes are relative to the bundle.';
    }
  });
  // A typed OD is remembered on this device and used for the next photos.
  const savedOd = store.get('nominalOd', null);
  if (savedOd > 0) { $('#od-input').value = savedOd.toFixed(2); scale = { odMm: savedOd, source: 'nominal' }; }
  usePhoto(SAMPLE.url, 'sample', true);
})();
