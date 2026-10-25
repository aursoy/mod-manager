'use strict';
// World options inside packs in FiveM.app/mods. A graphics pack installed there as an
// .rpf carries its own weather.xml / timecycles / visualsettings.dat / clouds.xml, and
// FiveM can load those instead of the copies in citizen, so an option (snow, stars,
// black mountains...) is also written into the pack's own copy. The untouched archive
// is kept and put back when the options are off; a pack the player replaced since is
// taken as the new original.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { findInFile } = require('./rpfscan');

const MAX_RPF = 2000 * 1048576;

function sidecar(dir) { return path.join(dir, 'mods-sync.json'); }
function loadState(dir) { try { return JSON.parse(fs.readFileSync(sidecar(dir), 'utf8')); } catch (e) { return {}; } }
function saveState(dir, st) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(sidecar(dir), JSON.stringify(st, null, 1)); }

const stamp = (file) => { const s = fs.statSync(file); return s.size + ':' + Math.round(s.mtimeMs); };

function writeOrExplain(file, bytes) {
  try { fs.writeFileSync(file, bytes); } catch (e) {
    if (/EBUSY|EPERM|EACCES/.test(e.code || '')) throw new Error(path.basename(file) + ' is in use. Close FiveM and try again.');
    throw e;
  }
}

/** The archive with every matching file run through the transforms; null when nothing changed. */
function transformRpf(buf, label, transforms) {
  const root = rpf.readRpf(buf, label);
  let changed = false;
  const scan = (node) => {
    let here = false;
    rpf.walk(node, (e) => {
      if (e.type !== 'bin') return;
      if (/\.rpf$/i.test(e.name)) {
        try {
          e.nested = rpf.readRpf(rpf.getBinaryData(e), e.name);
          if (scan(e.nested)) { rpf.setBinaryData(e, rpf.writeRpf(e.nested), false); here = true; }
        } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; }
        return;
      }
      const ts = transforms.filter((t) => t.test(e.name));
      if (!ts.length || e.size > 32 * 1048576) return;
      const text = rpf.getBinaryData(e).toString('utf8');
      const out = ts.reduce((t, x) => x.apply(t), text);
      if (out !== text) { rpf.setBinaryData(e, Buffer.from(out, 'utf8'), e.compressed); here = true; }
    });
    return here;
  };
  changed = scan(root);
  return changed ? rpf.writeRpf(root) : null;
}

/**
 * Bring every .rpf in modsDir in line with the transforms ([{ test(name), apply(text) }];
 * empty = put everything back). Returns the names of archives that now carry the options.
 */
function syncMods(modsDir, dataDir, transforms) {
  const st = loadState(dataDir);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(modsDir).filter((n) => /\.rpf$/i.test(n)); } catch (e) { names = []; }
  const backupDir = path.join(dataDir, 'mods-backup');
  for (const n of names) {
    const file = path.join(modsDir, n);
    let rec = st[n];
    // replaced by the player since we wrote it: that is the new original
    if (rec && (!fs.existsSync(rec.backup) || stamp(file) !== rec.wrote)) { fs.rmSync(rec.backup, { force: true }); delete st[n]; rec = null; }
    const pristine = rec ? rec.backup : file;
    const restore = () => {
      if (!rec) return;
      writeOrExplain(file, fs.readFileSync(rec.backup));
      fs.rmSync(rec.backup, { force: true });
      delete st[n];
    };
    if (!transforms.length) { restore(); continue; }
    let bytes = null;
    try {
      if (fs.statSync(pristine).size > MAX_RPF) continue;
      if (!findInFile(pristine, (name) => transforms.some((t) => t.test(name))).length) { restore(); continue; }
      bytes = transformRpf(fs.readFileSync(pristine), n, transforms);
    } catch (e) {
      if (e.code === rpf.NEED_KEYS) throw e;
      continue; // not an archive we can read
    }
    if (!bytes) { restore(); continue; }
    if (!rec) {
      fs.mkdirSync(backupDir, { recursive: true });
      rec = { backup: path.join(backupDir, n) };
      fs.copyFileSync(file, rec.backup);
    }
    writeOrExplain(file, bytes);
    rec.wrote = stamp(file);
    st[n] = rec;
    out.push(n);
  }
  // an archive switched off on the Mods page (.rpf.off) keeps its record, so it is put back once it is on again
  saveState(dataDir, st);
  return out;
}

module.exports = { syncMods, transformRpf };
