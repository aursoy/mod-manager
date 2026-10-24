'use strict';
// Gun pack session: open an .rpf (or loose .ytd/.ydr), list textures and
// meshes, patch edited texture bytes back in, and write a new archive.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { decodeResource, encodeResource, ResView } = require('./rsc');
const { parseTextureDictionary } = require('./ytd');
const { parseDrawable } = require('./ydr');

class GunPack {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = path.extname(filePath).toLowerCase();
    this.assets = []; // { id, path, ext, entry|null, res, textures, meshes }
    this.root = null;
    this.looseStored = null;
    this.load();
  }

  load() {
    const buf = fs.readFileSync(this.filePath);
    if (this.kind === '.rpf') {
      this.root = rpf.readRpf(buf, path.basename(this.filePath));
      this.scanArchive(this.root, '');
    } else if (this.kind === '.ytd' || this.kind === '.ydr') {
      this.looseStored = buf;
      this.addAsset(path.basename(this.filePath), this.kind, null, buf);
    } else {
      throw new Error('Drop a .rpf, .ytd or .ydr file.');
    }
    if (!this.assets.length) throw new Error('No .ytd or .ydr files found inside this archive.');
  }

  scanArchive(root, prefix) {
    rpf.walk(root, (entry, p) => {
      const full = prefix ? prefix + '/' + p : p;
      const ext = path.extname(entry.name).toLowerCase();
      if (entry.type === 'bin' && ext === '.rpf') {
        try {
          entry.nested = rpf.readRpf(rpf.getBinaryData(entry), entry.name);
          this.scanArchive(entry.nested, full);
        } catch (e) { if (e.code === rpf.NEED_KEYS) throw e; /* unreadable nested archive, skip */ }
        return;
      }
      if ((ext === '.ytd' || ext === '.ydr') && entry.type === 'res') {
        this.addAsset(full, ext, entry, entry.stored, entry.sysFlags, entry.gfxFlags);
      }
    });
  }

  addAsset(p, ext, entry, stored, sysFlags, gfxFlags) {
    let res;
    try { res = decodeResource(stored, sysFlags, gfxFlags); } catch (e) { return; }
    const v = new ResView(res);
    const asset = { id: this.assets.length, path: p, ext, entry, res, textures: [], meshes: [], warnings: [] };
    try {
      if (ext === '.ytd') {
        asset.textures = parseTextureDictionary(v, 0);
      } else {
        const d = parseDrawable(v, 0);
        asset.meshes = d.meshes;
        asset.textures = d.embeddedTextures;
        asset.warnings = d.warnings;
      }
    } catch (e) {
      asset.warnings.push(e.message);
    }
    this.assets.push(asset);
  }

  /** Serializable summary + raw texture bytes for the renderer. */
  describe() {
    return {
      file: path.basename(this.filePath),
      kind: this.kind,
      assets: this.assets.map((a) => ({
        id: a.id,
        path: a.path,
        ext: a.ext,
        warnings: a.warnings,
        textures: a.textures.map((t, i) => ({
          index: i,
          name: t.name,
          width: t.width,
          height: t.height,
          levels: t.levels,
          format: t.format,
          editable: t.editable,
          data: new Uint8Array(a.res.data.subarray(t.dataOffset, t.dataOffset + t.dataSize)),
        })),
        meshes: a.meshes,
      })),
    };
  }

  /** edits: [{ assetId, textureIndex, data:Uint8Array }] */
  applyEdits(edits) {
    const touched = new Set();
    for (const ed of edits) {
      const a = this.assets[ed.assetId];
      if (!a) throw new Error('Unknown asset ' + ed.assetId);
      const t = a.textures[ed.textureIndex];
      if (!t) throw new Error('Unknown texture ' + ed.textureIndex);
      if (ed.data.length !== t.dataSize) {
        throw new Error('Encoded size mismatch for ' + t.name + ' (' + ed.data.length + ' vs ' + t.dataSize + ')');
      }
      Buffer.from(ed.data.buffer, ed.data.byteOffset, ed.data.byteLength).copy(a.res.data, t.dataOffset);
      touched.add(a);
    }
    for (const a of touched) {
      const stored = encodeResource(a.res);
      if (a.entry) a.entry.stored = stored;
      else this.looseStored = stored;
    }
    // Nested archives must be re-serialized bottom-up.
    if (this.root) this.rebuildNested(this.root);
  }

  rebuildNested(root) {
    rpf.walk(root, (entry) => {
      if (entry.nested) {
        this.rebuildNested(entry.nested);
        rpf.setBinaryData(entry, rpf.writeRpf(entry.nested), false);
      }
    });
  }

  write(outPath) {
    const out = this.root ? rpf.writeRpf(this.root) : this.looseStored;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out);
    return out.length;
  }
}

module.exports = { GunPack };
