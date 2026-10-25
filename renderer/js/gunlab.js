// Gun Lab: 3D preview of weapon drawables, texture recolouring, real 3D parts
// (extruded text, a chain with a pendant; see gunparts.js) that are written into
// the gun's model, and re-encoding back into the original archive.
//
// Performance model: colour filters run on a full-res "graded" canvas only
// when colour settings change. Interactive redraws only touch a <=1024px
// preview canvas (3D texture) and the on-screen 2D view canvas. Full-res
// compositing happens once, at export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { notify } from './notify.js';
import { icon } from './icons.js';
import { decode, encode, EDITABLE } from './dxt.js';
import { syncSeg, fillRange, busy } from './fx.js';
import { needsKeys, ensureKeys, cleanError } from './keys.js';
import { loadFont, addFont, fontReady } from './text3d.js';
import * as GP from './gunparts.js';

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
let parts = []; // 3D text and chains
let selPart = null;
let placing = null; // the part waiting for a click on the gun
let partSeq = 1;

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

  // Click on the model to place the selected part there.
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!placing || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(three.meshes.filter((m) => !m.userData.card), false)[0];
    if (!hit) return notify.warning('Missed the gun', 'Click on the model.');
    placePartAt(hit);
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
      mesh.userData.src = m;
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
    fx: { ...DEFAULT_FX }, patches: [], dirty: false,
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

// Colour patches for the 3D parts (texture pixel space; caller sets any scale).
function drawPatches(g, t) {
  for (const p of t.patches) {
    if (p.image) {
      g.fillStyle = p.fill || '#000';
      g.fillRect(p.x, p.y, p.w, p.h);
      const k = Math.max(p.w / p.image.width, p.h / p.image.height);
      const w = p.image.width * k, h = p.image.height * k;
      g.save(); g.beginPath(); g.rect(p.x, p.y, p.w, p.h); g.clip();
      g.drawImage(p.image, p.x + (p.w - w) / 2, p.y + (p.h - h) / 2, w, h);
      g.restore();
    } else {
      g.fillStyle = p.colour;
      g.fillRect(p.x, p.y, p.w, p.h);
    }
  }
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
  drawPatches(g, t);
  g.setTransform(1, 0, 0, 1, 0, 0);
  t.tex.needsUpdate = true;
  t.dirty = t.patches.length > 0 || Object.keys(DEFAULT_FX).some((k) => t.fx[k] !== DEFAULT_FX[k]);
  requestFrame();
}

// Full-res composite, used only for export.
function composeFull(t) {
  const out = canvas(t.w, t.h);
  const g = out.getContext('2d');
  g.drawImage(t.graded, 0, 0);
  drawPatches(g, t);
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
    <div class="row"><span>3D parts</span><b>${parts.filter((x) => x.at).length}</b></div>
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
  $$('#tex-list li').forEach((li) => li.classList.toggle('on', +li.dataset.i === i));
  syncFxControls();
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

// ---------- 3D parts (text, chains) ----------
const TEXT_DEFAULT = { text: 'KT', font: 'Impact', size: 1.6, depth: 2.5, bevel: 8, rot: 0, lift: 0, front: '#ffffff', side: '#1a1a1a', finish: 'chrome' };
const CHAIN_DEFAULT = { links: 9, linkSize: 3.5, linkThick: 24, colour: '#d9b44a', finish: 'chrome', pendant: 'logo', shape: 'circle', pendantText: 'KT', pendantSize: 3, rim: '#d9b44a', logo: null, font: 'Impact' };
const UNITS = { size: ' cm', depth: ' mm', bevel: '%', rot: '°', lift: ' mm', links: '', linkSize: ' mm', linkThick: '%', pendantSize: ' cm' };

function editorFor(kind) { return $(kind === 'text' ? '#text-editor' : '#chain-editor'); }

function renderParts() {
  for (const kind of ['text', 'chain']) {
    const list = $('#' + kind + '-list');
    const mine = parts.filter((x) => x.kind === kind);
    list.innerHTML = mine.length
      ? mine.map((x) => `<li data-id="${x.id}" class="${selPart === x ? 'on' : ''}">${icon(kind === 'text' ? 'type' : 'link')}<span>${esc(kind === 'text' ? x.text || '(empty)' : x.links + ' links' + (x.pendant !== 'none' ? ' + ' + x.pendant : ''))}</span><small>${x.at ? 'on gun' : 'not placed'}</small></li>`).join('')
      : `<li class="empty">${kind === 'text' ? 'No text yet' : 'No chain yet'}</li>`;
    $$('li[data-id]', list).forEach((li) => (li.onclick = () => { selPart = parts.find((x) => x.id === +li.dataset.id); renderParts(); }));
    const ed = editorFor(kind);
    const on = selPart && selPart.kind === kind;
    ed.classList.toggle('hidden', !on);
    if (!on) continue;
    $$('[data-p]', ed).forEach((el) => { el.value = selPart[el.dataset.p]; if (el.type === 'range') fillRange(el); });
    $$('[data-p-seg]', ed).forEach((sg) => {
      $$('button', sg).forEach((b) => b.classList.toggle('on', b.dataset.v === selPart[sg.dataset.pSeg]));
      requestAnimationFrame(() => syncSeg(sg));
    });
    if (kind === 'chain') {
      $('.pend-logo', ed).classList.toggle('hidden', selPart.pendant !== 'logo');
      $('.pend-text', ed).classList.toggle('hidden', selPart.pendant !== 'text');
      $('.pend-any', ed).classList.toggle('hidden', selPart.pendant === 'none');
      requestAnimationFrame(() => $$('.pend-logo [data-p-seg]', ed).forEach(syncSeg));
    }
    syncPartLabels(ed);
  }
  refreshDirtyMarks();
}

function syncPartLabels(ed) {
  $$('[data-po]', ed).forEach((b) => { b.textContent = selPart[b.dataset.po] + (UNITS[b.dataset.po] || ''); });
}

function setPlacing(part) {
  placing = part;
  $('#place-hint').classList.toggle('hidden', !part);
  $('#viewport').classList.toggle('placing', !!part);
  if (part) {
    $('#place-hint span').textContent = part.kind === 'text' ? 'Click on the gun where the text goes' : 'Click on the gun where the chain hangs from';
    three.controls.autoRotate = false; $('#view-spin').classList.remove('on'); switchView('3d');
  }
}

function placePartAt(hit) {
  if (!placing) return;
  const mesh = hit.object;
  const local = mesh.worldToLocal(hit.point.clone());
  const n = hit.face ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
  placing.at = { mesh: three.meshes.indexOf(mesh), point: local.toArray(), normal: n.toArray(), uv: hit.uv ? [hit.uv.x, hit.uv.y] : [0.5, 0.5] };
  const p = placing;
  setPlacing(null);
  rebuildParts();
  renderParts();
  notify.success(p.kind === 'text' ? 'Text added' : 'Chain added', 'It is part of the gun\'s model now.');
}

function addPart(kind) {
  if (!uniqueMeshes().length) return notify.info('No 3D model in this file', 'Open the weapon\'s .rpf or .ydr to add 3D parts.');
  const p = { id: partSeq++, kind, ...(kind === 'text' ? TEXT_DEFAULT : CHAIN_DEFAULT), at: null };
  parts.push(p);
  selPart = p;
  renderParts();
  setPlacing(p);
}

function clearParts() {
  for (const p of parts) disposePart(p);
  parts = []; selPart = null; placing = null;
  if (three.meshes) three.meshes.forEach((m) => m.children.slice().forEach((c) => m.remove(c)));
  textures.forEach((t) => { t.patches = []; });
}

function disposePart(p) {
  if (p.obj) { p.obj.parent && p.obj.parent.remove(p.obj); p.obj.geometry.dispose(); p.obj.material.dispose(); p.obj = null; }
  p.baked = null;
}

// Texture of the gun part a 3D part sits on, plus its normal / specular maps (by name).
function texturesFor(texIdx) {
  const t = textures[texIdx];
  if (!t || !t.editable) return null;
  const base = t.name.toLowerCase();
  const find = (suffixes) => textures.find((x) => x.editable && suffixes.some((s) => x.name.toLowerCase() === base + s));
  return { t, n: find(['_n', '_nm', '_normal']), s: find(['_s', '_spec']) };
}

function coverageFor(texIdx) {
  const t = textures[texIdx];
  if (!t.cov) {
    const meshes = three.meshes.filter((m) => m.userData.texIdx === texIdx && m.userData.src).map((m) => m.userData.src);
    t.cov = GP.coverage(t.w, t.h, meshes);
  }
  return { W: t.cov.W, H: t.cov.H, used: new Uint8Array(t.cov.used) };
}

const rebuildSoon = debounce(() => rebuildParts(), 60);

/** Lay out the colour patches and rebuild every placed part's mesh. */
function rebuildParts() {
  const touched = new Set();
  textures.forEach((t) => { if (t.patches.length) touched.add(t); t.patches = []; });
  const alloc = new Map(); // texIdx -> { cov, keys: Map(key -> rect) }
  let missing = false;
  for (const p of parts) {
    if (!p.at) continue;
    const mesh = three.meshes[p.at.mesh];
    if (!mesh) continue;
    const texIdx = mesh.userData.texIdx;
    const maps = texIdx !== undefined ? texturesFor(texIdx) : null;
    let A = null;
    if (maps) {
      if (!alloc.has(texIdx)) alloc.set(texIdx, { cov: coverageFor(texIdx), keys: new Map() });
      A = alloc.get(texIdx);
    }
    const fin = GP.FINISH[p.finish] || GP.FINISH.metal;
    const patch = (key, size, paint) => {
      if (!A) return null;
      if (!A.keys.has(key)) {
        let r = null;
        for (let s = size; !r && s >= 2; s >>= 1) r = GP.takeSquare(A.cov, Math.min(s, A.cov.W, A.cov.H));
        A.keys.set(key, r);
        if (r) {
          maps.t.patches.push({ ...r, ...paint });
          const scaled = (tx) => ({ x: Math.round(r.x * tx.w / maps.t.w), y: Math.round(r.y * tx.h / maps.t.h), w: Math.max(1, Math.round(r.w * tx.w / maps.t.w)), h: Math.max(1, Math.round(r.h * tx.h / maps.t.h)) });
          if (maps.n) maps.n.patches.push({ ...scaled(maps.n), colour: '#8080ff' });
          if (maps.s) maps.s.patches.push({ ...scaled(maps.s), colour: fin.spec });
        } else missing = true;
      }
      const r = A.keys.get(key);
      if (!r) return null;
      const t = maps.t, inset = Math.min(2, r.w / 8);
      return { u0: (r.x + inset) / t.w, v0: (r.y + inset) / t.h, u1: (r.x + r.w - inset) / t.w, v1: (r.y + r.h - inset) / t.h };
    };
    const colourPatch = (hex) => patch('c' + hex + p.finish, 8, { colour: hex });
    let geo, matrix;
    const font = fontReady(p.font);
    const needsFont = p.kind === 'text' || p.pendant === 'text';
    if (needsFont && !font) {
      loadFont(p.font).then(() => rebuildParts()).catch((e) => notify.error('Font not loaded', e.message));
      continue;
    }
    try {
      if (p.kind === 'text') {
        geo = GP.textGeometry(p, font);
        const n = new THREE.Vector3(...p.at.normal);
        const pos = new THREE.Vector3(...p.at.point).add(n.clone().multiplyScalar(p.lift / 1000 - 0.0002));
        matrix = GP.surfaceBasis(p.at.normal, p.rot).setPosition(pos);
      } else {
        geo = GP.chainGeometry(p, font);
        matrix = GP.chainPlacement(p.at.point, p.at.normal);
      }
    } catch (e) { notify.error('Could not build this part', e.message); continue; }
    const roles = {
      0: () => colourPatch(p.front), 1: () => colourPatch(p.side), 2: () => colourPatch(p.colour), 3: () => colourPatch(p.rim),
      4: () => (p.logo ? patch('logo' + p.id, 32, { image: p.logo.img, fill: p.rim }) : colourPatch(p.rim)),
    };
    const cache = {};
    const baked = GP.bake(geo, matrix, (role) => (role in cache ? cache[role] : (cache[role] = roles[role]())), p.at.uv);
    geo.dispose();
    if (p.obj) { p.obj.parent && p.obj.parent.remove(p.obj); p.obj.geometry.dispose(); }
    const t = maps ? maps.t : null;
    if (!p.obj) p.obj = new THREE.Mesh(baked, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    p.obj.geometry = baked;
    // the preview room is dark, so full metal would look black: tone it down a little
    Object.assign(p.obj.material, { map: t ? t.tex : null, color: new THREE.Color(t ? 0xffffff : p.kind === 'text' ? p.front : p.colour), metalness: fin.metalness * 0.55, roughness: Math.max(0.25, fin.roughness) });
    p.obj.material.needsUpdate = true;
    mesh.add(p.obj);
    p.baked = baked;
    if (t) touched.add(t);
    if (maps && maps.n) touched.add(maps.n);
    if (maps && maps.s) touched.add(maps.s);
  }
  for (const t of touched) { if (t.editable && t.preview) compose(t); }
  if (missing && !rebuildParts.warned) { rebuildParts.warned = true; notify.warning('Not much room on this texture', 'Some parts use the gun\'s own colours.'); }
  paintTexView();
  requestFrame();
  idleRefresh();
}

/** For each drawable in the file: the geometry each part goes into, with the part's data. */
function partExports() {
  const out = [];
  for (const p of parts) {
    if (!p.at || !p.baked) continue;
    const src = three.meshes[p.at.mesh] && three.meshes[p.at.mesh].userData.src;
    if (!src) continue;
    const point = p.at.point;
    const g = p.baked;
    const data = {
      positions: g.attributes.position.array, normals: g.attributes.normal.array, uvs: g.attributes.uv.array,
      indices: Uint32Array.from(g.index.array),
    };
    for (const a of pack.assets) {
      if (a.ext !== '.ydr' || !a.meshes || !a.meshes.length) continue;
      // the same model part in this file (the _hi copy has the same bones and textures)
      let target = a.meshes.includes(src) ? src : null;
      if (!target) {
        const same = a.meshes.filter((m) => m.binding === src.binding && String(m.textures) === String(src.textures));
        let best = Infinity;
        for (const m of same) { const d = nearest(m.positions, point).d; if (d < best) { best = d; target = m; } }
        if (target && best > 0.05) target = null; // nothing of that part near the spot
      }
      if (!target) continue;
      out.push({ assetId: a.id, lod: target.lod, model: target.model, geometry: target.geometry, template: nearest(target.positions, point).i, ...data });
    }
  }
  return out;
}

function nearest(pos, p) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const d = (pos[i] - p[0]) ** 2 + (pos[i + 1] - p[1]) ** 2 + (pos[i + 2] - p[2]) ** 2;
    if (d < best) { best = d; bi = i / 3; }
  }
  return { i: bi, d: Math.sqrt(best) };
}

function initParts() {
  $('#text-add').onclick = () => addPart('text');
  $('#chain-add').onclick = () => addPart('chain');
  for (const kind of ['text', 'chain']) {
    const ed = editorFor(kind);
    $$('[data-p]', ed).forEach((el) => el.addEventListener('input', () => {
      if (!selPart) return;
      selPart[el.dataset.p] = el.type === 'range' ? +el.value : el.value;
      syncPartLabels(ed);
      if (el.dataset.p === 'text' || el.dataset.p === 'pendantText') {
        const li = $(`#${kind}-list li[data-id="${selPart.id}"] span`);
        if (li && kind === 'text') li.textContent = selPart.text || '(empty)';
      }
      rebuildSoon();
    }));
    $$('[data-p-seg]', ed).forEach((sg) => $$('button', sg).forEach((b) => (b.onclick = () => {
      if (!selPart) return;
      selPart[sg.dataset.pSeg] = b.dataset.v;
      renderParts();
      rebuildParts();
    })));
    $('[data-act=place]', ed).onclick = () => { if (selPart) setPlacing(placing ? null : selPart); };
    $('[data-act=delete]', ed).onclick = () => {
      if (!selPart) return;
      disposePart(selPart);
      parts = parts.filter((x) => x !== selPart);
      selPart = parts.filter((x) => x.kind === kind).pop() || null;
      if (placing && !parts.includes(placing)) setPlacing(null);
      rebuildParts();
      renderParts();
    };
  }
  $('#text-editor [data-act=font]').onclick = async () => {
    const f = await api.call('gun:pickFont').catch((e) => { notify.error('Could not load font', e.message); return null; });
    if (!f || !selPart) return;
    try { addFont(f.name, f.data); } catch (e) { return notify.error('Could not read that font', 'Pick a .ttf or .otf file.'); }
    const sel = $('#text-editor [data-p=font]');
    if (![...sel.options].some((o) => o.value === f.name)) sel.add(new Option(f.name, f.name));
    selPart.font = f.name;
    renderParts();
    rebuildParts();
  };
  $('#chain-editor [data-act=logo]').onclick = async () => {
    const r = await api.call('gfx:pickImage').catch((e) => { notify.error('Could not open image', e.message); return null; });
    if (!r || !selPart) return;
    const img = new Image();
    img.src = 'data:' + r.mediaType + ';base64,' + r.data;
    await img.decode().catch(() => null);
    selPart.logo = { name: r.name, img };
    selPart.pendant = 'logo';
    renderParts();
    rebuildParts();
  };
  renderParts();
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
  clearParts();
  $('#gun-empty').classList.add('hidden');
  $('#gun-lab').classList.remove('hidden');
  pack.assets.forEach((a) => (a.meshes || []).forEach((m) => { m.assetId = a.id; }));
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
  clearParts();
  disposeTextures();
  pack = null;
  textures = [];
  if (three.group) three.group.clear();
  three.meshes = [];
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
  const geometry = partExports();
  if (parts.some((x) => x.at) && !geometry.length) return notify.error('Could not add the 3D parts', 'No model part in this file matches where they were placed.');
  if (!dirty.length && !geometry.length) return notify.info('Nothing to export yet', 'Change a colour or add text or a chain first.');
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
    const r = await api.call('gun:export', edits, opts, geometry);
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

// Dev-only timing probe (used by the KT_SHOT harness): ms per colour-slider
// frame, including the GPU texture upload.
export function perfProbe() {
  const t = textures[selected];
  if (!t || !t.editable) return null;
  const frame = () => three.renderer.render(three.scene, three.camera);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) { t.fx.hue = i * 5; regrade(t); compose(t); paintTexView(); frame(); }
  const grade = (performance.now() - t0) / 20;
  return { texture: t.w + 'x' + t.h, gradeMs: +grade.toFixed(2) };
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

  initParts();

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

  addEventListener('keydown', (e) => { if (e.key === 'Escape' && placing) setPlacing(null); });
}
