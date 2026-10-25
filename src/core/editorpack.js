'use strict';
// Advanced editor: the timecycle files of any graphics pack, without installing it.
// A pack can be one you installed (the app's library copy), or a folder, .zip or
// .rpf anywhere on disk (Downloads...). Saving writes the edit back into that pack
// (the first save keeps a .bak of a zip / rpf / file), so it can be installed later.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');

const TC_SNIFF = /_col_r>|<cycle\s+name=|<region\s+name=|timecycle_keyframe_data/i;
const MAX_FILE = 16 * 1048576;
const MAX_RPF = 1024 * 1048576;

const isTimecycle = (rel, head) => /\.xml$/i.test(rel) && (/(^|\/)timecycle\//i.test(rel) || TC_SNIFF.test(head));
const sortFiles = (list) => list.sort((a, b) => (/^w_/i.test(b.name) - /^w_/i.test(a.name)) || a.name.localeCompare(b.name));

function walkDir(dir, base = dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walkDir(abs, base, out);
    else out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), size: st.size });
  }
  return out;
}

function headOf(abs) {
  const fd = fs.openSync(abs, 'r');
  try { const b = Buffer.alloc(8192); return b.subarray(0, fs.readSync(fd, b, 0, 8192, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
}

class EditorPack {
  /** files: [{ rel, name, read(), write(text) }] */
  constructor(name, files, { afterSave = null, where = '' } = {}) {
    this.name = name;
    this.files = sortFiles(files);
    this.afterSave = afterSave;
    this.where = where;
  }

  list() { return this.files.map((f) => ({ rel: f.rel, name: f.name })); }

  file(rel) {
    const f = this.files.find((x) => x.rel === rel);
    if (!f) throw new Error('Not in this pack: ' + rel);
    return f;
  }

  read(rel) { return this.file(rel).read(); }

  save(rel, xml) {
    if (typeof xml !== 'string' || !/<[a-z_]/i.test(xml)) throw new Error('That does not look like timecycle XML.');
    this.file(rel).write(xml);
    if (this.afterSave) this.afterSave(rel, xml);
    return this.where;
  }

  /** A folder on disk (also the library copy of an installed pack). */
  static fromFolder(dir, name, opts = {}) {
    const files = walkDir(dir)
      .filter((f) => f.size <= MAX_FILE && isTimecycle(f.rel, /\.xml$/i.test(f.rel) ? headOf(f.abs) : ''))
      .map((f) => ({
        rel: f.rel, name: path.basename(f.rel),
        read: () => fs.readFileSync(f.abs, 'utf8'),
        write: (xml) => {
          if (opts.backup !== false && !fs.existsSync(f.abs + '.bak')) fs.copyFileSync(f.abs, f.abs + '.bak');
          fs.writeFileSync(f.abs, xml);
        },
      }));
    return new EditorPack(name, files, { ...opts, where: opts.where || dir });
  }

  static fromZip(file) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(file);
    const files = zip.getEntries()
      .filter((e) => !e.isDirectory && e.header.size <= MAX_FILE && /\.xml$/i.test(e.entryName))
      .filter((e) => isTimecycle(e.entryName, e.getData().subarray(0, 8192).toString('utf8')))
      .map((e) => ({
        rel: e.entryName, name: path.basename(e.entryName),
        read: () => zip.getEntry(e.entryName).getData().toString('utf8'),
        write: (xml) => {
          if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
          zip.updateFile(e.entryName, Buffer.from(xml, 'utf8'));
          zip.writeZip(file);
        },
      }));
    return new EditorPack(path.basename(file).replace(/\.zip$/i, ''), files, { where: file });
  }

  /** An .rpf (timecycles at any depth, nested archives included). */
  static fromRpf(file) {
    if (fs.statSync(file).size > MAX_RPF) throw new Error(path.basename(file) + ' is too big to open here.');
    const root = rpf.readRpf(fs.readFileSync(file), path.basename(file));
    const files = [];
    const scan = (node, prefix, chain) => {
      rpf.walk(node, (e, p) => {
        const full = prefix ? prefix + '/' + p : p;
        if (e.type !== 'bin') return;
        if (/\.rpf$/i.test(e.name)) {
          try { e.nested = e.nested || rpf.readRpf(rpf.getBinaryData(e), e.name); scan(e.nested, full, [...chain, e]); } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; }
          return;
        }
        if (!/\.xml$/i.test(e.name) || e.size > MAX_FILE) return;
        const data = rpf.getBinaryData(e);
        if (!isTimecycle(full, data.subarray(0, 8192).toString('utf8'))) return;
        files.push({
          rel: full, name: e.name,
          read: () => rpf.getBinaryData(e).toString('utf8'),
          write: (xml) => {
            rpf.setBinaryData(e, Buffer.from(xml, 'utf8'), false);
            // nested archives are rebuilt from the inside out
            for (let i = chain.length - 1; i >= 0; i--) rpf.setBinaryData(chain[i], rpf.writeRpf(chain[i].nested), false);
            if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
            fs.writeFileSync(file, rpf.writeRpf(root));
          },
        });
      });
    };
    scan(root, '', []);
    return new EditorPack(path.basename(file).replace(/\.rpf$/i, ''), files, { where: file });
  }

  /** A folder, .zip or .rpf the player picked. */
  static open(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) return EditorPack.fromFolder(p, path.basename(p));
    if (/\.zip$/i.test(p)) return EditorPack.fromZip(p);
    if (/\.rpf$/i.test(p)) return EditorPack.fromRpf(p);
    if (/\.xml$/i.test(p)) return EditorPack.fromFolder(path.dirname(p), path.basename(path.dirname(p)));
    throw new Error('Pick a pack folder, .zip or .rpf.');
  }

  /** A pack installed in the app. Saving also updates the game when the pack is on. */
  static installed(mgr, id) {
    const def = mgr.listTweaks().find((t) => t.id === id);
    if (!def) throw new Error('Pack not found.');
    const lib = mgr.libraryDir(id);
    if (!fs.existsSync(lib)) throw new Error(def.name + ' has no files.');
    return EditorPack.fromFolder(lib, def.name, {
      backup: false,
      where: def.name,
      afterSave: (rel, xml) => {
        if (mgr.state.owners[rel] === id) { mgr.writeFile(rel, xml, id); mgr.save(); }
      },
    });
  }
}

module.exports = { EditorPack };
