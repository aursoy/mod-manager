// Gun Lab: 3D preview of weapon drawables, texture recolouring, 3D-style text
// stamping, and re-encoding back into the original archive.
//
// Performance model: colour filters run on a full-res "graded" canvas only
// when colour settings change. Interactive redraws (text drag, sliders for
// text) only touch a <=1024px preview canvas (3D texture) and the on-screen
// 2D view canvas. Full-res compositing happens once, at export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { notify } from './notify.js';
import { icon } from './icons.js';
import { decode, encode, EDITABLE } from './dxt.js';
import { syncSeg, fillRange, busy } from './fx.js';
import { needsKeys, ensureKeys, cleanError } from './keys.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAINTS = ['#0a0a0a', '#ffffff', '#c9c9c9', '#ff2d2d', '#ff8a3d', '#ffd24d', '#7dff3a', '#22e3b2', '#00e5ff', '#3d6bff', '#9b5cff', '#ff5fa8'];
const DEFAULT_FX = { hue: 0, sat: 100, bright: 100, contrast: 100, tint: '#ffffff', tintAmt: 0, mode: 'color' };
const PREVIEW_MAX = 1024;
const AUX = /(_n|_s|_m|_nm|_spec|_normal|_mask)$/i;

let pack = null;
let textures = [];
let selected = -1;
let selLayer = null;
let placing = false;
let layerSeq = 1;

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- three ----------
const three = { renderer: null, scene: null, camera: null, controls: null, group: null, meshes: [], studio: true, lights: [], dirty: true };
const requestFrame = () => { three.dirty = true; };

function initThree() {
  const host = $('#viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.minDistance = 0.6;
  controls.maxDistance = 12;
  controls.addEventListener('change', requestFrame);

  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 4, 2);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(-3, 2, -3);
  const fill = new THREE.HemisphereLight(0xffffff, 0x111111, 0.6);
  scene.add(key, rim, fill);
  three.lights = [key, rim];

  // Floor: soft contact shadow + thin rings.
  const sc = canvas(256, 256);
  const g = sc.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,.85)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const floor = new THREE.Group();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  floor.add(shadow);
  for (let i = 1; i <= 3; i++) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(i * 0.7, i * 0.7 + 0.004, 128), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 / i, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    floor.add(ring);
  }
  floor.position.y = -0.62;
  scene.add(floor);

  const group = new THREE.Group();
  scene.add(group);
  Object.assign(three, { renderer, scene, camera, controls, group, floor });

  new ResizeObserver(fitViewport).observe(host);
  new ResizeObserver(() => { sizeViewCanvas(); paintTexView(); }).observe($('#tex-view'));

  const loop = () => {
    requestAnimationFrame(loop);
    const visible = $('.page[data-page=gun]').classList.contains('active') && !$('#gun-lab').classList.contains('hidden') && !$('#viewport').classList.contains('hidden');
    if (!visible) return;
    // update() returns true while damping/auto-rotate is moving the camera.
    const moving = controls.update();
    if (moving || three.dirty) {
      three.dirty = false;
      renderer.render(scene, camera);
    }
  };
  loop();

  // Click-to-place text using the UV under the cursor.
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!placing || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(three.meshes, false)[0];
    if (!hit || !hit.uv) return notify.warning('Missed the gun', 'Click directly on the model surface.');
    placeLayerAt(hit.object.userData.texIdx ?? selected, hit.uv);
  });
}

function fitViewport() {
  if (!three.renderer) return;
  const r = $('#viewport').getBoundingClientRect();
  if (!r.width || !r.height) return;
  three.renderer.setSize(r.width, r.height, false);
  three.camera.aspect = r.width / r.height;
  three.camera.updateProjectionMatrix();
  requestFrame();
}

function frameModel() {
  const box = new THREE.Box3().setFromObject(three.group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = 2 / Math.max(size.x, size.y, size.z, 1e-3);
  three.group.children.forEach((c) => c.position.sub(centre));
  three.group.scale.setScalar(scale);
  three.floor.position.y = -(size.y * scale) / 2 - 0.04;
  resetCamera();
}

function resetCamera() {
  // Fit a sphere of radius ~1.1 (model is normalised to 2 units) in both FOVs.
  const cam = three.camera;
  const r = 0.95;
  const v = THREE.MathUtils.degToRad(cam.fov) / 2;
  const h = Math.atan(Math.tan(v) * cam.aspect);
  const dist = Math.max(r / Math.sin(v), r / Math.sin(h)) * 1.05;
  cam.position.copy(new THREE.Vector3(2.6, 1.1, 3.2).normalize().multiplyScalar(dist));
  three.controls.target.set(0, 0, 0);
  three.controls.update();
  requestFrame();
}

// Skip duplicate LODs (_hi copies, identical mags) and placeholder meshes.
function uniqueMeshes() {
  const seen = new Set();
  const out = [];
  for (const a of pack.assets) {
    for (const m of a.meshes || []) {
      if (m.positions.length < 12) continue;
      const p = m.positions;
      const sig = [p.length, m.indices.length, p[0].toFixed(4), p[1].toFixed(4), p[p.length - 1].toFixed(4)].join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(m);
    }
  }
  return out;
}

function buildModel() {
  three.group.clear();
  three.group.scale.setScalar(1);
  three.meshes = [];
  const byName = new Map();
  textures.forEach((t, i) => { if (!byName.has(t.name.toLowerCase())) byName.set(t.name.toLowerCase(), i); });
  const meshes = uniqueMeshes();
  if (meshes.length) {
    const holder = new THREE.Group();
    holder.rotation.x = -Math.PI / 2; // GTA is Z-up
    for (const m of meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      if (m.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      if (m.normals) geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      else geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, null);
      mesh.userData.texIdx = (m.textures || []).map((n) => byName.get(n)).find((i) => i !== undefined);
      mesh.userData.hasUv = !!m.uvs;
      holder.add(mesh);
      three.meshes.push(mesh);
    }
    const wrap = new THREE.Group();
    wrap.add(holder);
    three.group.add(wrap);
    wrap.updateMatrixWorld(true);
  } else {
    // No drawable: show the texture as a floating card.
    const t = textures[selected] || textures[0];
    const aspect = t ? t.w / t.h : 1;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(aspect >= 1 ? 2 : 2 * aspect, aspect >= 1 ? 2 / aspect : 2), null);
    mesh.userData.card = true;
    mesh.userData.hasUv = true;
    three.group.add(mesh);
    three.meshes.push(mesh);
  }
  frameModel();
  updateMaterials();
}

function materialFor(texIdx) {
  const t = textures[texIdx];
  if (!t) return three.grey || (three.grey = new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.5, roughness: 0.45 }));
  if (!t.mat) t.mat = new THREE.MeshStandardMaterial({ map: t.tex || null, color: t.tex ? 0xffffff : 0x666666, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide });
  return t.mat;
}

function updateMaterials() {
  for (const m of three.meshes) {
    let idx = m.userData.texIdx;
    if (idx === undefined || m.userData.card) idx = selected;
    m.material = m.userData.hasUv ? materialFor(idx) : materialFor(-1);
  }
  requestFrame();
}

// ---------- textures ----------
// Textures with the same name/size/format (e.g. in a .ydr and its _hi copy)
// are edited once and written to every copy.
function groupTextures() {
  const groups = new Map();
  for (const a of pack.assets) {
    for (const tx of a.textures) {
      const key = [tx.name.toLowerCase(), tx.width, tx.height, tx.format, tx.levels].join('|');
      if (!groups.has(key)) groups.set(key, { src: tx, targets: [] });
      groups.get(key).targets.push({ assetId: a.id, textureIndex: tx.index });
    }
  }
  return [...groups.values()];
}

function setupTexture({ src, targets }) {
  const t = {
    targets, name: src.name, w: src.width, h: src.height, levels: src.levels,
    format: src.format, data: src.data, editable: src.editable && EDITABLE.includes(src.format),
    fx: { ...DEFAULT_FX }, layers: [], dirty: false,
  };
  if (!t.editable) return t;
  try {
    const rgba = decode(t.format, t.data, t.w, t.h);
    t.alpha = new Uint8Array(t.w * t.h);
    for (let i = 0; i < t.w * t.h; i++) { t.alpha[i] = rgba[i * 4 + 3]; rgba[i * 4 + 3] = 255; }
    t.base = canvas(t.w, t.h);
    t.base.getContext('2d').putImageData(new ImageData(rgba, t.w, t.h), 0, 0);
    t.graded = canvas(t.w, t.h);
    t.k = Math.min(1, PREVIEW_MAX / Math.max(t.w, t.h));
    t.pw = Math.max(1, Math.round(t.w * t.k)); t.ph = Math.max(1, Math.round(t.h * t.k));
    t.gradedSmall = canvas(t.pw, t.ph);
    t.preview = canvas(t.pw, t.ph);
    t.tex = new THREE.CanvasTexture(t.preview);
    t.tex.flipY = false;
    t.tex.colorSpace = THREE.SRGBColorSpace;
    t.tex.anisotropy = 8;
    t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping;
    regrade(t);
    compose(t);
  } catch (e) {
    t.editable = false;
    t.error = e.message;
  }
  return t;
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(c * k);
  return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
}

// Draw a text layer in texture pixel space (caller sets any scale).
function drawLayer(g, L) {
  if (!L.text) return;
  g.save();
  g.translate(L.x, L.y);
  g.rotate((L.rot * Math.PI) / 180);
  g.font = `900 ${L.size}px "${L.font}"`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const step = Math.max(0.5, L.size / 70);
  for (let d = L.depth; d >= 1; d--) {
    g.fillStyle = shade(L.side, 0.35 + 0.65 * (1 - d / (L.depth + 1)));
    g.fillText(L.text, d * step * 0.8, d * step);
  }
  if (L.outline) {
    g.lineWidth = L.outline * 2;
    g.strokeStyle = L.stroke;
    g.strokeText(L.text, 0, 0);
  }
  if (L.glow) { g.shadowColor = L.fill; g.shadowBlur = L.glow * (g.getTransform().a || 1); }
  const grad = g.createLinearGradient(0, -L.size / 2, 0, L.size / 2);
  grad.addColorStop(0, L.fill);
  grad.addColorStop(1, shade(L.fill, 0.78));
  g.fillStyle = grad;
  g.fillText(L.text, 0, 0);
  g.shadowBlur = 0;
  L.bw = g.measureText(L.text).width; L.bh = L.size;
  g.restore();
}

// Colour pass: full res + preview-sized copy. Only runs when fx change.
function regrade(t) {
  const f = t.fx;
  const g = t.graded.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.filter = `hue-rotate(${f.hue}deg) saturate(${f.sat}%) brightness(${f.bright}%) contrast(${f.contrast}%)`;
  g.drawImage(t.base, 0, 0);
  g.filter = 'none';
  if (f.tintAmt > 0) {
    g.globalCompositeOperation = f.mode;
    g.globalAlpha = f.tintAmt / 100;
    g.fillStyle = f.tint;
    g.fillRect(0, 0, t.w, t.h);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
  const s = t.gradedSmall.getContext('2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(t.graded, 0, 0, t.pw, t.ph);
}

// Layer pass at preview resolution: cheap enough to run every frame.
function compose(t) {
  const g = t.preview.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(t.gradedSmall, 0, 0);
  g.setTransform(t.k, 0, 0, t.k, 0, 0);
  t.layers.forEach((L) => drawLayer(g, L));
  g.setTransform(1, 0, 0, 1, 0, 0);
  t.tex.needsUpdate = true;
  t.dirty = t.layers.length > 0 || Object.keys(DEFAULT_FX).some((k) => t.fx[k] !== DEFAULT_FX[k]);
  requestFrame();
}

// Full-res composite, used only for export.
function composeFull(t) {
  const out = canvas(t.w, t.h);
  const g = out.getContext('2d');
  g.drawImage(t.graded, 0, 0);
  t.layers.forEach((L) => drawLayer(g, L));
  return out;
}

let rafJob = 0;
let pendingGrade = false;
function scheduleRender(grade = false) {
  pendingGrade = pendingGrade || grade;
  if (rafJob) return;
  rafJob = requestAnimationFrame(() => {
    rafJob = 0;
    const t = textures[selected];
    if (!t || !t.editable) return;
    if (pendingGrade) regrade(t);
    pendingGrade = false;
    compose(t);
    paintTexView();
    idleRefresh();
  });
}

// Thumbnails and counters don't need to update at 60fps.
const idleRefresh = debounce(() => { paintThumb(selected); refreshDirtyMarks(); }, 250);

// ---------- UI: texture list ----------
function paintThumb(i) {
  const t = textures[i];
  const c = $(`#tex-list li[data-i="${i}"] canvas`);
  if (!c || !t) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (t.preview) g.drawImage(t.preview, 0, 0, c.width, c.height);
  else { g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, c.width, c.height); }
}

let lastSum = '';
function refreshDirtyMarks() {
  textures.forEach((t, i) => $(`#tex-list li[data-i="${i}"] b`)?.classList.toggle('dirty', t.dirty));
  const n = textures.filter((t) => t.dirty).length;
  const html = `
    <div class="row"><span>Edited textures</span><b>${n} / ${textures.filter((t) => t.editable).length}</b></div>
    <div class="row"><span>Text layers</span><b>${textures.reduce((s, t) => s + t.layers.length, 0)}</b></div>
    <div class="row"><span>Files updated</span><b>${new Set(textures.filter((t) => t.dirty).flatMap((t) => t.targets.map((x) => x.assetId))).size}</b></div>
    <div class="row"><span>Source</span><b>${esc(pack ? pack.file : '')}</b></div>`;
  if (html !== lastSum) { $('#export-sum').innerHTML = html; lastSum = html; }
}

function renderTexList() {
  $('#tex-list').innerHTML = textures.map((t, i) => `
    <li data-i="${i}" class="${i === selected ? 'on' : ''} ${t.editable ? '' : 'locked'}" style="animation-delay:${i * 40}ms">
      <canvas width="88" height="88"></canvas>
      <div><b>${esc(t.name)}</b><small>${t.w}×${t.h} · ${t.format}${t.targets.length > 1 ? ' · ×' + t.targets.length : ''}${t.editable ? '' : ' · locked'}</small></div>
    </li>`).join('') || '<li class="locked"><div><b>No textures</b><small>nothing editable here</small></div></li>';
  textures.forEach((_, i) => paintThumb(i));
  $$('#tex-list li[data-i]').forEach((li) => (li.onclick = () => selectTexture(+li.dataset.i)));
  refreshDirtyMarks();
}

function selectTexture(i) {
  const t = textures[i];
  if (!t) return;
  if (!t.editable) notify.warning('Texture is locked', `${t.format} textures can be previewed by the game but not re-encoded here.`);
  selected = i;
  selLayer = t.layers[t.layers.length - 1] || null;
  $$('#tex-list li').forEach((li) => li.classList.toggle('on', +li.dataset.i === i));
  syncFxControls();
  renderLayers();
  updateMaterials();
  sizeViewCanvas();
  paintTexView();
}

// ---------- UI: colour ----------
function syncFxControls() {
  const t = textures[selected];
  const f = t ? t.fx : DEFAULT_FX;
  $$('[data-fx]').forEach((el) => { el.value = f[el.dataset.fx]; if (el.type === 'range') fillRange(el); });
  const seg = $('[data-fx-seg=mode]');
  $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === f.mode));
  syncSeg(seg);
  syncFxLabels();
  $$('#gun-swatches .sw').forEach((s) => s.classList.toggle('on', f.tintAmt > 0 && s.dataset.hex === f.tint));
}

function syncFxLabels() {
  const t = textures[selected];
  const f = t ? t.fx : DEFAULT_FX;
  $('[data-out=hue]').textContent = f.hue + '°';
  $('[data-out=sat]').textContent = f.sat + '%';
  $('[data-out=bright]').textContent = f.bright + '%';
  $('[data-out=contrast]').textContent = f.contrast + '%';
  $('[data-out=tintAmt]').textContent = f.tintAmt + '%';
}

function editable() {
  const t = textures[selected];
  if (!t) return null;
  if (!t.editable) { notify.warning('Texture is locked', 'Pick a DXT or 32-bit texture to edit.'); return null; }
  return t;
}

// ---------- UI: text layers ----------
function newLayer(t) {
  return {
    id: layerSeq++, text: 'KT', font: 'Impact', size: Math.round(t.h / 9), depth: 8, rot: 0, outline: 2, glow: 0,
    fill: '#ffffff', side: '#3a3a3a', stroke: '#000000', x: t.w / 2, y: t.h / 2,
  };
}

function renderLayers() {
  const t = textures[selected];
  const list = $('#layer-list');
  const layers = t ? t.layers : [];
  list.innerHTML = layers.length
    ? layers.map((L) => `<li data-id="${L.id}" class="${selLayer && selLayer.id === L.id ? 'on' : ''}">${icon('type')}<span>${esc(L.text || '(empty)')}</span><small>${L.font}</small></li>`).join('')
    : '<li class="empty">No text yet</li>';
  $$('li[data-id]', list).forEach((li) => (li.onclick = () => { selLayer = layers.find((L) => L.id === +li.dataset.id); renderLayers(); paintTexView(); }));
  const ed = $('#layer-editor');
  ed.classList.toggle('hidden', !selLayer);
  if (selLayer) {
    const sz = $('[data-tx=size]', ed);
    sz.max = Math.max(400, Math.round(t.h / 2));
    $$('[data-tx]', ed).forEach((el) => { el.value = selLayer[el.dataset.tx]; if (el.type === 'range') fillRange(el); });
    syncLayerLabels();
  }
}

function syncLayerLabels() {
  if (!selLayer) return;
  $('[data-txo=size]').textContent = selLayer.size + 'px';
  $('[data-txo=depth]').textContent = selLayer.depth;
  $('[data-txo=rot]').textContent = selLayer.rot + '°';
  $('[data-txo=outline]').textContent = selLayer.outline;
  $('[data-txo=glow]').textContent = selLayer.glow;
}

function setPlacing(on) {
  placing = on;
  $('#place-hint').classList.toggle('hidden', !on);
  $('#viewport').classList.toggle('placing', on);
  $('#text-place').classList.toggle('primary', on);
  $('#text-place').classList.toggle('ghost', !on);
  if (on) { three.controls.autoRotate = false; $('#view-spin').classList.remove('on'); switchView('3d'); }
}

function placeLayerAt(texIdx, uv) {
  const t = textures[texIdx];
  if (!t || !t.editable) return notify.warning('Can\'t place there', 'That part of the gun uses a locked texture.');
  if (!selLayer) return;
  const from = textures.find((x) => x.layers.includes(selLayer));
  if (from && from !== t) {
    from.layers = from.layers.filter((L) => L !== selLayer);
    compose(from);
    t.layers.push(selLayer);
  }
  const u = ((uv.x % 1) + 1) % 1, v = ((uv.y % 1) + 1) % 1;
  selLayer.x = Math.round(u * t.w);
  selLayer.y = Math.round(v * t.h);
  if (texIdx !== selected) selectTexture(texIdx);
  setPlacing(false);
  scheduleRender();
  renderLayers();
  notify.success('Text placed', `"${selLayer.text}" stamped onto ${t.name}.`);
}

// ---------- 2D view ----------
// The view canvas is sized to its on-screen pixels, not the texture.
const view = { scale: 1 };
function sizeViewCanvas() {
  const t = textures[selected];
  const c = $('#tex-canvas');
  const box = $('#tex-view').getBoundingClientRect();
  if (!t || !box.width) return;
  const availW = box.width - 60, availH = box.height - 100;
  const k = Math.max(0.05, Math.min(availW / t.w, availH / t.h));
  const cssW = Math.floor(t.w * k), cssH = Math.floor(t.h * k);
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.style.width = cssW + 'px';
  c.style.height = cssH + 'px';
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  view.scale = c.width / t.w;
}

function paintTexView() {
  if ($('#tex-view').classList.contains('hidden')) return;
  const t = textures[selected];
  const c = $('#tex-canvas');
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!t || !t.preview) return;
  g.drawImage(t.preview, 0, 0, c.width, c.height);
  if (selLayer && t.layers.includes(selLayer) && selLayer.bw) {
    g.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    g.translate(selLayer.x, selLayer.y);
    g.rotate((selLayer.rot * Math.PI) / 180);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 / view.scale;
    g.setLineDash([6 / view.scale, 4 / view.scale]);
    g.strokeRect(-selLayer.bw / 2 - 8, -selLayer.bh / 2 - 4, selLayer.bw + 16, selLayer.bh + 8);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}

function initTexViewDrag() {
  const c = $('#tex-canvas');
  let drag = null;
  const toTex = (e) => {
    const t = textures[selected];
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * t.w, y: ((e.clientY - r.top) / r.height) * t.h };
  };
  c.addEventListener('pointerdown', (e) => {
    const t = textures[selected];
    if (!t || !t.editable) return;
    const p = toTex(e);
    const hit = [...t.layers].reverse().find((L) => Math.abs(p.x - L.x) < (L.bw || 100) / 2 + 10 && Math.abs(p.y - L.y) < (L.bh || 50) / 2 + 10);
    if (hit && hit !== selLayer) { selLayer = hit; renderLayers(); }
    if (!selLayer || !t.layers.includes(selLayer)) return;
    drag = { dx: p.x - selLayer.x, dy: p.y - selLayer.y };
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toTex(e);
    selLayer.x = Math.round(p.x - drag.dx);
    selLayer.y = Math.round(p.y - drag.dy);
    scheduleRender();
  });
  const end = () => { drag = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

function switchView(v) {
  $$('.vt').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $('.vt-pill').style.transform = v === '2d' ? 'translateX(86px)' : '';
  $('#viewport').classList.toggle('hidden', v !== '3d');
  $('#tex-view').classList.toggle('hidden', v !== '2d');
  $('.view-tools').classList.toggle('hidden', v !== '3d');
  if (v === '2d') { sizeViewCanvas(); paintTexView(); } else requestFrame();
}

// ---------- open / close ----------
export async function openGunFile(path) {
  if (!path) return;
  const h = notify({ type: 'loading', title: 'Opening weapon…', message: path.split(/[\\/]/).pop() });
  try {
    pack = await api.call('gun:open', path);
  } catch (e) {
    if (needsKeys(e)) {
      h.close();
      if (await ensureKeys('This weapon pack is encrypted by Rockstar (NG).')) return openGunFile(path);
      return;
    }
    h.update({ type: 'error', title: 'Could not open file', message: cleanError(e.message) });
    return;
  }
  disposeTextures();
  await new Promise((r) => setTimeout(r, 30)); // let the toast paint before heavy decode
  textures = groupTextures().map(setupTexture);
  selected = textures.findIndex((t) => t.editable && !AUX.test(t.name));
  if (selected < 0) selected = Math.max(0, textures.findIndex((t) => t.editable));
  selLayer = null;
  $('#gun-empty').classList.add('hidden');
  $('#gun-lab').classList.remove('hidden');
  if (!three.renderer) initThree();
  switchView('3d');
  fitViewport();
  const meshCount = uniqueMeshes().length;
  $('#gun-file').textContent = pack.file;
  $('#gun-meta').textContent = `${pack.assets.length} file(s) · ${textures.length} texture(s) · ${meshCount} mesh(es)`;
  renderTexList();
  buildModel();
  selectTexture(selected);
  const warn = pack.assets.flatMap((a) => a.warnings || []);
  h.update({
    type: 'success',
    title: pack.file + ' loaded',
    message: meshCount ? `${meshCount} mesh part(s) and ${textures.length} texture(s) ready.` : `${textures.length} texture(s) ready. No .ydr model inside, so showing a texture card.`,
  });
  if (warn.length) notify.warning('Some parts were skipped', warn.slice(0, 3).join(' · '));
  if (!textures.some((t) => t.editable)) notify.warning('Nothing editable', 'All textures use formats that cannot be re-encoded (BC7 / ATI).');
}

function disposeTextures() {
  textures.forEach((t) => { t.tex && t.tex.dispose(); t.mat && t.mat.dispose(); });
  three.meshes.forEach((m) => m.geometry.dispose());
}

function closeFile() {
  disposeTextures();
  pack = null;
  textures = [];
  if (three.group) three.group.clear();
  three.meshes = [];
  setPlacing(false);
  $('#gun-lab').classList.add('hidden');
  $('#gun-empty').classList.remove('hidden');
}

// ---------- export ----------
function buildLevels(t) {
  const parts = [];
  let prev = composeFull(t);
  let prevAlpha = t.alpha;
  let pw = t.w, ph = t.h;
  for (let i = 0; i < t.levels; i++) {
    const w = Math.max(1, t.w >> i), h = Math.max(1, t.h >> i);
    const c = canvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(prev, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    // Alpha is carried over untouched from the original, box-filtered per mip.
    let a = prevAlpha;
    if (i > 0) {
      a = new Uint8Array(w * h);
      const sx = pw / w, sy = ph / h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let yy = Math.floor(y * sy); yy < Math.min(ph, Math.floor((y + 1) * sy)); yy++)
          for (let xx = Math.floor(x * sx); xx < Math.min(pw, Math.floor((x + 1) * sx)); xx++) { s += prevAlpha[yy * pw + xx]; n++; }
        a[y * w + x] = n ? Math.round(s / n) : 255;
      }
    }
    for (let k = 0; k < w * h; k++) px[k * 4 + 3] = a[k];
    parts.push(encode(t.format, px, w, h));
    prev = c; prevAlpha = a; pw = w; ph = h;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function doExport(opts, btn) {
  const dirty = textures.filter((t) => t.dirty && t.editable);
  if (!dirty.length) return notify.info('Nothing to export yet', 'Change a colour or add some text first.');
  busy(btn, true);
  const h = notify({ type: 'loading', title: 'Encoding textures…', message: `0 / ${dirty.length}` });
  try {
    const edits = [];
    for (let i = 0; i < dirty.length; i++) {
      await new Promise((r) => setTimeout(r, 30));
      const t = dirty[i];
      const data = buildLevels(t);
      if (data.length !== t.data.length) throw new Error(`Size mismatch on ${t.name}`);
      for (const tg of t.targets) edits.push({ ...tg, data });
      h.update({ type: 'loading', title: 'Encoding textures…', message: `${i + 1} / ${dirty.length} · ${t.name}` });
    }
    h.update({ type: 'loading', title: 'Packing archive…', message: 'Compressing and writing' });
    const r = await api.call('gun:export', edits, opts);
    if (!r) { h.close(); busy(btn, false); return; }
    h.update({
      type: 'success',
      title: opts.toMods ? 'Installed to FiveM mods' : 'Gun exported',
      message: `${r.path.split(/[\\/]/).pop()} · ${(r.bytes / 1048576).toFixed(1)} MB`,
      action: { label: 'Show in folder', fn: () => api.call('shell:reveal', r.path) },
      duration: 9000,
    });
  } catch (e) {
    h.update({ type: 'error', title: 'Export failed', message: e.message });
  }
  busy(btn, false);
}

// Dev-only timing probe (used by the KT_SHOT harness): ms per text-drag frame
// and per colour-slider frame, including the GPU texture upload.
export function perfProbe() {
  const t = textures[selected];
  if (!t || !t.editable) return null;
  if (!selLayer) { selLayer = newLayer(t); t.layers.push(selLayer); }
  const frame = () => three.renderer.render(three.scene, three.camera);
  let t0 = performance.now();
  for (let i = 0; i < 60; i++) { selLayer.x += 3; compose(t); paintTexView(); frame(); }
  const drag = (performance.now() - t0) / 60;
  t0 = performance.now();
  for (let i = 0; i < 20; i++) { t.fx.hue = i * 5; regrade(t); compose(t); paintTexView(); frame(); }
  const grade = (performance.now() - t0) / 20;
  return { texture: t.w + 'x' + t.h, dragMs: +drag.toFixed(2), gradeMs: +grade.toFixed(2) };
}

// ---------- init ----------
export function initGunLab() {
  $('#gun-browse').onclick = async () => openGunFile(await api.call('gun:pick'));
  $('#gun-drop').onclick = (e) => { if (!e.target.closest('button')) $('#gun-browse').click(); };
  $('#gun-close').onclick = closeFile;

  $('#gun-swatches').innerHTML = PAINTS.map((h) => `<button class="sw" data-hex="${h}" style="background:${h}"></button>`).join('');
  $$('#gun-swatches .sw').forEach((s) => (s.onclick = () => {
    const t = editable(); if (!t) return;
    t.fx.tint = s.dataset.hex;
    if (!t.fx.tintAmt) t.fx.tintAmt = 75;
    syncFxControls();
    scheduleRender(true);
  }));

  $$('[data-fx]').forEach((el) => el.addEventListener('input', () => {
    const t = editable(); if (!t) return;
    t.fx[el.dataset.fx] = el.type === 'range' ? +el.value : el.value;
    if (el.dataset.fx === 'tint' && !t.fx.tintAmt) { t.fx.tintAmt = 60; syncFxControls(); }
    syncFxLabels();
    scheduleRender(true);
  }));
  const seg = $('[data-fx-seg=mode]');
  $$('button', seg).forEach((b) => (b.onclick = () => {
    const t = editable(); if (!t) return;
    t.fx.mode = b.dataset.v;
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    syncSeg(seg);
    scheduleRender(true);
  }));
  $('#fx-reset').onclick = () => {
    const t = editable(); if (!t) return;
    t.fx = { ...DEFAULT_FX };
    syncFxControls();
    scheduleRender(true);
    notify.info('Texture reset', t.name + ' colours back to original.');
  };

  // Tabs
  $$('#inspector-tabs .tab').forEach((b, i) => (b.onclick = () => {
    $$('#inspector-tabs .tab').forEach((x) => x.classList.toggle('on', x === b));
    $('.tab-pill').style.transform = `translateX(${i * 100}%)`;
    $$('.tab-body').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== b.dataset.tab));
    if (b.dataset.tab === 'colour') requestAnimationFrame(() => syncSeg(seg));
    if (b.dataset.tab === 'export') refreshDirtyMarks();
  }));
  $$('.vt').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));

  // Text layers
  $('#text-add').onclick = () => {
    const t = editable(); if (!t) return;
    const L = newLayer(t);
    t.layers.push(L);
    selLayer = L;
    renderLayers();
    scheduleRender();
    const f = $('[data-tx=text]'); f.focus(); f.select();
  };
  $$('[data-tx]').forEach((el) => el.addEventListener('input', () => {
    if (!selLayer) return;
    selLayer[el.dataset.tx] = el.type === 'range' ? +el.value : el.value;
    syncLayerLabels();
    if (el.dataset.tx === 'text' || el.dataset.tx === 'font') {
      const li = $(`#layer-list li[data-id="${selLayer.id}"]`);
      if (li) { $('span', li).textContent = selLayer.text || '(empty)'; $('small', li).textContent = selLayer.font; }
    }
    scheduleRender();
  }));
  $('#text-del').onclick = () => {
    const t = textures[selected];
    if (!t || !selLayer) return;
    t.layers = t.layers.filter((L) => L !== selLayer);
    selLayer = t.layers[t.layers.length - 1] || null;
    renderLayers();
    scheduleRender();
  };
  $('#text-place').onclick = () => {
    if (!selLayer) return;
    if (!uniqueMeshes().length) return notify.info('No 3D model', 'Drag the text in the Texture view instead.');
    setPlacing(!placing);
  };

  // View tools
  $('#view-spin').classList.add('on');
  $('#view-spin').onclick = (e) => { three.controls.autoRotate = !three.controls.autoRotate; e.currentTarget.classList.toggle('on', three.controls.autoRotate); requestFrame(); };
  $('#view-reset').onclick = resetCamera;
  $('#view-light').classList.add('on');
  $('#view-light').onclick = (e) => {
    three.studio = !three.studio;
    three.lights.forEach((l, i) => (l.intensity = three.studio ? (i === 0 ? 2.2 : 1.6) : 0.3));
    three.renderer.toneMappingExposure = three.studio ? 1.05 : 0.8;
    e.currentTarget.classList.toggle('on', three.studio);
    requestFrame();
  };

  // Export
  $('#export-save').onclick = (e) => doExport({}, e.currentTarget);
  $('#export-mods').onclick = (e) => doExport({ toMods: true }, e.currentTarget);

  initTexViewDrag();
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && placing) setPlacing(false); });
}
