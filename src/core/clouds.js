'use strict';
// Cloud hats: GTA V's clouds are textures in cloudhat_*.ytd files (cloudhat_wispy,
// cloudhat_nimbus, ...). Packs ship them inside RPFs for FiveM.app/mods under any
// name and any folder layout, so they are found by file name, wherever they are.
//
// A source is one place the clouds were found. Every source can list its textures,
// take edited texture data, and hand back the files to install:
//   pack       loose cloudhat_*.ytd in the pack dropped into the Pack AI
//   pack-rpf   inside one of that pack's RPFs        (edited RPF goes to mods)
//   mods       inside an RPF already in FiveM.app/mods (edited RPF replaces it, backed up)
//   citizen    loose cloudhat_*.ytd in citizen
//   game       GTA V's own clouds, copied into a new mods/kt_clouds.rpf

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { YtdFile, RpfTextures } = require('./skytex');
const { findInFile, extractFromFile } = require('./rpfscan');
const { readStaged } = require('./gfxpack');

const IS_CLOUD = (name) => /^cloudhat.*\.ytd$/i.test(name);
const MAX_RPF = 2000 * 1048576;
const GAME_FILES = ['x64b.rpf', 'update/update.rpf', 'x64a.rpf', 'x64c.rpf'];
const OUT_RPF = '@mods/kt_clouds.rpf';

/** "cloudhat_wispy.ytd" -> "Wispy" */
function cloudName(file) {
  const n = path.basename(file, '.ytd').replace(/^cloudhat_?/i, '').replace(/[_-]+/g, ' ').trim();
  const nice = { cirro: 'Cirrus', clear01: 'Clear', nimbus: 'Nimbus', wispy: 'Wispy', cloudy: 'Cloudy', horizon: 'Horizon', contrails: 'Contrails', puffs: 'Puffs', stripey: 'Stripey', stormy: 'Stormy', rain: 'Rain', snowy: 'Snowy', shower: 'Shower', altostratus: 'Altostratus', cirrocumulus: 'Cirrocumulus', stratoscumulus: 'Stratocumulus' };
  const key = n.toLowerCase().replace(/\s+/g, '');
  return nice[key] || (n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Cloud');
}

async function withKeys(fn, unlock) {
  try { return fn(); } catch (e) {
    if (e.code !== rpf.NEED_KEYS || !unlock) throw e;
    await unlock();
    return fn();
  }
}

function modsDir(mgr) { return mgr.state.citizenPath ? path.join(path.dirname(mgr.state.citizenPath), 'mods') : null; }

/** Where clouds can be found right now, cheapest first. Only tables of contents are read. */
async function listCloudSources(ctx) {
  const { pack, mgr } = ctx;
  const out = [];
  if (pack) {
    const loose = pack.staged.filter((s) => IS_CLOUD(path.basename(s.rel)));
    if (loose.length) out.push({ id: 'pack', label: pack.info.name + ' (' + loose.length + ' cloud files)', count: loose.length });
    for (const s of pack.staged.filter((x) => /\.rpf$/i.test(x.rel))) {
      let n = 0;
      try {
        n = s.from ? (await withKeys(() => findInFile(s.from, IS_CLOUD), ctx.unlock)).length
          : new RpfTextures(readStaged(s), path.basename(s.rel), IS_CLOUD).hits.length;
      } catch (e) { /* not an archive with clouds */ }
      if (n) out.push({ id: 'pack-rpf:' + s.rel, label: pack.info.name + ' / ' + path.basename(s.rel), count: n });
    }
  }
  const dir = modsDir(mgr);
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => /\.rpf$/i.test(n))) {
      let n = 0;
      try { n = (await withKeys(() => findInFile(path.join(dir, name), IS_CLOUD), ctx.unlock)).length; } catch (e) { /* unreadable */ }
      if (n) out.push({ id: 'mods:' + name, label: 'mods / ' + name, count: n });
    }
  }
  const cit = mgr.findAllInCitizen(/^cloudhat.*\.ytd$/i);
  if (cit.length) out.push({ id: 'citizen', label: 'citizen (' + cit.length + ' cloud files)', count: cit.length });
  const gta = ctx.gtaDirs()[0];
  if (gta) {
    for (const f of GAME_FILES) {
      const file = path.join(gta, ...f.split('/'));
      if (!fs.existsSync(file)) continue;
      let n = 0;
      try { n = (await withKeys(() => findInFile(file, IS_CLOUD), ctx.unlock)).length; } catch (e) { /* skip */ }
      if (n) { out.push({ id: 'game:' + f, label: 'GTA V stock clouds (' + f + ')', count: n }); break; }
    }
  }
  return out;
}

/** Load a source. Returns { label, items: [{ key, name, file, path, ytd }], replace(key, ti, data), outputs() }. */
async function openCloudSource(id, ctx) {
  const { pack, mgr } = ctx;
  const loose = (list, label) => {
    const items = list.map((x, i) => ({ key: i, name: cloudName(x.rel), file: path.basename(x.rel), path: x.rel, ytd: new YtdFile(x.bytes, path.basename(x.rel)), rel: x.rel, edited: false }));
    return {
      label, items,
      replace(key, ti, data) { items[key].ytd.replace(ti, data); items[key].edited = true; },
      outputs() { return Object.fromEntries(items.filter((x) => x.edited).map((x) => [x.rel, x.ytd.ytdBytes()])); },
    };
  };
  const inRpf = (buf, rel, label) => {
    const t = new RpfTextures(buf, path.basename(rel), IS_CLOUD);
    return {
      label,
      items: t.hits.map((h, i) => ({ key: i, name: cloudName(h.entry.name), file: h.entry.name, path: h.path, ytd: t.ytds[i] })),
      replace(key, ti, data) { t.replace(key, ti, data); },
      outputs() { return t.edited ? { [rel]: t.bytes() } : {}; },
    };
  };

  if (id === 'pack') {
    const list = pack.staged.filter((s) => IS_CLOUD(path.basename(s.rel))).map((s) => ({ rel: s.rel, bytes: readStaged(s) }));
    return loose(list, pack.info.name);
  }
  if (id.startsWith('pack-rpf:')) {
    const rel = id.slice(9);
    const s = pack.staged.find((x) => x.rel === rel);
    if (s.from && fs.statSync(s.from).size > MAX_RPF) throw new Error(path.basename(rel) + ' is too big to edit here.');
    return withKeys(() => inRpf(readStaged(s), rel, pack.info.name + ' / ' + path.basename(rel)), ctx.unlock);
  }
  if (id.startsWith('mods:')) {
    const name = id.slice(5);
    const file = path.join(modsDir(mgr), name);
    if (fs.statSync(file).size > MAX_RPF) throw new Error(name + ' is too big to edit here.');
    return withKeys(() => inRpf(fs.readFileSync(file), '@mods/' + name, 'mods / ' + name), ctx.unlock);
  }
  if (id === 'citizen') {
    const list = mgr.findAllInCitizen(/^cloudhat.*\.ytd$/i).map((rel) => ({ rel, bytes: fs.readFileSync(mgr.absFor(rel)) }));
    return loose(list, 'citizen');
  }
  if (id.startsWith('game:')) {
    const f = id.slice(5);
    const found = await withKeys(() => extractFromFile(path.join(ctx.gtaDirs()[0], ...f.split('/')), IS_CLOUD), ctx.unlock);
    const items = found.map((x, i) => ({ key: i, name: cloudName(x.name), file: x.name, path: f + '/' + x.path, ytd: new YtdFile(x.stored, x.name), edited: false }));
    return {
      label: 'GTA V stock clouds', items,
      replace(key, ti, data) { items[key].ytd.replace(ti, data); items[key].edited = true; },
      // the game's own files are never touched: edited clouds go into a new RPF in mods
      outputs() {
        const edited = items.filter((x) => x.edited);
        if (!edited.length) return {};
        const children = edited.map((x) => {
          const stored = x.ytd.ytdBytes();
          return { type: 'res', name: x.file.toLowerCase(), stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) };
        });
        return { [OUT_RPF]: rpf.writeRpf({ type: 'dir', name: '', children }) };
      },
    };
  }
  throw new Error('Unknown cloud source');
}

module.exports = { listCloudSources, openCloudSource, cloudName, IS_CLOUD };
