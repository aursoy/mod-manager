'use strict';
// Where the AI gets the sky texture from, in order of what the player most likely uses:
//   pack      skydome.ytd loose in the pack they dropped into the chat
//   pack-rpf  skydome.ytd inside one of that pack's RPFs (packs ship these for FiveM.app/mods)
//   mods      skydome.ytd inside an RPF already in FiveM.app/mods (an installed sky / graphics pack)
//   citizen   skydome.ytd loose in citizen
//   game      the stock sky from GTA V's own x64a.rpf
// Every source returns an object with describe(), skyIndex() and replace(index, data) -> new file bytes,
// plus the path the edited file goes to in a pack.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const { YtdFile, RpfSky, skydomeFromGame, DEFAULT_REL } = require('./skytex');
const { readStaged } = require('./gfxpack');
const { findInFile } = require('./rpfscan');

const MAX_RPF = 2000 * 1048576;
const IS_SKY = (n) => n.toLowerCase() === 'skydome.ytd';
// Look at the archives most likely to hold a sky first.
const SKYISH = /sky|cloud|star|weather|graphic|visual|nve|qrv|tc|time/i;
const bySkyName = (a, b) => (SKYISH.test(path.basename(b)) ? 1 : 0) - (SKYISH.test(path.basename(a)) ? 1 : 0);

async function withKeys(fn, unlock) {
  try { return fn(); } catch (e) {
    if (e.code !== rpf.NEED_KEYS || !unlock) throw e;
    await unlock();
    return fn();
  }
}

/** First RPF (from a list of { rel, label, read() }) that has a sky. */
async function firstRpfSky(list, unlock) {
  let locked = null;
  for (const item of list.sort((a, b) => bySkyName(a.rel, b.rel))) {
    // On disk, read only the archive's file list first: whatever the RPF is called,
    // it is opened only if a skydome.ytd is really inside.
    if (item.file) {
      try {
        if (fs.statSync(item.file).size > MAX_RPF) continue;
        if (!(await withKeys(() => findInFile(item.file, IS_SKY), unlock)).length) continue;
      } catch (e) { if (e.code === rpf.NEED_KEYS) locked = e; continue; }
    }
    let buf;
    try { buf = item.read(); } catch (e) { continue; }
    if (!buf || buf.length > MAX_RPF) continue;
    try {
      const obj = await withKeys(() => new RpfSky(buf, path.basename(item.rel)), unlock);
      return { obj, rel: item.rel, label: item.label + ' → ' + obj.path };
    } catch (e) {
      if (e.code === rpf.NEED_KEYS) locked = e;
    }
  }
  if (locked) throw locked;
  return null;
}

function modsRpfs(citizenPath) {
  if (!citizenPath) return [];
  const dir = path.join(path.dirname(citizenPath), 'mods');
  try {
    return fs.readdirSync(dir).filter((n) => /\.rpf$/i.test(n)).map((n) => ({ rel: '@mods/' + n, label: 'mods / ' + n, file: path.join(dir, n), read: () => fs.readFileSync(path.join(dir, n)) }));
  } catch (e) { return []; }
}

/** ctx: { pack: { staged, info } | null, mgr, gtaDirs: () => [dir], unlock: async () => {} | null } */
async function openSkySource(source, ctx) {
  const { pack, mgr } = ctx;
  if (source === 'pack') {
    if (!pack || !pack.info.skydome) return null;
    const s = pack.staged.find((x) => x.rel === pack.info.skydome);
    return { obj: new YtdFile(readStaged(s), 'skydome.ytd'), rel: s.rel, label: pack.info.name + ' / skydome.ytd' };
  }
  if (source === 'pack-rpf') {
    if (!pack) return null;
    const list = pack.staged.filter((s) => /\.rpf$/i.test(s.rel)).map((s) => ({ rel: s.rel, label: pack.info.name + ' / ' + path.basename(s.rel), file: s.from || null, read: () => readStaged(s) }));
    return firstRpfSky(list, ctx.unlock);
  }
  if (source === 'mods') return firstRpfSky(modsRpfs(mgr.state.citizenPath), ctx.unlock);
  if (source === 'citizen') {
    const rel = mgr.findInCitizen('skydome.ytd');
    if (!rel) return null;
    return { obj: new YtdFile(fs.readFileSync(mgr.absFor(rel)), 'skydome.ytd'), rel, label: 'citizen / ' + rel };
  }
  if (source === 'game') {
    const dir = ctx.gtaDirs()[0];
    if (!dir) return null;
    const g = await withKeys(() => skydomeFromGame(dir), ctx.unlock);
    return { obj: new YtdFile(g.stored, 'skydome.ytd'), rel: DEFAULT_REL, label: 'your GTA V (' + g.path + ')' };
  }
  if (source && source.file) {
    const buf = fs.readFileSync(source.file);
    if (/\.rpf$/i.test(source.file)) {
      const obj = await withKeys(() => new RpfSky(buf, path.basename(source.file)), ctx.unlock);
      return { obj, rel: '@mods/' + path.basename(source.file), label: path.basename(source.file) + ' → ' + obj.path };
    }
    return { obj: new YtdFile(buf, path.basename(source.file)), rel: DEFAULT_REL, label: path.basename(source.file) };
  }
  throw new Error('Unknown sky source');
}

/** Which sources are worth trying, cheapest and most likely first. */
function skySources({ pack, mgr, gtaDirs }) {
  const out = [];
  if (pack && pack.info.skydome) out.push('pack');
  if (pack && pack.staged.some((s) => /\.rpf$/i.test(s.rel))) out.push('pack-rpf');
  if (modsRpfs(mgr.state.citizenPath).length) out.push('mods');
  if (mgr.findInCitizen('skydome.ytd')) out.push('citizen');
  if (gtaDirs()[0]) out.push('game');
  return out;
}

module.exports = { openSkySource, skySources };
