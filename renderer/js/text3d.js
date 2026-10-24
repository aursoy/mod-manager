// Real 3D text for the Gun Lab. Each letter is a solid three.js mesh: extruded,
// bevelled, lit by a studio light and a reflection map, and tilted in 3D. The
// render (transparent background) is what gets stamped into the gun texture,
// because a GTA weapon in game is its .ydr model + this texture: the text has
// to live in the texture to show up on every server.
//
// Fonts: the real Windows font file (Impact, Arial Black, ...) read by the main
// process, a .ttf/.otf the player loads, or one of three.js's bundled fonts.
import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const api = window.api;
const MAX_PX = 2048;
export const FINISHES = {
  metal: { metalness: 0.85, roughness: 0.3, env: 'studio' },
  chrome: { metalness: 1, roughness: 0.05, env: 'studio' },
  gloss: { metalness: 0.1, roughness: 0.18, env: 'room' },
  matte: { metalness: 0, roughness: 0.85, env: 'room' },
};

const fonts = new Map(); // name -> THREE.Font | Promise | Error
const geos = new Map(); // geometry cache (text + font + shape settings)
let R = null;

function toFont(res) {
  if (res.type === 'json') return new FontLoader().parse(JSON.parse(res.text));
  const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
  const json = new TTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new FontLoader().parse(json);
}

/** Load a font by name (cached). Resolves to a THREE.Font. */
export function loadFont(name) {
  const have = fonts.get(name);
  if (have instanceof Promise) return have;
  if (have && !(have instanceof Error)) return Promise.resolve(have);
  const p = api.call('gun:font', name).then((res) => {
    let f;
    try { f = toFont(res); } catch (e) {
      // a font file opentype can't read: fall back to the bundled sans
      return api.call('gun:font', '').then((r2) => { const f2 = toFont(r2); fonts.set(name, f2); return f2; });
    }
    fonts.set(name, f);
    return f;
  }).catch((e) => { fonts.set(name, e); throw e; });
  fonts.set(name, p);
  return p;
}

/** A font the player picked from disk: { name, data }. */
export function addFont(name, data) {
  fonts.set(name, toFont({ type: 'ttf', data }));
}

export function fontReady(name) {
  const f = fonts.get(name);
  return f && !(f instanceof Promise) && !(f instanceof Error) ? f : null;
}

function rig() {
  if (R) return R;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envs = { room: pmrem.fromScene(new RoomEnvironment(), 0.04).texture, studio: pmrem.fromEquirectangular(studioSky()).texture };
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.35));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const front = new THREE.MeshStandardMaterial();
  const side = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(undefined, [front, side]);
  scene.add(mesh);
  R = { renderer, scene, camera, key, front, side, mesh, envs };
  return R;
}

/** A studio "sky" for metal and chrome to reflect: bright top and horizon, dark floor. */
function studioSky() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  [[0, '#f2f5f8'], [0.3, '#8d97a1'], [0.46, '#ffffff'], [0.54, '#ffffff'], [0.6, '#3b3e42'], [0.78, '#151617'], [1, '#050505']].forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function geometry(L, font) {
  const depth = Math.max(0.01, (L.depth3d ?? 30) / 100);
  const bevel = (L.bevel ?? 3) / 100;
  const k = [L.text, L.font, depth, bevel].join('\u0001');
  let g = geos.get(k);
  if (g) return g;
  g = new TextGeometry(L.text, {
    font, size: 1, height: depth, curveSegments: 8,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 4,
  });
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
  g.computeBoundingBox();
  if (geos.size > 40) { for (const old of geos.values()) old.dispose(); geos.clear(); }
  geos.set(k, g);
  return g;
}

/** Render a layer's 3D text at `px` pixels per em. Returns null until its font is loaded.
 *  { img, w, h, ox, oy }: (ox, oy) is where the text's centre is in the image. */
export function render3d(L, px) {
  const font = fontReady(L.font);
  if (!font || !L.text || !L.text.trim()) return null;
  const key = [L.text, L.font, L.depth3d, L.bevel, L.tiltX, L.tiltY, L.light, L.finish, L.fill, L.side, Math.round(px * 4) / 4].join('|');
  if (L._r3d && L._r3d.key === key) return L._r3d;
  const { renderer, scene, camera, key: light, front, side, mesh, envs } = rig();
  mesh.geometry = geometry(L, font);
  mesh.rotation.set(THREE.MathUtils.degToRad(L.tiltX || 0), THREE.MathUtils.degToRad(L.tiltY || 0), 0);
  mesh.updateMatrixWorld(true);
  const fin = FINISHES[L.finish] || FINISHES.metal;
  scene.environment = envs[fin.env];
  front.color.set(L.fill); Object.assign(front, { metalness: fin.metalness, roughness: fin.roughness });
  side.color.set(L.side); Object.assign(side, { metalness: fin.metalness, roughness: Math.min(1, fin.roughness + 0.12) });
  const a = THREE.MathUtils.degToRad(L.light ?? -35);
  light.position.set(Math.sin(a) * 3, Math.cos(a) * 3, 4);

  const box = new THREE.Box3().setFromObject(mesh);
  const pad = 0.04;
  let w = (box.max.x - box.min.x + pad * 2) * px, h = (box.max.y - box.min.y + pad * 2) * px;
  const fit = Math.min(1, MAX_PX / Math.max(w, h));
  w = Math.max(1, Math.round(w * fit)); h = Math.max(1, Math.round(h * fit));
  Object.assign(camera, { left: box.min.x - pad, right: box.max.x + pad, top: box.max.y + pad, bottom: box.min.y - pad, near: 0.01, far: box.max.z - box.min.z + 20 });
  camera.position.set(0, 0, box.max.z + 10);
  camera.lookAt(0, 0, box.max.z);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  renderer.render(scene, camera);

  const img = document.createElement('canvas');
  img.width = w; img.height = h;
  img.getContext('2d').drawImage(renderer.domElement, 0, 0);
  const s = w / ((box.max.x - box.min.x + pad * 2) * px); // fit, as applied
  L._r3d = { key, img, w: w / s, h: h / s, ox: (-(box.min.x - pad)) * px, oy: (box.max.y + pad) * px, sil: null };
  return L._r3d;
}

/** The render filled with one colour (for the outline). */
export function silhouette(r, colour) {
  if (r.sil && r.sil.colour === colour) return r.sil.img;
  const c = document.createElement('canvas');
  c.width = r.img.width; c.height = r.img.height;
  const g = c.getContext('2d');
  g.drawImage(r.img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  r.sil = { colour, img: c };
  return c;
}
