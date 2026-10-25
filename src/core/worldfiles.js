'use strict';
// World options that edit a game data file in place, on top of whatever is there
// now (the stock file or a graphics pack's version):
//   Black mountains   visualsettings.dat  (how far the game draws: misc.Multiplier.farClipMultiplier)
//   Player detail     visualsettings.dat  (how far away players keep their full model: ped.lod.distance.*)
//   Snow              weather.xml         (the Snow / SnowMist value of every weather type)
//   Still clouds      clouds.xml          (cloud hats stop turning and scrolling)
//   Visual settings   visualsettings.dat  (any line, from the editor)
// Each change remembers exactly what was there before it, so switching it off puts
// that back: a pack's file stays the pack's file. The visualsettings.dat options each
// keep their own lines, and the file is always "the file before any of them + all of them",
// so switching one off never undoes another.

const fs = require('fs');
const path = require('path');
const { parseVS, setValues, packMountainKeys, FAR_CLIP } = require('./visualsettings');

const VS = 'common/data/visualsettings.dat';
const WEATHER = 'common/data/levels/gta5/weather.xml';
const SNOW_EFFECTS = ['DropSettingName', 'MistSettingName', 'GroundSettingName'];
const CLOUDS = 'common/data/clouds.xml';
// where the same files live inside the game, newest first
const GAME_PATHS = {
  [VS]: [['update/update.rpf', 'common/data/visualsettings.dat'], ['common.rpf', 'data/visualsettings.dat']],
  [WEATHER]: [['update/update.rpf', 'common/data/levels/gta5/weather.xml'], ['common.rpf', 'data/levels/gta5/weather.xml']],
  [CLOUDS]: [['update/update.rpf', 'common/data/clouds.xml'], ['common.rpf', 'data/clouds.xml']],
};
const REMOVED_FAR_CLIP = 0.5;
const HEIGHT_EVERYWHERE = { 'misc.Multiplier.heightStart': -1000, 'misc.Multiplier.heightEnd': -999 };
const VS_OWNER = 'visualsettings';
const VS_LAYERS = ['mountains', 'pedlod', 'editor']; // later ones win on the same line
// Up to how many metres away a player keeps the full model. GTA's own values are
// 25 / 50 / 80 (7 / 15 in a car), and FPS packs often cut them further, which is
// why players a few metres away turn into blocky low-detail models.
const PED_LOD = {
  'ped.lod.distance.high': 150,
  'ped.lod.distance.medium': 250,
  'ped.lod.distance.low': 400,
  'pedincar.lod.distance.high': 60,
  'pedincar.lod.distance.high.x64': 80,
};

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
    return this.fromGame(rel);
  }

  fromGame(rel) {
    for (const [arc, inner] of GAME_PATHS[rel] || []) {
      try { const b = this.readGame(arc, inner); if (b) return b.toString('utf8'); } catch (e) { if (e.code === 'NEED_KEYS') this.needKeys = true; }
    }
    return null;
  }

  /** The file as it was before `owner` changed it. */
  before(owner, rel) {
    const p = this.w.patches[owner + '|' + rel];
    if (p && p.existed && fs.existsSync(this.prevPath(owner, rel))) return fs.readFileSync(this.prevPath(owner, rel), 'utf8');
    if (p && !p.existed) return this.fromGame(rel); // citizen had no copy: the one there now is ours
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

  // ---------- visualsettings.dat (shared by the options below) ----------

  get vsLayers() { this.w.vs = this.w.vs || {}; return this.w.vs; }

  /** visualsettings.dat as it was before any of our options touched it. */
  vsBase() { return this.before(VS_OWNER, VS); }

  /** Set one option's lines (null drops them) and write the file again. */
  writeVS(layer, changes) {
    const L = this.vsLayers;
    if (changes && Object.keys(changes).length) L[layer] = changes; else delete L[layer];
    if (!Object.keys(L).length) { this.unpatch(VS_OWNER, VS); return; }
    const base = this.vsBase();
    if (base == null) throw new Error('No visualsettings.dat found in your game or packs.');
    const all = Object.assign({}, ...VS_LAYERS.map((k) => L[k] || {}));
    let text = setValues(base, all);
    // a pack's file can leave lines out; add the ones we need at the end
    const have = new Set(parseVS(base).map((e) => e.key));
    const missing = Object.keys(all).filter((k) => !have.has(k));
    if (missing.length) {
      const crlf = (base.match(/\r\n/g) || []).length;
      const eol = crlf * 2 > (base.match(/\n/g) || []).length ? '\r\n' : '\n';
      text = text.replace(/\s*$/, '') + eol + eol + '# Kt Mod Manager' + eol + missing.map((k) => k + '\t' + all[k]).join(eol) + eol;
    }
    this.patch(VS_OWNER, VS, text);
  }

  // ---------- black mountains ----------

  mountains() {
    const text = this.vsBase();
    if (text == null) return { available: false };
    const entries = parseVS(text);
    const far = entries.find((e) => e.key === FAR_CLIP);
    const packKeys = packMountainKeys(entries);
    const now = parseVS(this.current(VS) || '');
    return {
      available: !!far || packKeys.length > 0,
      removed: !!this.vsLayers.mountains,
      original: far ? far.value : null,
      value: (now.find((e) => e.key === FAR_CLIP) || far || {}).value ?? null,
      packKeys: packKeys.map((k) => ({ key: k, value: (now.find((e) => e.key === k) || {}).value, section: (entries.find((e) => e.key === k) || {}).section })),
    };
  }

  /** opts: { removed: bool, distance?: number, keys?: { key: value } } */
  setMountains(opts) {
    if (!opts.removed && !opts.distance && !opts.keys) { this.writeVS('mountains', null); return this.mountains(); }
    const base = this.vsBase();
    if (base == null) throw new Error('No visualsettings.dat found in your game or packs.');
    const far = parseVS(base).find((e) => e.key === FAR_CLIP);
    const changes = { ...(opts.keys || {}) };
    if (far) {
      changes[FAR_CLIP] = opts.distance != null ? opts.distance : opts.removed ? far.value * REMOVED_FAR_CLIP : far.value;
      // GTA only uses farClipMultiplier between heightStart and heightEnd (100-250 m up, for
      // flying), so on the ground it does nothing. Below ground on both, it applies everywhere.
      if (changes[FAR_CLIP] !== far.value) Object.assign(changes, HEIGHT_EVERYWHERE);
    }
    this.writeVS('mountains', changes);
    return this.mountains();
  }

  // ---------- player detail distance (low-detail "blocky" players up close) ----------

  pedLod() {
    const text = this.vsBase();
    if (text == null) return { available: false };
    const was = parseVS(text);
    const now = parseVS(this.current(VS) || '');
    const val = (list, k) => (list.find((e) => e.key === k) || {}).value ?? null;
    const high = 'ped.lod.distance.high';
    return { available: true, on: !!this.vsLayers.pedlod, before: val(was, high), now: val(now, high), fixed: PED_LOD[high] };
  }

  setPedLod(on) {
    this.writeVS('pedlod', on ? { ...PED_LOD } : null);
    return this.pedLod();
  }

  // ---------- still clouds ----------
  // Every cloud hat in clouds.xml has a spin (mAngularVelocity), a scroll per layer
  // (mUVVelocity) and animations (mEnableAnimations); the manager scrolls them with
  // altitude too (mAltitudeScrollScaler). Zero them all and the clouds stay put.

  stillClouds() {
    const text = this.current(CLOUDS);
    if (text == null) return { available: false };
    const hats = (text.match(/<mAngularVelocity\b/g) || []).length;
    return { available: hats > 0, on: this.mgr.state.owners[CLOUDS] === 'clouds', hats };
  }

  setStillClouds(on) {
    if (!on) { this.unpatch('clouds', CLOUDS); return this.stillClouds(); }
    const base = this.before('clouds', CLOUDS);
    if (base == null) throw new Error('No clouds.xml found in your game or packs.');
    if (!/<mAngularVelocity\b/.test(base)) throw new Error('This clouds.xml has no cloud movement settings.');
    const zero = (n) => n.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, (m) => (m.includes('.') ? '0.000000' : '0'));
    const text = base
      .replace(/(<mAngularVelocity\b[^>]*?)\/?>/g, (tag) => tag.replace(/(\b[xyz]\s*=\s*")([^"]*)(")/g, (m, a, v, b) => a + '0.000000' + b))
      .replace(/(<mUVVelocity\b[^>]*>)([\s\S]*?)(<\/mUVVelocity>)/g, (m, a, body, b) => a + zero(body) + b)
      .replace(/(<mAltitudeScrollScaler\s+value=")[^"]*(")/g, '$10.000000$2')
      .replace(/(<mEnableAnimations\s+value=")[^"]*(")/g, '$1false$2');
    this.patch('clouds', CLOUDS, text);
    return this.stillClouds();
  }

  // ---------- visual settings editor ----------

  visualSettings() {
    const text = this.current(VS);
    if (text == null) return { available: false, entries: [] };
    const abs = this.mgr.absFor(VS);
    return { available: true, source: fs.existsSync(abs) ? 'your game' : 'GTA V (stock)', edited: !!this.vsLayers.editor, entries: parseVS(text) };
  }

  saveVisualSettings(changes) {
    this.writeVS('editor', { ...(this.vsLayers.editor || {}), ...changes });
    return this.visualSettings();
  }

  resetVisualSettings() { this.writeVS('editor', null); return this.visualSettings(); }

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
    // The amount alone shows nothing: each weather also names its falling-particle, mist and
    // ground effects, and only the snowy ones name snow. Every weather borrows those from XMAS.
    const items = base.match(/<Item>[\s\S]*?<\/Item>/g) || [];
    const snowy = ['XMAS', 'BLIZZARD', 'SNOW', 'SNOWLIGHT'].map((n) => items.find((it) => new RegExp('<Name>\\s*' + n + '\\s*</Name>', 'i').test(it))).find(Boolean);
    const effects = {};
    if (snowy) for (const tag of SNOW_EFFECTS) { const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(snowy); if (m) effects[tag] = m[1]; }
    const text = base.replace(/<Item>[\s\S]*?<\/Item>/g, (it) => {
      let out = it.replace(/(<Snow\s+value=")[^"]*(")/g, '$1' + v + '$2').replace(/(<SnowMist\s+value=")[^"]*(")/g, '$1' + (amount * 0.6).toFixed(6) + '$2');
      for (const [tag, val] of Object.entries(effects)) out = out.replace(new RegExp('(<' + tag + '>)[^<]*(</' + tag + '>)'), '$1' + val + '$2').replace(new RegExp('<' + tag + '\\s*/>'), '<' + tag + '>' + val + '</' + tag + '>');
      return out;
    });
    this.patch('snow', WEATHER, text);
    return this.snow();
  }
}

module.exports = { WorldFiles, VS, WEATHER, CLOUDS, PED_LOD };
