'use strict';
// The sky texture. GTA V paints the daytime sky from timecycle colours, but the
// night sky is a picture: the "starfield" texture inside skydome.ytd (sky mods
// replace exactly this). This module opens a skydome.ytd, lists its textures and
// writes a replacement texture back in its original format and size.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { decodeResource, encodeResource, ResView } = require('./rsc');
const { parseTextureDictionary } = require('./ytd');

/** Where the file goes in a pack when it did not come from one. */
const DEFAULT_REL = 'platform/textures/skydome.ytd';

class YtdFile {
  /** stored: the .ytd file bytes (RSC7 header + data). */
  constructor(stored, label = 'skydome.ytd') {
    this.label = label;
    this.res = decodeResource(stored);
    this.textures = parseTextureDictionary(new ResView(this.res), 0);
    if (!this.textures.length) throw new Error(label + ' has no textures this app can read.');
  }

  /** The texture that is the sky picture: "starfield" in the stock file, else the biggest editable one. */
  skyIndex() {
    const star = this.textures.findIndex((t) => /star/i.test(t.name));
    if (star >= 0) return star;
    let best = -1;
    this.textures.forEach((t, i) => {
      if (t.editable && (best < 0 || t.width * t.height > this.textures[best].width * this.textures[best].height)) best = i;
    });
    return best >= 0 ? best : 0;
  }

  describe(withData = false) {
    return this.textures.map((t, i) => ({
      index: i, name: t.name, width: t.width, height: t.height, levels: t.levels, format: t.format, editable: t.editable,
      ...(withData ? { data: new Uint8Array(this.res.data.subarray(t.dataOffset, t.dataOffset + t.dataSize)) } : {}),
    }));
  }

  /** Patch one texture (all mip levels, already encoded) and return the new .ytd bytes. */
  replace(index, data) {
    const t = this.textures[index];
    if (!t) throw new Error('Unknown texture ' + index);
    if (!t.editable) throw new Error(t.name + ' is ' + t.format + ', which this app cannot write.');
    if (data.length !== t.dataSize) throw new Error('Encoded size mismatch for ' + t.name + ' (' + data.length + ' vs ' + t.dataSize + ')');
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(this.res.data, t.dataOffset);
    this.last = encodeResource(this.res);
    return this.last;
  }

  ytdBytes() { return this.last || null; }
}

/** A sky inside an RPF, the way graphics packs ship it for FiveM.app/mods.
 *  Finds skydome.ytd at any depth (RPFs inside RPFs too), and writes the whole
 *  archive back with only that texture changed. */
class RpfSky {
  constructor(buf, label = 'pack.rpf') {
    this.label = label;
    this.root = rpf.readRpf(buf, label);
    this.hit = findSkydome(this.root);
    if (!this.hit) throw new Error(label + ' has no skydome.ytd inside.');
    this.path = this.hit.path;
    this.ytd = new YtdFile(this.hit.entry.stored, this.hit.entry.name);
    this.textures = this.ytd.textures;
  }

  skyIndex() { return this.ytd.skyIndex(); }
  describe(withData) { return this.ytd.describe(withData); }

  replace(index, data) {
    this.hit.entry.stored = this.ytd.replace(index, data);
    rebuildNested(this.root);
    return rpf.writeRpf(this.root);
  }

  /** The edited skydome.ytd on its own (for citizen/platform/textures). */
  ytdBytes() { return Buffer.from(this.hit.entry.stored); }
}

function findSkydome(root, prefix = '') {
  let hit = null;
  rpf.walk(root, (e, p) => {
    if (hit) return;
    const full = prefix ? prefix + '/' + p : p;
    const lower = e.name.toLowerCase();
    if (e.type === 'res' && lower === 'skydome.ytd') { hit = { entry: e, path: full }; return; }
    if (e.type === 'bin' && lower.endsWith('.rpf')) {
      try {
        e.nested = e.nested || rpf.readRpf(rpf.getBinaryData(e), e.name);
        hit = findSkydome(e.nested, full);
      } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; /* unreadable inner archive */ }
    }
  });
  return hit;
}

function rebuildNested(root) {
  rpf.walk(root, (e) => {
    if (!e.nested) return;
    rebuildNested(e.nested);
    rpf.setBinaryData(e, rpf.writeRpf(e.nested), false);
  });
}

/** Does this RPF have a sky in it? Cheap check that stops at the first hit. */
function rpfHasSky(buf, label) {
  try { return !!findSkydome(rpf.readRpf(buf, label)); } catch (e) { if (e.code === rpf.NEED_KEYS) throw e; return false; }
}

/** Pull skydome.ytd out of the game's x64a.rpf (the stock sky). Needs the keys
 *  for encrypted archives, like every other RPF read in this app. */
function skydomeFromGame(gtaDir) {
  const file = path.join(gtaDir, 'x64a.rpf');
  if (!fs.existsSync(file)) throw new Error('x64a.rpf was not found in ' + gtaDir);
  const root = rpf.readRpf(fs.readFileSync(file), 'x64a.rpf');
  let hit = null;
  rpf.walk(root, (e, p) => { if (!hit && e.type === 'res' && e.name.toLowerCase() === 'skydome.ytd') hit = { entry: e, path: p }; });
  if (!hit) throw new Error('skydome.ytd is not inside x64a.rpf on this install.');
  return { stored: Buffer.from(hit.entry.stored), path: 'x64a.rpf/' + hit.path };
}

/** GTA V folders that have x64a.rpf. FiveM writes the game path into
 *  FiveM.app/CitizenFX.ini (IVPath=...), so FiveM players are found without asking. */
function findGtaDirs({ citizenPath = null, knownExe = null, exes = [] } = {}) {
  const out = [];
  const add = (dir) => {
    if (!dir) return;
    const d = path.resolve(dir.trim().replace(/^"|"$/g, ''));
    if (!out.includes(d) && fs.existsSync(path.join(d, 'x64a.rpf'))) out.push(d);
  };
  if (citizenPath) {
    try {
      const ini = fs.readFileSync(path.join(path.dirname(citizenPath), 'CitizenFX.ini'), 'utf8');
      const m = /^\s*IVPath\s*=\s*(.+?)\s*$/im.exec(ini);
      if (m) add(m[1]);
    } catch (e) { /* no ini */ }
  }
  if (knownExe) add(path.dirname(knownExe));
  for (const exe of exes) add(path.dirname(exe));
  return out;
}

/** Every resource matching test(name) in an RPF tree, nested RPFs included. */
function findAll(root, test, prefix = '') {
  const out = [];
  rpf.walk(root, (e, p) => {
    const full = prefix ? prefix + '/' + p : p;
    if (e.type === 'res' && test(e.name)) out.push({ entry: e, path: full });
    if (e.type === 'bin' && /\.rpf$/i.test(e.name)) {
      try {
        e.nested = e.nested || rpf.readRpf(rpf.getBinaryData(e), e.name);
        out.push(...findAll(e.nested, test, full));
      } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; }
    }
  });
  return out;
}

/** Several texture dictionaries inside one RPF (e.g. all the cloud hats), edited in place. */
class RpfTextures {
  constructor(buf, label, test) {
    this.label = label;
    this.root = rpf.readRpf(buf, label);
    this.hits = findAll(this.root, test);
    if (!this.hits.length) throw new Error(label + ' has none of those textures.');
    this.ytds = this.hits.map((h) => new YtdFile(h.entry.stored, h.entry.name));
    this.edited = false;
  }

  replace(i, texIndex, data) {
    this.hits[i].entry.stored = this.ytds[i].replace(texIndex, data);
    this.edited = true;
  }

  bytes() {
    rebuildNested(this.root);
    return rpf.writeRpf(this.root);
  }
}

module.exports = { YtdFile, RpfSky, RpfTextures, findAll, rpfHasSky, skydomeFromGame, findGtaDirs, DEFAULT_REL };
