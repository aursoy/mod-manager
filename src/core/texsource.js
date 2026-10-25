'use strict';
// Texture labs: finds a kind of texture dictionary wherever the player has it, opens it
// for painting, and hands back the files to install. Kinds:
//   clouds  cloudhat_*.ytd                         (Graphics → Clouds)
//   blood   fxdecal.ytd, peddamagedecals.ytd, ...  (Graphics → Blood FX)
// Sources (searched by contents, never by file name):
//   pack       loose in the pack dropped into the Pack AI
//   pack-rpf   inside one of that pack's RPFs        -> edited RPF goes to mods
//   mods       inside an RPF already in FiveM.app/mods -> edited RPF replaces it (backed up)
//   citizen    loose in citizen
//   game       GTA V's own copy                       -> new mods/kt_<kind>.rpf (+ loose copy for textures/)
//   files      the RPF the player picked (Blood FX: .ytd, or core.ypt particles): edited in place, installed into mods
//              under its own name (replacing it, backed up, when it is already there)

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { YtdFile, RpfTextures } = require('./skytex');
const { findInFile, extractFromFile } = require('./rpfscan');
const { readStaged } = require('./gfxpack');

const MAX_RPF = 2000 * 1048576;

// ---------- names ----------

const CLOUD_NAMES = { cirro: 'Cirrus', clear01: 'Clear', nimbus: 'Nimbus', wispy: 'Wispy', cloudy: 'Cloudy', horizon: 'Horizon', contrails: 'Contrails', puffs: 'Puffs', stripey: 'Stripey', stormy: 'Stormy', rain: 'Rain', snowy: 'Snowy', shower: 'Shower', altostratus: 'Altostratus', cirrocumulus: 'Cirrocumulus', stratoscumulus: 'Stratocumulus' };
function cloudName(file) {
  const n = path.basename(file, '.ytd').replace(/^cloudhat_?/i, '').replace(/[_-]+/g, ' ').trim();
  const key = n.toLowerCase().replace(/\s+/g, '');
  return CLOUD_NAMES[key] || (n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Cloud');
}

function bloodName(file) {
  const n = path.basename(file).replace(/\.(ytd|ypt|ydr)$/i, '').toLowerCase();
  if (n === 'fxdecal') return 'Blood splats & decals';
  if (n === 'peddamagedecals') return 'Blood on players';
  if (n === 'core') return 'Blood sprays (particles)';
  if (/blood/.test(n)) return 'Blood (' + n + ')';
  return n;
}

const KINDS = {
  clouds: { test: (n) => /^cloudhat.*\.ytd$/i.test(n), name: cloudName, out: '@mods/kt_clouds.rpf', gameFiles: ['x64b.rpf', 'update/update.rpf', 'x64a.rpf', 'x64c.rpf'], label: 'cloud hats' },
  blood: { test: (n) => /^(fxdecal|peddamagedecals|.*blood.*)\.ytd$/i.test(n), name: bloodName, out: '@mods/kt_bloodfx.rpf', loose: 'platform/textures/', gameFiles: ['x64a.rpf', 'update/update.rpf'], label: 'blood textures' },
};

async function withKeys(fn, unlock) {
  try { return fn(); } catch (e) {
    if (e.code !== rpf.NEED_KEYS || !unlock) throw e;
    await unlock();
    return fn();
  }
}

function modsDir(mgr) { return mgr.state.citizenPath ? path.join(path.dirname(mgr.state.citizenPath), 'mods') : null; }

/** Where this kind can be found right now. Only tables of contents are read. */
async function listSources(kind, ctx) {
  const K = KINDS[kind];
  const { pack, mgr } = ctx;
  const out = [];
  if (pack) {
    const loose = pack.staged.filter((s) => K.test(path.basename(s.rel)));
    if (loose.length) out.push({ id: 'pack', label: pack.info.name, count: loose.length });
    for (const s of pack.staged.filter((x) => /\.rpf$/i.test(x.rel))) {
      let n = 0;
      try {
        n = s.from ? (await withKeys(() => findInFile(s.from, K.test), ctx.unlock)).length
          : new RpfTextures(readStaged(s), path.basename(s.rel), K.test).hits.length;
      } catch (e) { /* not an archive with these */ }
      if (n) out.push({ id: 'pack-rpf:' + s.rel, label: pack.info.name + ' / ' + path.basename(s.rel), count: n });
    }
  }
  const dir = modsDir(mgr);
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => /\.rpf$/i.test(n))) {
      let n = 0;
      try { n = (await withKeys(() => findInFile(path.join(dir, name), K.test), ctx.unlock)).length; } catch (e) { /* unreadable */ }
      if (n) out.push({ id: 'mods:' + name, label: 'mods / ' + name, count: n });
    }
  }
  const cit = mgr.findAllInCitizen({ test: K.test });
  if (cit.length) out.push({ id: 'citizen', label: 'citizen', count: cit.length });
  const gta = K.gameFiles.length && ctx.gtaDirs()[0];
  if (gta) {
    for (const f of K.gameFiles) {
      const file = path.join(gta, ...f.split('/'));
      if (!fs.existsSync(file)) continue;
      let n = 0;
      try { n = (await withKeys(() => findInFile(file, K.test), ctx.unlock)).length; } catch (e) { /* skip */ }
      if (n) { out.push({ id: 'game:' + f, label: 'GTA V stock (' + f + ')', count: n }); break; }
    }
  }
  return out;
}

/** Loose .ytd files that each go back to their own place (rel = pack path, or citizen path). */
function looseSource(K, list, label) {
  const items = list.map((x, i) => ({ key: i, name: K.name(x.rel), file: path.basename(x.rel), path: x.rel, ytd: new YtdFile(x.bytes, path.basename(x.rel)), rel: x.rel, edited: false }));
  return {
    label, items,
    replace(key, ti, data) { items[key].ytd.replace(ti, data); items[key].edited = true; },
    outputs() { return Object.fromEntries(items.filter((x) => x.edited).map((x) => [x.rel, x.ytd.ytdBytes()])); },
  };
}

function rpfSource(K, buf, rel, label) {
  const t = new RpfTextures(buf, path.basename(rel), K.test);
  return {
    label,
    items: t.hits.map((h, i) => ({ key: i, name: K.name(h.path), file: h.entry.name, path: h.path, ytd: t.ytds[i] })),
    replace(key, ti, data) { t.replace(key, ti, data); },
    outputs() { return t.edited ? { [rel]: t.bytes() } : {}; },
  };
}

/** Copies (game files, picked files): edited ones go into a new RPF in mods, and loose where the kind has a known folder. */
function copySource(K, found, label) {
  const items = found.map((x, i) => ({ key: i, name: K.name(x.path || x.name), file: x.name, path: x.path || x.name, ytd: new YtdFile(x.stored, x.name), edited: false, from: x.from || null }));
  return {
    label, items,
    replace(key, ti, data) { items[key].ytd.replace(ti, data); items[key].edited = true; },
    outputs() {
      const edited = items.filter((x) => x.edited);
      if (!edited.length) return {};
      const children = edited.map((x) => {
        const stored = x.ytd.ytdBytes();
        return { type: 'res', name: x.file.toLowerCase(), stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) };
      });
      const out = { [K.out]: rpf.writeRpf({ type: 'dir', name: '', children }) };
      if (K.loose) for (const x of edited) out[K.loose + x.file.toLowerCase()] = x.ytd.ytdBytes();
      return out;
    },
    /** edited files as plain .ytd, for "save to folder" */
    files() { return items.filter((x) => x.edited).map((x) => ({ name: x.file, bytes: x.ytd.ytdBytes() })); },
  };
}

async function openSource(kind, id, ctx) {
  const K = KINDS[kind];
  const { pack, mgr } = ctx;
  if (id === 'pack') {
    return looseSource(K, pack.staged.filter((s) => K.test(path.basename(s.rel))).map((s) => ({ rel: s.rel, bytes: readStaged(s) })), pack.info.name);
  }
  if (id.startsWith('pack-rpf:')) {
    const rel = id.slice(9);
    const s = pack.staged.find((x) => x.rel === rel);
    if (s.from && fs.statSync(s.from).size > MAX_RPF) throw new Error(path.basename(rel) + ' is too big to edit here.');
    return withKeys(() => rpfSource(K, readStaged(s), rel, pack.info.name + ' / ' + path.basename(rel)), ctx.unlock);
  }
  if (id.startsWith('mods:')) {
    const name = id.slice(5);
    const file = path.join(modsDir(mgr), name);
    if (fs.statSync(file).size > MAX_RPF) throw new Error(name + ' is too big to edit here.');
    return withKeys(() => rpfSource(K, fs.readFileSync(file), '@mods/' + name, 'mods / ' + name), ctx.unlock);
  }
  if (id === 'citizen') {
    return looseSource(K, mgr.findAllInCitizen({ test: K.test }).map((rel) => ({ rel, bytes: fs.readFileSync(mgr.absFor(rel)) })), 'citizen');
  }
  if (id.startsWith('game:')) {
    const f = id.slice(5);
    const found = await withKeys(() => extractFromFile(path.join(ctx.gtaDirs()[0], ...f.split('/')), K.test), ctx.unlock);
    return copySource(K, found.map((x) => ({ ...x, path: f + '/' + x.path })), 'GTA V stock ' + K.label);
  }
  throw new Error('Unknown source');
}

/** Files, folders or RPFs the player picked. */
async function openFiles(kind, paths, ctx) {
  const K = KINDS[kind];
  if (paths.length === 1 && /\.rpf$/i.test(paths[0]) && fs.statSync(paths[0]).isFile()) return pickedRpf(K, paths[0], ctx);
  const found = [];
  const add = (file, rel) => {
    if (/\.ytd$/i.test(file)) found.push({ name: path.basename(file), path: rel, stored: fs.readFileSync(file), from: file });
    else if (/\.rpf$/i.test(file)) {
      return withKeys(() => extractFromFile(file, K.test), ctx.unlock).then((list) => { for (const x of list) found.push({ ...x, path: path.basename(file) + '/' + x.path }); });
    }
    return null;
  };
  const walk = async (p, rel) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) await walk(path.join(p, n), rel ? rel + '/' + n : n); }
    else await add(p, rel || path.basename(p));
  };
  for (const p of paths) await walk(p, '');
  if (!found.length) throw new Error('No .ytd textures found there.');
  if (found.length > 400) found.length = 400;
  return copySource(K, found, paths.length === 1 ? path.basename(paths[0]) : paths.length + ' files');
}

/** One RPF the player chose. GTA keeps blood in fxdecal.ytd / peddamagedecals.ytd and
 *  in the particle file core.ypt (blood sprays); blood mods ship any of those, at any depth.
 *  Blood-named files come first; else every texture file in the archive (the player said
 *  this is the one). In a particle file only the blood textures are shown, when it has any. */
const BLOOD_TEX = /blood|gore|splat|bld|wound|ped_?dam|gunshot|bullet|decal/i;
const ANY_TEX = (n) => /\.(ytd|ypt|ydr)$/i.test(n);

async function pickedRpf(K, file, ctx) {
  const name = path.basename(file);
  if (fs.statSync(file).size > MAX_RPF) throw new Error(name + ' is too big to edit here.');
  const buf = fs.readFileSync(file);
  return withKeys(() => {
    const root = rpf.readRpf(buf, name);
    let t = null;
    for (const test of [(n) => K.test(n) || /^core\.ypt$/i.test(n), ANY_TEX]) {
      try { t = new RpfTextures(null, name, test, root); break; } catch (e) { if (e.code === rpf.NEED_KEYS) throw e; }
    }
    if (!t) throw new Error(name + ' has no textures this app can read. Inside: ' + describeTree(root) + '.');
    const rel = '@mods/' + name;
    return {
      label: name,
      items: t.hits.map((h, i) => {
        const ytd = t.ytds[i];
        const blood = /\.ypt$/i.test(h.entry.name) ? ytd.textures.map((x, j) => (BLOOD_TEX.test(x.name) ? j : -1)).filter((j) => j >= 0) : [];
        return { key: i, name: K.name(h.path), file: h.entry.name, path: h.path, ytd, only: blood.length ? blood : null };
      }),
      replace(key, ti, data) { t.replace(key, ti, data); },
      outputs() { return t.edited ? { [rel]: t.bytes() } : {}; },
      /** "Save to folder": the edited RPF itself */
      files() { return t.edited ? [{ name, bytes: t.bytes() }] : []; },
    };
  }, ctx.unlock);
}

/** "x64/ (2 files), fxmanifest.lua" style summary of an archive, for error messages. */
function describeTree(root) {
  const names = [];
  rpf.walk(root, (e, p) => names.push(p));
  if (!names.length) return 'nothing';
  return names.slice(0, 6).join(', ') + (names.length > 6 ? ' and ' + (names.length - 6) + ' more' : '');
}

module.exports = { listSources, openSource, openFiles, cloudName, bloodName, KINDS };
