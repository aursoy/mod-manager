'use strict';
// Custom app background: a picture or a looping video chosen by the player,
// copied into the app's own data folder so it survives the original being moved.

const fs = require('fs');
const path = require('path');

const TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'], '.bmp': ['image', 'image/bmp'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'],
};
const MAX = 200 * 1048576;
const DEFAULTS = { file: null, kind: null, mime: null, dim: 0.55, blur: 0, name: '' };

class Appearance {
  /** mgr: CitizenManager (for its state.json), dir: the app's data folder */
  constructor(mgr, dir) { this.mgr = mgr; this.dir = dir; }

  get() { return { ...DEFAULTS, ...(this.mgr.state.appearance || {}) }; }

  /** Settings plus the file bytes, for the renderer to show. */
  load() {
    const a = this.get();
    if (!a.file || !fs.existsSync(a.file)) return { ...a, kind: null, data: null };
    return { ...a, data: new Uint8Array(fs.readFileSync(a.file)) };
  }

  setFile(src) {
    const t = TYPES[path.extname(src).toLowerCase()];
    if (!t) throw new Error('Pick a picture (PNG, JPG, WebP, GIF) or a video (MP4, WebM).');
    if (fs.statSync(src).size > MAX) throw new Error('Pick a file under 200 MB.');
    const old = this.get().file;
    const dest = path.join(this.dir, 'background' + path.extname(src).toLowerCase());
    fs.mkdirSync(this.dir, { recursive: true });
    if (old && old !== dest) fs.rmSync(old, { force: true });
    fs.copyFileSync(src, dest);
    return this.save({ file: dest, kind: t[0], mime: t[1], name: path.basename(src) });
  }

  set(patch) {
    const clean = {};
    if (patch.dim != null) clean.dim = Math.max(0, Math.min(0.95, +patch.dim || 0));
    if (patch.blur != null) clean.blur = Math.max(0, Math.min(30, +patch.blur || 0));
    return this.save(clean);
  }

  clear() {
    const a = this.get();
    if (a.file) fs.rmSync(a.file, { force: true });
    return this.save({ file: null, kind: null, mime: null, name: '' });
  }

  save(patch) {
    this.mgr.state.appearance = { ...this.get(), ...patch };
    this.mgr.save();
    return this.get();
  }
}

module.exports = { Appearance };
