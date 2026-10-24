// Texture labs: a paint-program editor for GTA texture dictionaries, used twice:
//   Graphics → Clouds   (cloudhat_*.ytd, found automatically)
//   Graphics → Blood FX (the blood FX .rpf the player chooses)
// Brush, eraser, colour picker, paint bucket, colour adjustments, picture swap, undo
// history. Install writes the textures back in their original format and size.

import { notify } from './notify.js';
import { icon } from './icons.js';
import { busy, fillRange } from './fx.js';
import { decode, encode, levelSize } from './dxt.js';
import { hydrateIcons } from './icons.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HISTORY = 30;
const SWATCHES = ['#ffffff', '#000000', '#b050ff', '#ff4fa8', '#3da5ff', '#22e3b2', '#ffd24d', '#ff6a3d'];

/** The lab's markup, with every id prefixed so several labs can live on the page. */
function labHtml(P, cfg) {
  return `<div class="card cl-top">
${cfg.mode === 'files'
  ? `<div class="ted-field grow"><span>${esc(cfg.texts.from)}</span><div class="cl-opened" id="${P}-opened">Nothing open yet</div></div>
            <button class="btn primary sm" id="${P}-openfiles">${icon('folder')}${esc(cfg.texts.open)}</button>`
  : `<label class="ted-field grow"><span>${esc(cfg.texts.from)}</span><select id="${P}-source" class="tc-select"></select></label>
            <button class="btn ghost sm" id="${P}-rescan">${icon('search')}Look again</button>`}
            <span class="cl-sep"></span>
            <button class="icon-btn" id="${P}-undo" title="Undo (Ctrl+Z)"><i data-icon="undo"></i></button>
            <button class="icon-btn" id="${P}-redo" title="Redo (Ctrl+Y)"><i data-icon="redo"></i></button>
            <button class="btn ghost sm" id="${P}-compare" title="Hold to see the original"><i data-icon="eye"></i>Hold to compare</button>
            <span class="tag" id="${P}-dirty">No changes</span>
            <button class="btn ghost sm hidden" id="${P}-uninstall"><i data-icon="undo"></i>Undo install</button>
            ${cfg.mode === 'files' ? `<button class="btn ghost sm" id="${P}-savefolder" disabled>${icon('download')}Save to folder</button>` : ''}
            <button class="btn primary sm" id="${P}-install" disabled><i data-icon="zap"></i>Install</button>
          </div>

          <div class="cl-work">
            <div class="card cl-tools" id="${P}-tools">
              <button data-tool="hand" title="Move around (H, or hold Space)"><i data-icon="hand"></i></button>
              <button data-tool="brush" class="on" title="Brush (B)"><i data-icon="brush"></i></button>
              <button data-tool="eraser" title="Eraser (E)"><i data-icon="eraser"></i></button>
              <button data-tool="picker" title="Pick a colour (I)"><i data-icon="pipette"></i></button>
              <button data-tool="fill" title="Paint bucket (G)"><i data-icon="bucket"></i></button>
              <span class="cl-tsep"></span>
              <button data-act="fit" title="Fit to screen (0)"><i data-icon="maximize"></i></button>
              <button data-act="100" title="Actual size (1)"><span class="mono">1:1</span></button>
            </div>

            <div class="card cl-stage" id="${P}-stage">
              <canvas id="${P}-view"></canvas>
              <div class="tce-empty" id="${P}-empty"><i data-icon="${cfg.icon}"></i><b id="${P}-empty-title">${esc(cfg.texts.emptyTitle)}</b><small id="${P}-empty-text">${esc(cfg.texts.emptyText)}</small></div>
              <div class="cl-status" id="${P}-status"></div>
            </div>

            <div class="cl-side">
              <div class="card cl-panel"><h4>${esc(cfg.texts.list)}</h4><ul class="cl-list" id="${P}-list"></ul></div>
              <div class="card cl-panel">
                <h4>Brush</h4>
                <div class="cl-colour"><input type="color" id="${P}-color" value="#ffffff" /><div class="cl-swatches" id="${P}-swatches"></div></div>
                <div class="slider-field"><span>Size <b id="${P}-size-val">40px</b></span><input type="range" id="${P}-size" min="1" max="400" value="40" /></div>
                <div class="slider-field"><span>Softness <b id="${P}-soft-val">50%</b></span><input type="range" id="${P}-soft" min="0" max="100" value="50" /></div>
                <div class="slider-field"><span>Strength <b id="${P}-opacity-val">60%</b></span><input type="range" id="${P}-opacity" min="1" max="100" value="60" /></div>
              </div>
              <div class="card cl-panel">
                <h4>Adjust colours</h4>
                <div class="slider-field"><span>Hue <b id="${P}-hue-val">0°</b></span><input type="range" id="${P}-hue" min="-180" max="180" value="0" /></div>
                <div class="slider-field"><span>Saturation <b id="${P}-sat-val">100%</b></span><input type="range" id="${P}-sat" min="0" max="300" value="100" /></div>
                <div class="slider-field"><span>Brightness <b id="${P}-bright-val">0</b></span><input type="range" id="${P}-bright" min="-100" max="100" value="0" /></div>
                <div class="slider-field"><span>Contrast <b id="${P}-contrast-val">100%</b></span><input type="range" id="${P}-contrast" min="0" max="250" value="100" /></div>
                <div class="ctrl-row tight"><label class="field colour-field"><span>Tint</span><input type="color" id="${P}-tint" value="#b050ff" /></label><div class="slider-field"><span>Amount <b id="${P}-tint-val">0%</b></span><input type="range" id="${P}-tint-amt" min="0" max="100" value="0" /></div></div>
                <div class="cl-btns"><button class="btn primary sm" id="${P}-adj-apply"><i data-icon="check"></i>Apply</button><button class="btn ghost sm" id="${P}-adj-all"><i data-icon="layers"></i>Apply to all clouds</button><button class="btn ghost sm" id="${P}-adj-reset">Reset</button></div>
              </div>
              <div class="card cl-panel">
                <h4>Picture &amp; edits</h4>
                <label class="cl-check"><input type="checkbox" id="${P}-keep" checked /> Keep the shape (transparency)</label>
                <div class="cl-btns">
                  <button class="btn ghost sm" id="${P}-picture"><i data-icon="image"></i>Use a picture</button>
                  <button class="btn ghost sm" id="${P}-flip-h">Flip ↔</button>
                  <button class="btn ghost sm" id="${P}-flip-v">Flip ↕</button>
                  <button class="btn ghost sm" id="${P}-invert">Invert</button>
                  <button class="btn ghost sm" id="${P}-mono">Black &amp; white</button>
                  <button class="btn ghost sm" id="${P}-reset-tex"><i data-icon="undo"></i>Back to original</button>
                </div>
              </div>
              <div class="card cl-panel"><h4>History</h4><ul class="cl-history" id="${P}-history"></ul></div>
            </div>
          </div>`;
}

/** One texture lab. cfg: { P: id prefix, kind: 'clouds'|'blood', mode: 'sources'|'files',
 *  active(): is its page showing, texts: { what, none } } */
export function createLab(cfg) {
  const P = cfg.P;
  const st = {
    sources: [], sourceId: null, label: '', items: [], docs: new Map(), cur: null,
    tool: 'brush', zoom: 1, panX: 0, panY: 0, compare: false, preview: null, installed: null, opened: false, busy: false,
  };
  let ctx = { modal: null };

  // ---------- documents (one per texture) ----------

  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function docFor(itemKey, texIndex) {
    const id = itemKey + ':' + texIndex;
    if (st.docs.has(id)) return st.docs.get(id);
    const item = st.items.find((x) => x.key === itemKey);
    const t = item.textures[texIndex];
    const w = t.width; const h = t.height;
    const c = canvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    const px = decode(t.format, t.data.subarray(0, levelSize(t.format, w, h)), w, h);
    const img = new ImageData(new Uint8ClampedArray(px), w, h);
    g.putImageData(img, 0, 0);
    const doc = { id, item, t, w, h, c, g, orig: img, hist: [], fut: [], changed: false, dirty: false };
    st.docs.set(id, doc);
    return doc;
  }

  function snap(doc, label) {
    doc.hist.push({ label, data: doc.g.getImageData(0, 0, doc.w, doc.h) });
    if (doc.hist.length > HISTORY) doc.hist.shift();
    doc.fut = [];
    doc.changed = true; doc.dirty = true;
  }

  function undo() {
    const d = st.cur; if (!d || !d.hist.length) return;
    const h = d.hist.pop();
    d.fut.push({ label: h.label, data: d.g.getImageData(0, 0, d.w, d.h) });
    d.g.putImageData(h.data, 0, 0);
    d.dirty = true; changed();
  }

  function redo() {
    const d = st.cur; if (!d || !d.fut.length) return;
    const f = d.fut.pop();
    d.hist.push({ label: f.label, data: d.g.getImageData(0, 0, d.w, d.h) });
    d.g.putImageData(f.data, 0, 0);
    d.dirty = true; changed();
  }

  function changed() {
    st.preview = null;
    draw(); renderHistory(); renderDirty(); thumb(st.cur);
  }

  // ---------- colour maths ----------

  function adjustValues() {
    return {
      hue: +$('#' + P + '-hue').value, sat: $('#' + P + '-sat').value / 100, bright: $('#' + P + '-bright').value / 100,
      contrast: $('#' + P + '-contrast').value / 100, tint: $('#' + P + '-tint').value, tintAmt: $('#' + P + '-tint-amt').value / 100,
    };
  }
  const neutral = (a) => !a.hue && a.sat === 1 && !a.bright && a.contrast === 1 && !a.tintAmt;

  /** Hue rotation, saturation, brightness, contrast and a colour tint. Alpha (the cloud's shape) is kept. */
  function adjustPixels(src, a) {
    const out = new Uint8ClampedArray(src);
    const r = (a.hue * Math.PI) / 180; const cos = Math.cos(r); const sin = Math.sin(r);
    const m = [
      0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
      0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
      0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
    ];
    const tr = parseInt(a.tint.slice(1, 3), 16); const tg = parseInt(a.tint.slice(3, 5), 16); const tb = parseInt(a.tint.slice(5, 7), 16);
    for (let i = 0; i < out.length; i += 4) {
      let R = out[i]; let G = out[i + 1]; let B = out[i + 2];
      if (a.hue) { const r0 = R, g0 = G, b0 = B; R = m[0] * r0 + m[1] * g0 + m[2] * b0; G = m[3] * r0 + m[4] * g0 + m[5] * b0; B = m[6] * r0 + m[7] * g0 + m[8] * b0; }
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      if (a.sat !== 1) { R = L + (R - L) * a.sat; G = L + (G - L) * a.sat; B = L + (B - L) * a.sat; }
      if (a.tintAmt) { const k = L / 255; R += (tr * k - R) * a.tintAmt; G += (tg * k - G) * a.tintAmt; B += (tb * k - B) * a.tintAmt; }
      if (a.contrast !== 1) { R = (R - 128) * a.contrast + 128; G = (G - 128) * a.contrast + 128; B = (B - 128) * a.contrast + 128; }
      if (a.bright) { const d = a.bright * 255; R += d; G += d; B += d; }
      out[i] = R; out[i + 1] = G; out[i + 2] = B;
    }
    return out;
  }

  function applyAdjust(doc, a, label) {
    const img = doc.g.getImageData(0, 0, doc.w, doc.h);
    snap(doc, label);
    doc.g.putImageData(new ImageData(adjustPixels(img.data, a), doc.w, doc.h), 0, 0);
  }

  // ---------- view ----------

  function stageSize() {
    const cv = $('#' + P + '-view');
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(2, Math.round(r.width * dpr)); const H = Math.max(2, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    return { cv, W, H, dpr };
  }

  function fit() {
    const d = st.cur; if (!d) return;
    const { W, H } = stageSize();
    st.zoom = Math.min((W - 40) / d.w, (H - 40) / d.h);
    st.panX = (W - d.w * st.zoom) / 2; st.panY = (H - d.h * st.zoom) / 2;
    draw();
  }

  function actual() {
    const d = st.cur; if (!d) return;
    const { W, H } = stageSize();
    st.zoom = 1; st.panX = (W - d.w) / 2; st.panY = (H - d.h) / 2;
    draw();
  }

  let checker = null;
  function draw(cursor) {
    const { cv, W, H } = stageSize();
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const d = st.cur;
    if (!d) return;
    const x = st.panX; const y = st.panY; const w = d.w * st.zoom; const h = d.h * st.zoom;
    if (!checker) {
      const c = canvas(16, 16); const cg = c.getContext('2d');
      cg.fillStyle = '#1c1c20'; cg.fillRect(0, 0, 16, 16); cg.fillStyle = '#2a2a30'; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8);
      checker = g.createPattern(c, 'repeat');
    }
    g.fillStyle = checker; g.fillRect(x, y, w, h);
    g.imageSmoothingEnabled = st.zoom < 1;
    let show = d.c;
    if (st.compare) { show = canvas(d.w, d.h); show.getContext('2d').putImageData(d.orig, 0, 0); }
    else if (st.preview) show = st.preview;
    g.drawImage(show, x, y, w, h);
    g.strokeStyle = 'rgba(255,255,255,.15)'; g.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
    if (cursor && (st.tool === 'brush' || st.tool === 'eraser')) {
      g.beginPath(); g.arc(cursor.x, cursor.y, Math.max(1, (+$('#' + P + '-size').value / 2) * st.zoom), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1; g.stroke();
      g.beginPath(); g.arc(cursor.x, cursor.y, Math.max(1, (+$('#' + P + '-size').value / 2) * st.zoom) + 1, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke();
    }
    $('#' + P + '-status').textContent = `${d.t.name} · ${d.w}×${d.h} · ${d.t.format} · ${Math.round(st.zoom * 100)}%`;
  }

  let previewQueued = false;
  function queuePreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      const d = st.cur; if (!d) return;
      const a = adjustValues();
      if (neutral(a)) st.preview = null;
      else {
        const c = canvas(d.w, d.h);
        c.getContext('2d').putImageData(new ImageData(adjustPixels(d.g.getImageData(0, 0, d.w, d.h).data, a), d.w, d.h), 0, 0);
        st.preview = c;
      }
      draw();
    });
  }

  // ---------- painting ----------

  function toTex(e) {
    const { dpr } = stageSize();
    const r = $('#' + P + '-view').getBoundingClientRect();
    const sx = (e.clientX - r.left) * dpr; const sy = (e.clientY - r.top) * dpr;
    return { sx, sy, x: (sx - st.panX) / st.zoom, y: (sy - st.panY) / st.zoom };
  }

  function stamp(d, x, y) {
    const size = +$('#' + P + '-size').value; const soft = $('#' + P + '-soft').value / 100; const op = $('#' + P + '-opacity').value / 100;
    const erase = st.tool === 'eraser';
    const hex = erase && d.t.format === 'DXT1' ? '#000000' : $('#' + P + '-color').value;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const rad = Math.max(0.5, size / 2);
    const grad = d.g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(${r},${g},${b},${op})`);
    grad.addColorStop(Math.min(0.99, 1 - soft), `rgba(${r},${g},${b},${op})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    d.g.save();
    // DXT1 has no transparency: the eraser paints black there instead
    d.g.globalCompositeOperation = erase && d.t.format !== 'DXT1' ? 'destination-out' : 'source-over';
    d.g.fillStyle = grad;
    d.g.beginPath(); d.g.arc(x, y, rad, 0, Math.PI * 2); d.g.fill();
    d.g.restore();
  }

  function floodFill(d, x0, y0) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    if (x0 < 0 || y0 < 0 || x0 >= d.w || y0 >= d.h) return false;
    const img = d.g.getImageData(0, 0, d.w, d.h); const px = img.data;
    const hex = $('#' + P + '-color').value; const op = $('#' + P + '-opacity').value / 100;
    const fill = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const i0 = (y0 * d.w + x0) * 4; const target = [px[i0], px[i0 + 1], px[i0 + 2], px[i0 + 3]];
    const tol = 48;
    const near = (i) => Math.abs(px[i] - target[0]) + Math.abs(px[i + 1] - target[1]) + Math.abs(px[i + 2] - target[2]) + Math.abs(px[i + 3] - target[3]) <= tol;
    const seen = new Uint8Array(d.w * d.h);
    const stack = [x0, y0];
    snap(d, 'Paint bucket');
    while (stack.length) {
      const y = stack.pop(); const x = stack.pop();
      if (x < 0 || y < 0 || x >= d.w || y >= d.h) continue;
      const k = y * d.w + x;
      if (seen[k]) continue;
      seen[k] = 1;
      const i = k * 4;
      if (!near(i)) continue;
      px[i] += (fill[0] - px[i]) * op; px[i + 1] += (fill[1] - px[i + 1]) * op; px[i + 2] += (fill[2] - px[i + 2]) * op;
      if (d.t.format !== 'DXT1') px[i + 3] = Math.max(px[i + 3], 255 * op);
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    d.g.putImageData(img, 0, 0);
    return true;
  }

  function bindStage() {
    const cv = $('#' + P + '-view');
    let drag = null; let space = false;
    addEventListener('keydown', (e) => { if (e.code === 'Space' && paneOn() && !typing(e)) { space = true; $('#' + P + '-stage').classList.add('panning'); e.preventDefault(); } });
    addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; $('#' + P + '-stage').classList.remove('panning'); } });
    cv.addEventListener('pointerdown', (e) => {
      const d = st.cur; if (!d) return;
      cv.setPointerCapture(e.pointerId);
      const p = toTex(e);
      if (st.tool === 'hand' || space || e.button === 1) { drag = { pan: true, sx: p.sx, sy: p.sy, px: st.panX, py: st.panY }; return; }
      if (!d.t.editable) return notify.info('This texture is locked', d.t.format + ' textures cannot be written back yet.');
      if (st.tool === 'picker') {
        const c = d.g.getImageData(Math.max(0, Math.min(d.w - 1, Math.floor(p.x))), Math.max(0, Math.min(d.h - 1, Math.floor(p.y))), 1, 1).data;
        $('#' + P + '-color').value = '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        setTool('brush');
        return;
      }
      if (st.tool === 'fill') { if (floodFill(d, p.x, p.y)) changed(); return; }
      snap(d, st.tool === 'eraser' ? 'Eraser' : 'Brush');
      stamp(d, p.x, p.y);
      drag = { paint: true, x: p.x, y: p.y };
      draw(p);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = toTex(e);
      if (!drag) { draw({ x: p.sx, y: p.sy }); return; }
      if (drag.pan) { st.panX = drag.px + (p.sx - drag.sx); st.panY = drag.py + (p.sy - drag.sy); draw(); return; }
      // fill the gap between mouse events so fast strokes stay smooth
      const d = st.cur;
      const step = Math.max(1, +$('#' + P + '-size').value * 0.2);
      const dist = Math.hypot(p.x - drag.x, p.y - drag.y);
      for (let s = step; s <= dist; s += step) stamp(d, drag.x + ((p.x - drag.x) * s) / dist, drag.y + ((p.y - drag.y) * s) / dist);
      if (dist >= step) { drag.x = p.x; drag.y = p.y; }
      st.preview = null;
      draw({ x: p.sx, y: p.sy });
    });
    const end = () => { if (drag && drag.paint) changed(); drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!drag) draw(); });
    cv.addEventListener('wheel', (e) => {
      if (!st.cur) return;
      e.preventDefault();
      const p = toTex(e);
      const z = Math.max(0.05, Math.min(32, st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      st.panX = p.sx - p.x * z; st.panY = p.sy - p.y * z; st.zoom = z;
      draw({ x: p.sx, y: p.sy });
    }, { passive: false });
    new ResizeObserver(() => { if (paneOn()) draw(); }).observe($('#' + P + '-stage'));
  }

  function setTool(t) {
    st.tool = t;
    $$('#' + P + '-tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    $('#' + P + '-stage').dataset.tool = t;
  }

  // ---------- lists ----------

  function thumb(d) {
    if (!d) return;
    const c = $(`#${P}-list [data-doc="${d.id}"] canvas`);
    if (!c) return;
    c.width = 80; c.height = 80;
    c.getContext('2d').drawImage(d.c, 0, 0, 80, 80);
    $(`#${P}-list [data-doc="${d.id}"]`).classList.toggle('edited', d.changed);
    const dot = $(`#${P}-list [data-doc="${d.id}"] i.ed`);
    if (dot) dot.style.display = d.changed ? '' : 'none';
  }

  function renderList() {
    const list = $('#' + P + '-list');
    list.innerHTML = st.items.map((it) => `<li class="cl-hat">${esc(it.name)}<small>${esc(it.file)}</small></li>` + it.textures.map((t) => {
      const id = it.key + ':' + t.index;
      return `<li class="cl-tex ${t.editable ? '' : 'locked'} ${st.cur && st.cur.id === id ? 'on' : ''}" data-doc="${id}" title="${t.editable ? '' : t.format + ' cannot be edited yet'}">
        <canvas></canvas><div><b>${esc(t.name)}</b><small>${t.width}×${t.height} · ${t.format}</small></div><i class="ed" style="display:none"></i></li>`;
    }).join('')).join('');
    $$('.cl-tex', list).forEach((li) => (li.onclick = () => {
      const [k, i] = li.dataset.doc.split(':').map(Number);
      const it = st.items.find((x) => x.key === k);
      if (!it.textures[i].editable) return notify.info('This texture is locked', it.textures[i].format + ' textures cannot be written back yet.');
      select(k, i);
    }));
    // thumbnails, a few at a time so the page stays responsive
    const todo = st.items.flatMap((it) => it.textures.filter((t) => t.editable).map((t) => [it.key, t.index]));
    const next = () => {
      const batch = todo.splice(0, 3);
      for (const [k, i] of batch) { try { thumb(docFor(k, i)); } catch (e) { /* undecodable */ } }
      if (todo.length) setTimeout(next, 0);
    };
    next();
  }

  function select(k, i) {
    st.cur = docFor(k, i);
    st.preview = null;
    $$('#' + P + '-list .cl-tex').forEach((li) => li.classList.toggle('on', li.dataset.doc === st.cur.id));
    $('#' + P + '-empty').classList.add('hidden');
    fit(); renderHistory(); queuePreview();
  }

  function renderHistory() {
    const d = st.cur;
    const box = $('#' + P + '-history');
    if (!d) { box.innerHTML = ''; return; }
    const rows = ['<li>Opened</li>'].concat(d.hist.map((h) => `<li>${esc(h.label)}</li>`));
    rows[rows.length - 1] = rows[rows.length - 1].replace('<li>', '<li class="now">');
    box.innerHTML = rows.join('') + d.fut.slice().reverse().map((f) => `<li class="future">${esc(f.label)}</li>`).join('');
    box.scrollTop = box.scrollHeight;
    $('#' + P + '-undo').disabled = !d.hist.length;
    $('#' + P + '-redo').disabled = !d.fut.length;
  }

  function renderDirty() {
    const n = [...st.docs.values()].filter((d) => d.dirty).length;
    const tag = $('#' + P + '-dirty');
    tag.textContent = n ? n + ' texture' + (n === 1 ? '' : 's') + ' changed' : st.installed ? 'Installed' : 'No changes';
    tag.classList.toggle('solid', n > 0);
    $('#' + P + '-install').disabled = !n;
    $('#' + P + '-install').innerHTML = icon('zap') + (st.installed && !n ? 'Installed' : st.installed ? 'Install again' : 'Install');
    const sf = $('#' + P + '-savefolder');
    if (sf) sf.disabled = ![...st.docs.values()].some((d) => d.changed);
    $('#' + P + '-uninstall').classList.toggle('hidden', !st.installed);
  }

  // ---------- sources ----------

  async function findSources() {
    $('#' + P + '-empty').classList.remove('hidden');
    $('#' + P + '-empty-title').textContent = 'Looking for your ' + cfg.texts.what + '…';
    $('#' + P + '-empty-text').textContent = 'Checking your pack, your mods folder, citizen and GTA V. RPFs are matched by what is inside, not by their name.';
    try { st.sources = await api.call('tex:list', cfg.kind); } catch (e) { st.sources = []; notify.error('Could not look for ' + cfg.texts.what, e.message); }
    const sel = $('#' + P + '-source');
    sel.innerHTML = st.sources.length ? st.sources.map((x) => `<option value="${esc(x.id)}">${esc(x.label)} · ${x.count} file${x.count === 1 ? '' : 's'}</option>`).join('') : '<option value="">Nothing found</option>';
    if (!st.sources.length) {
      $('#' + P + '-empty-title').textContent = 'No ' + cfg.texts.what + ' found';
      $('#' + P + '-empty-text').textContent = cfg.texts.none;
      return;
    }
    await openSource(st.sources[0].id);
  }

  async function openSource(id) {
    if (!(await okToDrop())) { $('#' + P + '-source').value = st.sourceId; return; }
    const h = notify({ type: 'loading', title: 'Opening ' + cfg.texts.what + '…', message: 'Reading the textures.' });
    try {
      const r = await api.call('tex:open', cfg.kind, id);
      h.close();
      loaded(r, id);
      $('#' + P + '-source').value = id;
    } catch (e) {
      h.update({ type: 'error', title: 'Could not open these ' + cfg.texts.what, message: e.message });
    }
  }

  async function okToDrop() {
    return ![...st.docs.values()].some((d) => d.dirty) || ctx.modal({ title: 'Throw away your changes?', text: 'They are not installed or saved yet.', confirm: 'Throw away', danger: true });
  }

  function loaded(r, id) {
    st.sourceId = id; st.label = r.label; st.items = r.items; st.docs = new Map(); st.cur = null; st.installed = null;
    const lbl = $('#' + P + '-opened');
    if (lbl) lbl.textContent = r.label + ' · ' + r.items.length + ' file' + (r.items.length === 1 ? '' : 's');
    renderList(); renderDirty();
    const first = st.items.flatMap((it) => it.textures.filter((t) => t.editable).map((t) => [it.key, t.index]))[0];
    if (first) select(first[0], first[1]);
    else { $('#' + P + '-empty').classList.remove('hidden'); $('#' + P + '-empty-title').textContent = 'These textures are locked'; $('#' + P + '-empty-text').textContent = 'They use a format this app cannot write yet (BC7 / ATI).'; }
  }

  /** Files mode (Blood FX): open the RPF the player picks (or drops). */
  async function openFilesUI(paths) {
    if (!(await okToDrop())) return;
    const h = notify({ type: 'loading', title: 'Opening ' + cfg.texts.what + '…', message: 'Reading the textures.' });
    try {
      const r = await api.call('tex:openFiles', cfg.kind, paths || null);
      h.close();
      if (r) loaded(r, 'files');
    } catch (e) { h.update({ type: 'error', title: 'Could not open these', message: e.message }); }
  }

  async function saveFolder() {
    const docs = [...st.docs.values()].filter((d) => d.changed);
    if (!docs.length) return notify.info('Nothing changed yet', 'Paint or recolour something first.');
    const btn = $('#' + P + '-savefolder');
    busy(btn, true);
    try {
      const r = await api.call('tex:saveFolder', cfg.kind, docs.map((d) => ({ key: d.item.key, texIndex: d.t.index, data: encodeDoc(d) })));
      if (r) notify.success('Saved', r.count + ' file(s) in ' + r.dir + '. Press Install to use them in your own game.');
    } catch (e) { notify.error('Could not save', e.message); }
    busy(btn, false);
  }


  // ---------- install ----------

  function encodeDoc(d) {
    const parts = [];
    let src = d.c;
    for (let i = 0; i < d.t.levels; i++) {
      const w = Math.max(1, d.w >> i); const h = Math.max(1, d.h >> i);
      const c = canvas(w, h);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h);
      parts.push(encode(d.t.format, g.getImageData(0, 0, w, h).data, w, h));
      src = c;
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  async function install() {
    const docs = [...st.docs.values()].filter((d) => d.changed);
    if (!docs.length) return;
    const btn = $('#' + P + '-install');
    busy(btn, true);
    try {
      if (st.installed) { await api.call('tweaks:removeCustom', st.installed).catch(() => {}); st.installed = null; }
      const edits = docs.map((d) => ({ key: d.item.key, texIndex: d.t.index, data: encodeDoc(d) }));
      const r = await api.call('tex:install', cfg.kind, edits);
      st.installed = r.id;
      for (const d of st.docs.values()) d.dirty = false;
      const where = (rel) => (rel.startsWith('@mods/') ? 'mods/' + rel.slice(6) : 'citizen/' + rel);
      if (r.failed.length) notify.warning('Installed, but a file could not be written', r.failed.map(where).join(', ') + '. Close FiveM and press Install again.');
      else notify.success('Installed', 'Checked on disk: ' + r.verified.map(where).join(', ') + '. Restart FiveM to see it.');
    } catch (e) { notify.error('Could not install', e.message); }
    busy(btn, false);
    renderDirty();
  }

  async function uninstall() {
    if (!st.installed) return;
    try {
      await api.call('tweaks:removeCustom', st.installed);
      st.installed = null;
      for (const d of st.docs.values()) if (d.changed) d.dirty = true;
      notify.success('Back to how it was', 'Your edits are still here; press Install to use them again.');
    } catch (e) { notify.error('Undo failed', e.message); }
    renderDirty();
  }

  // ---------- wiring ----------

  const paneOn = () => cfg.active();
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';

  function paintLabels() {
    $('#' + P + '-size-val').textContent = $('#' + P + '-size').value + 'px';
    $('#' + P + '-soft-val').textContent = $('#' + P + '-soft').value + '%';
    $('#' + P + '-opacity-val').textContent = $('#' + P + '-opacity').value + '%';
    $('#' + P + '-hue-val').textContent = $('#' + P + '-hue').value + '°';
    $('#' + P + '-sat-val').textContent = $('#' + P + '-sat').value + '%';
    $('#' + P + '-bright-val').textContent = ($('#' + P + '-bright').value > 0 ? '+' : '') + $('#' + P + '-bright').value;
    $('#' + P + '-contrast-val').textContent = $('#' + P + '-contrast').value + '%';
    $('#' + P + '-tint-val').textContent = $('#' + P + '-tint-amt').value + '%';
  }

  function resetAdjust() {
    for (const [id, v] of [['cl-hue', 0], ['cl-sat', 100], ['cl-bright', 0], ['cl-contrast', 100], ['cl-tint-amt', 0]]) { $('#' + id).value = v; fillRange($('#' + id)); }
    paintLabels(); st.preview = null; draw();
  }

  function wholeEdit(label, fn) {
    const d = st.cur; if (!d) return;
    snap(d, label);
    fn(d);
    changed();
  }

  async function usePicture() {
    const d = st.cur; if (!d) return;
    let f;
    try { f = await api.call('gfx:pickImage'); } catch (e) { return notify.error('Picture not used', e.message); }
    if (!f) return;
    const img = new Image();
    img.onload = () => wholeEdit('Picture', () => {
      const keep = $('#' + P + '-keep').checked;
      const before = d.g.getImageData(0, 0, d.w, d.h);
      const k = Math.max(d.w / img.width, d.h / img.height);
      d.g.save();
      d.g.globalCompositeOperation = 'copy';
      d.g.drawImage(img, (d.w - img.width * k) / 2, (d.h - img.height * k) / 2, img.width * k, img.height * k);
      d.g.restore();
      if (keep) {
        // the cloud's shape lives in its alpha (transparency); keep it, take the colours from the picture
        const now = d.g.getImageData(0, 0, d.w, d.h);
        for (let i = 3; i < now.data.length; i += 4) now.data[i] = before.data[i];
        d.g.putImageData(now, 0, 0);
      }
    });
    img.src = `data:${f.mediaType};base64,${f.data}`;
  }

  function init(c) {
    ctx = { ...ctx, ...c };
    const mount = $(cfg.mount);
    mount.innerHTML = labHtml(P, cfg);
    hydrateIcons(mount);
    $('#' + P + '-swatches').innerHTML = SWATCHES.map((h) => `<button style="background:${h}" data-hex="${h}" title="${h}"></button>`).join('');
    $$('#' + P + '-swatches button').forEach((b) => (b.onclick = () => { $('#' + P + '-color').value = b.dataset.hex; }));
    $$('#' + P + '-tools [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
    $('#' + P + '-tools [data-act=fit]').onclick = fit;
    $('#' + P + '-tools [data-act="100"]').onclick = actual;
    const srcSel = $('#' + P + '-source');
    if (srcSel) srcSel.onchange = (e) => openSource(e.target.value);
    const rescan = $('#' + P + '-rescan');
    if (rescan) rescan.onclick = findSources;
    const openBtn = $('#' + P + '-openfiles');
    if (openBtn) openBtn.onclick = () => openFilesUI(null);
    const sf = $('#' + P + '-savefolder');
    if (sf) sf.onclick = saveFolder;
    $('#' + P + '-undo').onclick = undo;
    $('#' + P + '-redo').onclick = redo;
    const cmp = $('#' + P + '-compare');
    const on = () => { st.compare = true; draw(); };
    const off = () => { st.compare = false; draw(); };
    cmp.addEventListener('pointerdown', on); cmp.addEventListener('pointerup', off); cmp.addEventListener('pointerleave', off);
    $('#' + P + '-install').onclick = install;
    $('#' + P + '-uninstall').onclick = uninstall;
    for (const id of ['cl-size', 'cl-soft', 'cl-opacity']) $('#' + id).addEventListener('input', paintLabels);
    for (const id of ['cl-hue', 'cl-sat', 'cl-bright', 'cl-contrast', 'cl-tint-amt']) $('#' + id).addEventListener('input', () => { paintLabels(); queuePreview(); });
    $('#' + P + '-tint').addEventListener('input', queuePreview);
    $('#' + P + '-adj-apply').onclick = () => {
      const a = adjustValues(); if (!st.cur || neutral(a)) return;
      applyAdjust(st.cur, a, 'Adjust colours'); resetAdjust(); changed();
    };
    $('#' + P + '-adj-all').onclick = () => {
      const a = adjustValues(); if (neutral(a)) return notify.info('Move a slider first', 'Then press this to colour every texture the same way.');
      let n = 0;
      for (const it of st.items) for (const t of it.textures) if (t.editable) { const d = docFor(it.key, t.index); applyAdjust(d, a, 'Adjust colours (all)'); thumb(d); n++; }
      resetAdjust(); changed();
      notify.success('All changed', n + ' textures. Undo works on each one.');
    };
    $('#' + P + '-adj-reset').onclick = resetAdjust;
    $('#' + P + '-picture').onclick = usePicture;
    $('#' + P + '-flip-h').onclick = () => wholeEdit('Flip ↔', (d) => { const c2 = canvas(d.w, d.h); c2.getContext('2d').drawImage(d.c, 0, 0); d.g.save(); d.g.globalCompositeOperation = 'copy'; d.g.translate(d.w, 0); d.g.scale(-1, 1); d.g.drawImage(c2, 0, 0); d.g.restore(); });
    $('#' + P + '-flip-v').onclick = () => wholeEdit('Flip ↕', (d) => { const c2 = canvas(d.w, d.h); c2.getContext('2d').drawImage(d.c, 0, 0); d.g.save(); d.g.globalCompositeOperation = 'copy'; d.g.translate(0, d.h); d.g.scale(1, -1); d.g.drawImage(c2, 0, 0); d.g.restore(); });
    $('#' + P + '-invert').onclick = () => wholeEdit('Invert', (d) => { const im = d.g.getImageData(0, 0, d.w, d.h); for (let i = 0; i < im.data.length; i += 4) { im.data[i] = 255 - im.data[i]; im.data[i + 1] = 255 - im.data[i + 1]; im.data[i + 2] = 255 - im.data[i + 2]; } d.g.putImageData(im, 0, 0); });
    $('#' + P + '-mono').onclick = () => wholeEdit('Black & white', (d) => { const im = d.g.getImageData(0, 0, d.w, d.h); d.g.putImageData(new ImageData(adjustPixels(im.data, { hue: 0, sat: 0, bright: 0, contrast: 1, tint: '#ffffff', tintAmt: 0 }), d.w, d.h), 0, 0); });
    $('#' + P + '-reset-tex').onclick = () => wholeEdit('Back to original', (d) => d.g.putImageData(d.orig, 0, 0));
    addEventListener('keydown', (e) => {
      if (!paneOn() || typing(e)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tools = { b: 'brush', e: 'eraser', i: 'picker', g: 'fill', h: 'hand' };
      if (tools[k]) setTool(tools[k]);
      if (k === '0') fit();
      if (k === '1') actual();
      if (k === '[' || k === ']') { const s = $('#' + P + '-size'); s.value = Math.max(1, Math.min(400, +s.value + (k === ']' ? 5 : -5))); fillRange(s); paintLabels(); draw(); }
    });
    bindStage();
    setTool('brush');
    paintLabels();
  }

  /** Called when the Clouds tab opens. */
  function enter() {
    if (!st.opened) { st.opened = true; if (cfg.mode !== 'files') findSources(); }
    else requestAnimationFrame(() => draw());
  }

  return { init, enter, openPaths: (paths) => openFilesUI(paths) };
}
