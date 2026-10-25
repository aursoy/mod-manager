// Fonts for the Gun Lab's 3D text (letter outlines for TextGeometry): the real
// Windows font file (Impact, Arial Black, ...) read by the main process, a
// .ttf/.otf the player loads, or one of three.js's bundled fonts.
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';

const api = window.api;
const fonts = new Map(); // name -> THREE.Font | Promise | Error

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
