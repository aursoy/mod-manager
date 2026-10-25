'use strict';
// Gun pack session: open an .rpf (or loose .ytd/.ydr), list textures and
// meshes, patch edited texture bytes back in, add 3D parts to the models, and
// write a new archive.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { setShine } = require('./shaderparams');
const { decodeResource, encodeResource, ResView } = require('./rsc');
const { parseTextureDictionary } = require('./ytd');
const { parseDrawable } = require('./ydr');
const { addGeometry } = require('./ydrwrite');

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
    const asset = { id: this.assets.length, path: p, ext, entry, res, stored, sysFlags, gfxFlags, textures: [], meshes: [], warnings: [] };
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

  /** edits: [{ assetId, textureIndex, data:Uint8Array }]
   *  geometry: [{ assetId, lod, model, geometry, template, positions, normals, uvs, indices }]
   *  Always starts from the file as it was opened, so exporting twice gives the same result. */
  /** opts.shine 0..1: how shiny / reflective every model gets (shader settings). */
  applyEdits(edits, geometry = [], opts = {}) {
    const shine = Math.max(0, Math.min(1, +opts.shine || 0));
    const models = this.assets.filter((a) => a.ext === '.ydr');
    // models shined last time are rebuilt from the original too, so lowering it works
    const touched = new Set([...edits.map((e) => this.assets[e.assetId]), ...geometry.map((g) => this.assets[g.assetId]), ...(shine || this.shined ? models : [])].filter(Boolean));
    this.shined = shine > 0;
    for (const a of touched) {
      a.res = decodeResource(a.stored, a.sysFlags, a.gfxFlags);
      if (a.entry) { a.entry.stored = a.stored; a.entry.gfxFlags = a.gfxFlags; }
    }
    for (const ed of edits) {
      const a = this.assets[ed.assetId];
      if (!a) throw new Error('Unknown asset ' + ed.assetId);
      const t = a.textures[ed.textureIndex];
      if (!t) throw new Error('Unknown texture ' + ed.textureIndex);
      if (ed.data.length !== t.dataSize) {
        throw new Error('Encoded size mismatch for ' + t.name + ' (' + ed.data.length + ' vs ' + t.dataSize + ')');
      }
      Buffer.from(ed.data.buffer, ed.data.byteOffset, ed.data.byteLength).copy(a.res.data, t.dataOffset);
    }
    if (shine) for (const a of models) setShine(a.res, shine);
    // 3D parts last: adding geometry re-lays out the graphics pages (texture data moves)
    const byAsset = new Map();
    for (const g of geometry) {
      const a = this.assets[g.assetId];
      if (!a || a.ext !== '.ydr') throw new Error('3D parts can only go into a .ydr model.');
      if (!byAsset.has(a)) byAsset.set(a, []);
      byAsset.get(a).push({ ...g, positions: Float32Array.from(g.positions), normals: Float32Array.from(g.normals), uvs: Float32Array.from(g.uvs), indices: Uint32Array.from(g.indices) });
    }
    for (const [a, list] of byAsset) {
      addGeometry(a.res, list);
      if (a.entry) a.entry.gfxFlags = a.res.gfxFlags;
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
