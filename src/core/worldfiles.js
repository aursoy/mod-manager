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
const { findThunder, muteThunder, citizenRel } = require('./thunder');
const { parseVS, setValues, packMountainKeys, FAR_CLIP } = require('./visualsettings');

const VS = 'common/data/visualsettings.dat';
const WEATHER = 'common/data/levels/gta5/weather.xml';
const TC_WEATHERS = ['extrasunny', 'clear', 'clouds', 'smog', 'foggy', 'overcast', 'rain', 'thunder', 'clearing', 'neutral', 'snow', 'blizzard', 'snowlight', 'xmas', 'halloween'];
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
  constructor(mgr, dir, readGame = () => null, { gtaDir = () => null } = {}) {
    this.mgr = mgr;
    this.gtaDir = gtaDir;
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
    // any other data file: update.rpf first, then common.rpf
    const paths = GAME_PATHS[rel] || (/^common\/data\//.test(rel) ? [['update/update.rpf', rel], ['common.rpf', rel.replace(/^common\//, '')]] : []);
    for (const [arc, inner] of paths) {
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
    this.patch('clouds', CLOUDS, stillCloudsText(base));
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

  // ---------- weather.xml: snow and lightning (one file, each option its own layer) ----------

  get weatherLayers() {
    this.w.weather = this.w.weather || {};
    const L = this.w.weather;
    // older versions let snow own the file on its own
    const legacy = this.w.patches['snow|' + WEATHER];
    if (legacy && L.snow == null) {
      const vals = [...(this.current(WEATHER) || '').matchAll(/<Snow\s+value="([^"]*)"/g)].map((m) => Number(m[1]) || 0);
      L.snow = vals.length ? Math.max(...vals) : 1;
    }
    return L;
  }

  writeWeather() {
    const L = this.weatherLayers;
    if (this.w.patches['snow|' + WEATHER]) this.unpatch('snow', WEATHER);
    if (!L.snow && !L.noLightning) { this.unpatch('weather', WEATHER); return; }
    const base = this.before('weather', WEATHER);
    if (base == null) throw new Error('No weather.xml found in your game or packs.');
    let text = base;
    if (L.snow) text = snowify(text, L.snow, this.fromGame(WEATHER));
    if (L.noLightning) text = text.replace(/(<Lightning\s+value=")[^"]*(")/g, '$10.000000$2');
    this.patch('weather', WEATHER, text);
  }

  snow() {
    const text = this.current(WEATHER);
    if (text == null) return { available: false };
    const vals = [...text.matchAll(/<Snow\s+value="([^"]*)"/g)].map((m) => Number(m[1]) || 0);
    const L = this.weatherLayers;
    return { available: /<Item>/.test(text), modsWeather: this.modsWith(/^weather\.xml$/i), amount: L.snow || (vals.length ? Math.max(...vals) : 0), on: !!L.snow, weathers: vals.length };
  }

  /** RPFs in FiveM.app/mods with a file of this name inside (a pack there may load its own copy). */
  modsWith(test) {
    const c = this.mgr.state.citizenPath;
    if (!c) return [];
    const dir = path.join(path.dirname(c), 'mods');
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /\.rpf$/i.test(n)); } catch (e) { return out; }
    for (const n of names) {
      try { if (require('./rpfscan').findInFile(path.join(dir, n), test).length) out.push(n); } catch (e) { /* encrypted or unreadable */ }
    }
    return out;
  }

  /** amount 0..1: snow for every weather type. 0 takes it out again. */
  setSnow(amount) {
    amount = Math.max(0, Math.min(1, +amount || 0));
    if (amount) {
      const base = this.before('weather', WEATHER);
      if (base == null) throw new Error('No weather.xml found in your game or packs.');
      if (!/<Item>/.test(base)) throw new Error('This weather.xml has no weather types in it.');
    }
    this.weatherLayers.snow = amount || 0;
    this.writeWeather();
    return this.snow();
  }

  lightning() {
    const text = this.current(WEATHER);
    if (text == null) return { available: false };
    return { available: /<Lightning\s+value=/.test(text), off: !!this.weatherLayers.noLightning };
  }

  /** off: no lightning in any weather (storms included). */
  setLightning(off) {
    if (off) {
      const base = this.before('weather', WEATHER);
      if (base == null) throw new Error('No weather.xml found in your game or packs.');
      if (!/<Lightning\s+value=/.test(base)) throw new Error('This weather.xml has no lightning settings.');
    }
    this.weatherLayers.noLightning = !!off;
    this.writeWeather();
    return this.lightning();
  }

  // ---------- stars (every weather's timecycle, a pack's included) ----------

  starFiles() {
    const rels = new Set(TC_WEATHERS.map((w) => 'common/data/timecycle/w_' + w + '.xml'));
    // a pack's own timecycle files, whatever they are called
    const dir = this.mgr.state.citizenPath && path.join(this.mgr.state.citizenPath, 'common', 'data', 'timecycle');
    try { for (const n of fs.readdirSync(dir)) if (/\.xml$/i.test(n)) rels.add('common/data/timecycle/' + n); } catch (e) { /* none */ }
    for (const rel of this.w.starsRels || []) rels.add(rel);
    return [...rels];
  }

  stars() {
    const mode = this.w.stars || 'pack';
    const sample = this.current('common/data/timecycle/w_clear.xml') || this.current('common/data/timecycle/w_extrasunny.xml');
    // picture-sky packs show their sky picture through the stars setting
    const zen = sample && /<sky_zenith_col_r>([^<]*)</.exec(sample);
    const pictureSky = !!(zen && zen[1].trim().split(/\s+/).every((x) => Number(x) < 0.02) && /<sky_stars_iten>\s*[1-9]/.test(sample));
    return { available: !!sample && /<sky_stars_iten>/.test(sample), mode, pictureSky };
  }

  /** mode: 'pack' (as your pack has it) | 'on' (stars every night) | 'off' (no stars) */
  setStars(mode) {
    for (const rel of this.w.starsRels || []) this.unpatch('stars', rel);
    delete this.w.starsRels; delete this.w.stars;
    if (mode === 'on' || mode === 'off') {
      const rels = [];
      for (const rel of this.starFiles()) {
        const base = this.before('stars', rel);
        if (base == null || !/<sky_stars_iten>/.test(base)) continue;
        const text = starsText(base, mode);
        if (text === base && this.mgr.state.owners[rel] == null) continue; // the game's own file already does this
        this.patch('stars', rel, text);
        rels.push(rel);
      }
      if (!rels.length && mode === 'off') throw new Error('No timecycle files with stars found.');
      this.w.stars = mode; this.w.starsRels = rels;
    }
    this.mgr.save();
    return this.stars();
  }

  // ---------- thunder (GTA V's audio archives) ----------

  thunder() {
    const t = this.w.thunder;
    return { available: !!this.gtaDir(), off: !!(t && t.rels && t.rels.length), muted: t ? t.muted || 0 : 0 };
  }

  setThunder(off) {
    const t = this.w.thunder || { rels: [] };
    if (!off) {
      for (const rel of t.rels) this.unpatch('thunder', rel);
      delete this.w.thunder;
      this.mgr.save();
      return this.thunder();
    }
    const found = findThunder(this.gtaDir());
    if (!found.length) throw new Error('No thunder sounds found in your GTA V audio files.');
    const rels = [];
    let muted = 0;
    for (const a of found) {
      const rel = citizenRel(a.name);
      // build on the copy in citizen if a sound pack already replaced this archive
      const abs = this.mgr.absFor(rel);
      const ours = this.mgr.state.owners[rel] === 'thunder';
      const prev = ours ? this.prevPath('thunder', rel) : abs;
      const buf = fs.existsSync(prev) ? fs.readFileSync(prev) : fs.readFileSync(a.file);
      const r = muteThunder(buf, a.name);
      if (!r.muted) continue;
      this.patch('thunder', rel, r.bytes);
      rels.push(rel);
      muted += r.muted;
    }
    if (!rels.length) throw new Error('The thunder sounds in your game could not be changed.');
    this.w.thunder = { rels, muted };
    this.mgr.save();
    return this.thunder();
  }
}

/** clouds.xml with every cloud hat's spin, scroll, altitude scroll and animation off. */
function stillCloudsText(base) {
  const zero = (n) => n.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, (m) => (m.includes('.') ? '0.000000' : '0'));
  return base
    .replace(/(<mAngularVelocity\b[^>]*?)\/?>/g, (tag) => tag.replace(/(\b[xyz]\s*=\s*")([^"]*)(")/g, (m, a, v, b) => a + '0.000000' + b))
    .replace(/(<mUVVelocity\b[^>]*>)([\s\S]*?)(<\/mUVVelocity>)/g, (m, a, body, b) => a + zero(body) + b)
    .replace(/(<mAltitudeScrollScaler\s+value=")[^"]*(")/g, '$10.000000$2')
    .replace(/(<mEnableAnimations\s+value=")[^"]*(")/g, '$1false$2');
}

/** Snow in every weather: the amount, plus XMAS's falling-particle, mist and ground effects
 *  (the amount alone shows nothing on weathers whose effects are not snowy). */
function snowify(base, amount, stock = null) {
  const v = amount.toFixed(6);
  // Graphics packs often blank the snow effects (or drop the snowy weathers) in their own
  // weather.xml, so the effect names come from the game's own file first.
  const snowyItem = (text) => {
    const items = String(text || '').match(/<Item>[\s\S]*?<\/Item>/g) || [];
    return ['XMAS', 'BLIZZARD', 'SNOW', 'SNOWLIGHT'].map((n) => items.find((it) => new RegExp('<Name>\\s*' + n + '\\s*</Name>', 'i').test(it))).find(Boolean);
  };
  const effects = {};
  for (const src of [snowyItem(stock), snowyItem(base)]) {
    if (!src) continue;
    for (const tag of SNOW_EFFECTS) {
      const m = new RegExp('<' + tag + '>([^<]+)</' + tag + '>').exec(src);
      if (m && m[1].trim() && !effects[tag]) effects[tag] = m[1].trim();
    }
  }
  const setValue = (it, tag, val) => (new RegExp('<' + tag + '\\s+value=').test(it)
    ? it.replace(new RegExp('(<' + tag + '\\s+value=")[^"]*(")'), '$1' + val + '$2')
    : it.replace(/(<\/Name>)/, '$1<' + tag + ' value="' + val + '"/>')); // a pack that removed the line
  return base.replace(/<Item>[\s\S]*?<\/Item>/g, (it) => {
    let out = setValue(setValue(it, 'Snow', v), 'SnowMist', (amount * 0.6).toFixed(6));
    for (const [tag, val] of Object.entries(effects)) {
      if (new RegExp('<' + tag + '>[^<]*</' + tag + '>').test(out)) out = out.replace(new RegExp('(<' + tag + '>)[^<]*(</' + tag + '>)'), '$1' + val + '$2');
      else if (new RegExp('<' + tag + '\\s*/>').test(out)) out = out.replace(new RegExp('<' + tag + '\\s*/>'), '<' + tag + '>' + val + '</' + tag + '>');
      else out = out.replace(/(<\/Name>)/, '$1<' + tag + '>' + val + '</' + tag + '>');
    }
    return out;
  });
}

// Timecycle key hours: GTA's files have 9 or 13 boxes a day.
function keyHours(n) {
  if (n === 9) return [0, 5, 6, 7, 12, 17, 18, 19, 21];
  if (n === 13) return [0, 5, 6, 7, 9, 12, 15, 17, 18, 19, 20, 21, 22];
  return Array.from({ length: n }, (_, i) => (i * 24) / n);
}

/** sky_stars_iten in a timecycle: 'off' = no stars; 'on' = at least 1 at night. */
function starsText(text, mode) {
  return text.replace(/(<sky_stars_iten>)([^<]*)(<\/sky_stars_iten>)/g, (m, a, body, b) => {
    const vals = body.trim().split(/\s+/);
    const hrs = keyHours(vals.length);
    return a + vals.map((x, i) => {
      const n = Number(x);
      if (!Number.isFinite(n)) return x;
      if (mode === 'off') return '0.0000';
      const night = hrs[i] <= 4 || hrs[i] >= 20.5;
      return night ? String(Math.max(n, 1)) : x;
    }).join(' ') + b;
  });
}

module.exports = { WorldFiles, VS, WEATHER, CLOUDS, PED_LOD, GAME_PATHS, stillCloudsText, snowify, starsText };
