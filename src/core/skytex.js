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
    return encodeResource(this.res);
  }
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

module.exports = { YtdFile, skydomeFromGame, DEFAULT_REL };
