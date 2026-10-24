'use strict';
// World options that edit a game data file in place, on top of whatever is there
// now (the stock file or a graphics pack's version):
//   Black mountains   visualsettings.dat  (how far the game draws: misc.Multiplier.farClipMultiplier)
//   Snow              weather.xml         (the Snow / SnowMist value of every weather type)
//   Visual settings   visualsettings.dat  (any line, from the editor)
// Each change remembers exactly what was there before it, so switching it off puts
// that back: a pack's file stays the pack's file.

const fs = require('fs');
const path = require('path');
const { parseVS, setValues, packMountainKeys, FAR_CLIP } = require('./visualsettings');

const VS = 'common/data/visualsettings.dat';
const WEATHER = 'common/data/levels/gta5/weather.xml';
// where the same files live inside the game, newest first
const GAME_PATHS = {
  [VS]: [['update/update.rpf', 'common/data/visualsettings.dat'], ['common.rpf', 'data/visualsettings.dat']],
  [WEATHER]: [['update/update.rpf', 'common/data/levels/gta5/weather.xml'], ['common.rpf', 'data/levels/gta5/weather.xml']],
};
const REMOVED_FAR_CLIP = 0.5;

class WorldFiles {
  /** readGame(rpfRelToGtaDir, innerPath) -> Buffer | null */
  constructor(mgr, dir, readGame = () => null) {
    this.mgr = mgr;
    this.dir = dir;
    this.readGame = readGame;
  }

  get w() {
    const s = this.mgr.state;
    s.world = s.world || {};
    s.world.patches = s.world.patches || {};
    return s.world;
  }

  prevPath(owner, rel) { return path.join(this.dir, 'patches', owner, ...rel.split('/')); }

  /** The file as it is in citizen now, else the game's own copy, else null. */
  current(rel) {
    const abs = this.mgr.absFor(rel);
    if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
    for (const [arc, inner] of GAME_PATHS[rel] || []) {
      try { const b = this.readGame(arc, inner); if (b) return b.toString('utf8'); } catch (e) { if (e.code === 'NEED_KEYS') this.needKeys = true; }
    }
    return null;
  }

  /** The file as it was before `owner` changed it. */
  before(owner, rel) {
    const p = this.w.patches[owner + '|' + rel];
    if (p && fs.existsSync(this.prevPath(owner, rel))) return fs.readFileSync(this.prevPath(owner, rel), 'utf8');
    return this.current(rel);
  }

  patch(owner, rel, text) {
    const key = owner + '|' + rel;
    if (!this.w.patches[key]) {
      const abs = this.mgr.absFor(rel);
      const prev = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      if (prev) { fs.mkdirSync(path.dirname(this.prevPath(owner, rel)), { recursive: true }); fs.writeFileSync(this.prevPath(owner, rel), prev); }
      this.w.patches[key] = { prevOwner: this.mgr.state.owners[rel] || null, existed: !!prev };
    }
    this.mgr.writeFile(rel, text, owner);
    this.mgr.save();
  }

  unpatch(owner, rel) {
    const key = owner + '|' + rel;
    const p = this.w.patches[key];
    if (!p) return;
    if (this.mgr.state.owners[rel] === owner) {
      if (p.prevOwner && p.existed) this.mgr.writeFile(rel, fs.readFileSync(this.prevPath(owner, rel)), p.prevOwner);
      else this.mgr.restoreFile(rel);
    }
    fs.rmSync(this.prevPath(owner, rel), { force: true });
    delete this.w.patches[key];
    this.mgr.save();
  }

  // ---------- black mountains ----------

  mountains() {
    const text = this.before('mountains', VS);
    if (text == null) return { available: false };
    const entries = parseVS(text);
    const far = entries.find((e) => e.key === FAR_CLIP);
    const packKeys = packMountainKeys(entries);
    const now = parseVS(this.current(VS) || '');
    const removed = this.mgr.state.owners[VS] === 'mountains';
    return {
      available: !!far || packKeys.length > 0,
      removed,
      original: far ? far.value : null,
      value: (now.find((e) => e.key === FAR_CLIP) || far || {}).value ?? null,
      packKeys: packKeys.map((k) => ({ key: k, value: (now.find((e) => e.key === k) || {}).value, section: (entries.find((e) => e.key === k) || {}).section })),
    };
  }

  /** opts: { removed: bool, distance?: number, keys?: { key: value } } */
  setMountains(opts) {
    if (!opts.removed && !opts.distance && !opts.keys) { this.unpatch('mountains', VS); return this.mountains(); }
    const base = this.before('mountains', VS);
    if (base == null) throw new Error('No visualsettings.dat found in your game or packs.');
    const far = parseVS(base).find((e) => e.key === FAR_CLIP);
    const changes = { ...(opts.keys || {}) };
    if (far) changes[FAR_CLIP] = opts.distance != null ? opts.distance : opts.removed ? far.value * REMOVED_FAR_CLIP : far.value;
    this.patch('mountains', VS, setValues(base, changes));
    return this.mountains();
  }

  // ---------- snow ----------

  snow() {
    const text = this.current(WEATHER);
    if (text == null) return { available: false };
    const vals = [...text.matchAll(/<Snow\s+value="([^"]*)"/g)].map((m) => Number(m[1]) || 0);
    return { available: vals.length > 0, amount: vals.length ? Math.max(...vals) : 0, on: this.mgr.state.owners[WEATHER] === 'snow', weathers: vals.length };
  }

  /** amount 0..1: snow for every weather type. 0 puts the file back. */
  setSnow(amount) {
    amount = Math.max(0, Math.min(1, +amount || 0));
    if (!amount) { this.unpatch('snow', WEATHER); return this.snow(); }
    const base = this.before('snow', WEATHER);
    if (base == null) throw new Error('No weather.xml found in your game or packs.');
    if (!/<Snow\s+value=/.test(base)) throw new Error('This weather.xml has no snow settings.');
    const v = amount.toFixed(6);
    const text = base.replace(/(<Snow\s+value=")[^"]*(")/g, '$1' + v + '$2').replace(/(<SnowMist\s+value=")[^"]*(")/g, '$1' + (amount * 0.6).toFixed(6) + '$2');
    this.patch('snow', WEATHER, text);
    return this.snow();
  }

  // ---------- visual settings editor ----------

  visualSettings() {
    const text = this.current(VS);
    if (text == null) return { available: false, entries: [] };
    const abs = this.mgr.absFor(VS);
    return { available: true, source: fs.existsSync(abs) ? 'your game' : 'GTA V (stock)', edited: !!this.w.patches['visualsettings|' + VS], entries: parseVS(text) };
  }

  saveVisualSettings(changes) {
    const base = this.current(VS);
    if (base == null) throw new Error('No visualsettings.dat found in your game or packs.');
    this.patch('visualsettings', VS, setValues(base, changes));
    return this.visualSettings();
  }

  resetVisualSettings() { this.unpatch('visualsettings', VS); return this.visualSettings(); }
}

module.exports = { WorldFiles, VS, WEATHER };
