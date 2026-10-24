'use strict';
// Citizen folder manager: every write is journaled with a backup of the
// original file, so any tweak, pack or colour grade can be undone exactly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KNOWN_TARGETS = {
  // Water
  'water.xml': 'common/data/levels/gta5/water.xml',

  // Visual settings & popcycle
  'visualsettings.dat': 'common/data/visualsettings.dat',
  'popcycle.dat': 'common/data/levels/gta5/popcycle.dat',
  'materials.dat': 'common/data/materials/materials.dat',
  'surfacebounds.dat': 'common/data/materials/surfacebounds.dat',
  'hudcolor.dat': 'common/data/ui/hudcolor.dat',
  'pedpersonality.dat': 'common/data/pedpersonality.dat',

  // Environment / atmosphere / weather
  'clouds.xml': 'common/data/clouds.xml',
  'skydome.xml': 'common/data/skydome.xml',
  'fogdata.xml': 'common/data/fogdata.xml',
  'pedbounds.xml': 'common/data/pedbounds.xml',
  'gametimescaling.xml': 'common/data/gametimescaling.xml',

  // Vehicles / meta
  'carcols.meta': 'common/data/carcols.meta',
  'carvariations.meta': 'common/data/carvariations.meta',
  'handling.meta': 'common/data/handling.meta',
  'vehicles.meta': 'common/data/levels/gta5/vehicles.meta',

  // Weapons
  'weapons.meta': 'common/data/ai/weapons.meta',
  'weaponarchetypes.meta': 'common/data/weaponarchetypes.meta',
  'weaponcomponents.meta': 'common/data/weaponcomponents.meta',
  'weaponanimations.meta': 'common/data/weaponanimations.meta',
  'explosion.meta': 'common/data/effects/explosion.meta',
};

const IGNORED_EXTENSIONS = new Set(['.txt', '.url', '.md', '.rtf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ini', '.db', '.pdf']);
const IGNORED_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini', '.gitignore', '.gitattributes', '.editorconfig']);
function isIgnored(filename) {
  const base = path.basename(filename).toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (base.startsWith('.')) return true;
  if (IGNORED_NAMES.has(base) || base.startsWith('._')) return true;
  if (IGNORED_EXTENSIONS.has(ext)) return true;
  const normPath = filename.replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)(\.git|\.github|__macosx|node_modules)(?:$|\/)/i.test(normPath)) return true;
  return false;
}

// One tiny invisible quad far below the map: keeps the file well-formed
// while removing every ocean, lake and river quad.
const NO_WATER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<WaterData>
  <WaterQuads>
    <Item>
      <minX value="-8000" />
      <maxX value="-7990" />
      <minY value="-8000" />
      <maxY value="-7990" />
      <Type value="0" />
      <IsInvisible value="true" />
      <HasLimitedDepth value="false" />
      <z value="-2000.0" />
      <a1 value="26" />
      <a2 value="26" />
      <a3 value="26" />
      <a4 value="26" />
      <NoStencil value="false" />
    </Item>
  </WaterQuads>
  <CalmingQuads />
  <WaveQuads />
</WaterData>
`;

const BUILTIN_TWEAKS = {
  water: {
    id: 'water',
    name: 'Water',
    description: 'Strips every ocean, lake and river quad from the map. Switch back to restore the stock water.',
    offLabel: 'Visible',
    onLabel: 'Removed',
    generated: { 'common/data/levels/gta5/water.xml': NO_WATER_XML },
  },
  mountains: {
    id: 'mountains',
    name: 'Black Mountains',
    description: 'Load the black-mountain files from your graphics pack once, then flip between removed and visible any time.',
    offLabel: 'Visible',
    onLabel: 'Removed',
  },
  trees: {
    id: 'trees',
    name: 'Trees',
    description: 'Load the tree-removal files from your graphics pack once, then flip trees between removed and visible any time.',
    offLabel: 'Visible',
    onLabel: 'Removed',
  },
  bushes: {
    id: 'bushes',
    name: 'Bushes',
    description: 'Load the bush and grass removal files from your graphics pack once, then flip them between removed and visible.',
    offLabel: 'Visible',
    onLabel: 'Removed',
  },
  props: {
    id: 'props',
    name: 'Props',
    description: 'Load the prop-removal files from your graphics pack once, then flip props between removed and visible.',
    offLabel: 'Visible',
    onLabel: 'Removed',
  },
};

const COLOUR_GROUPS = {
  sky: /^(sky_|cloud_|sun_col|moon_col)/i,
  light: /^(light_|lightning|dir_col)/i,
  fog: /^(fog_|haze_)/i,
  ambient: /^(ambient_|amb_|ped_light|light_natural_amb|light_artificial)/i,
  postfx: /^(postfx_|nv_)/i,
};

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const norm = (rel) => rel.replace(/\\/g, '/').replace(/^\/+/, '');

function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) listFiles(p, base, out);
    else out.push(norm(path.relative(base, p)));
  }
  return out;
}

/** Fast capped walk for dashboard stats. A full recursive walk of a live
 *  FiveM citizen folder (tens of thousands of files) blocks the Electron
 *  main process for seconds and leaves the renderer stuck on the splash. */
function quickStats(root) {
  let fileCount = 0;
  let bytes = 0;
  const stack = [root];
  const hardLimit = 8000;
  while (stack.length && fileCount < hardLimit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === 'node_modules' || d.name === '.git' || d.name === 'cache') continue;
        stack.push(p);
      } else {
        fileCount++;
        try { bytes += fs.statSync(p).size; } catch (e) { /* ignore */ }
        if (fileCount >= hardLimit) break;
      }
    }
  }
  return { fileCount, bytes, truncated: fileCount >= hardLimit };
}

/** Only probe known timecycle locations instead of every XML under common/data. */
function countTimecycleFiles(citizenPath) {
  const candidates = [
    path.join(citizenPath, 'common', 'data', 'timecycle'),
    path.join(citizenPath, 'common', 'data', 'levels', 'gta5'),
  ];
  let n = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const d of entries) {
      if (d.isFile() && d.name.toLowerCase().endsWith('.xml')) n++;
    }
  }
  const dataDir = path.join(citizenPath, 'common', 'data');
  if (fs.existsSync(dataDir)) {
    try {
      for (const d of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (d.isFile() && /^(w_|timecycle|weather)/i.test(d.name) && d.name.toLowerCase().endsWith('.xml')) n++;
      }
    } catch (e) { /* ignore */ }
  }
  return n;
}

class CitizenManager {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.statePath = path.join(userDataDir, 'state.json');
    this.state = { citizenPath: null, tweaks: {}, custom: [], owners: {}, journal: {}, colour: null, colourBase: {}, history: [], presets: [], profile: null };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.statePath, 'utf8'))); } catch (e) { /* first run */ }
    if (!this.state.citizenPath || !fs.existsSync(this.state.citizenPath)) {
      const auto = CitizenManager.autodetect();
      if (auto) {
        this.state.citizenPath = auto;
        try { this.save(); } catch (err) {}
      }
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  log(type, text) {
    this.state.history.unshift({ t: Date.now(), type, text });
    this.state.history = this.state.history.slice(0, 200);
  }

  // ---------- citizen folder ----------
  static resolveCitizen(dir) {
    if (!dir) return null;
    const candidates = [
      dir,
      path.join(dir, 'citizen'),
      path.join(dir, 'FiveM.app', 'citizen'),
      path.join(dir, 'FiveM.app'),
      path.dirname(dir),
    ];
    for (const c of candidates) {
      if (!c || !fs.existsSync(c)) continue;
      if (fs.existsSync(path.join(c, 'common')) || fs.existsSync(path.join(c, 'platform'))) return c;
    }
    return null;
  }

  static autodetect() {
    const local = process.env.LOCALAPPDATA;
    const candidates = [];
    if (local) {
      candidates.push(path.join(local, 'FiveM', 'FiveM.app', 'citizen'));
      candidates.push(path.join(local, 'FiveM', 'FiveM.app'));
      candidates.push(path.join(local, 'FiveM'));
    }
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'FiveM', 'FiveM.app', 'citizen'));
    }
    for (const cand of candidates) {
      const res = CitizenManager.resolveCitizen(cand);
      if (res) return res;
    }
    return null;
  }

  setCitizen(dir) {
    const c = CitizenManager.resolveCitizen(dir);
    if (!c) throw new Error('That folder does not look like a FiveM citizen folder (no "common" or "platform" inside).');
    if (this.state.citizenPath && path.resolve(this.state.citizenPath) !== path.resolve(c) && Object.keys(this.state.journal).length) {
      throw new Error('Restore all changes on the current citizen folder before switching to another one.');
    }
    this.state.citizenPath = c;
    this.log('info', 'Citizen folder set to ' + c);
    this.save();
    return this.info();
  }

  requireCitizen() {
    let c = this.state.citizenPath;
    if (!c || !fs.existsSync(c)) {
      const auto = CitizenManager.autodetect();
      if (auto) {
        this.state.citizenPath = auto;
        try { this.save(); } catch (err) {}
        c = auto;
      }
    }
    if (!c || !fs.existsSync(c)) throw new Error('Select your citizen folder first.');
    return c;
  }

  info() {
    const c = this.state.citizenPath;
    if (!c || !fs.existsSync(c)) return { citizenPath: null };
    let fileCount = 0;
    let bytes = 0;
    try {
      const stats = quickStats(c);
      fileCount = stats.fileCount;
      bytes = stats.bytes;
    } catch (e) { /* ignore */ }
    const app = path.dirname(c);
    const exe = path.join(path.dirname(app), 'FiveM.exe');
    let timecycle = 0;
    try {
      timecycle = countTimecycleFiles(c);
    } catch (e) { /* ignore */ }
    return {
      citizenPath: c,
      modsPath: path.join(app, 'mods'),
      fiveMExe: fs.existsSync(exe) ? exe : null,
      fileCount,
      bytes,
      backups: Object.keys(this.state.journal).length,
      timecycle,
    };
  }

  // ---------- journaled writes ----------
  backupPath(rel) { return path.join(this.dir, 'backups', ...norm(rel).split('/')); }

  ensureBackup(rel) {
    rel = norm(rel);
    if (this.state.journal[rel]) return;
    const abs = path.join(this.requireCitizen(), rel);
    const existed = fs.existsSync(abs);
    if (existed) {
      const b = this.backupPath(rel);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(abs, b);
    }
    this.state.journal[rel] = { existed, at: Date.now() };
  }

  writeFile(rel, data, owner) {
    rel = norm(rel);
    this.ensureBackup(rel);
    const abs = path.join(this.requireCitizen(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    if (owner) this.state.owners[rel] = owner;
  }

  restoreFile(rel) {
    rel = norm(rel);
    const j = this.state.journal[rel];
    if (!j) return;
    const abs = path.join(this.requireCitizen(), rel);
    if (j.existed) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(this.backupPath(rel), abs);
      fs.rmSync(this.backupPath(rel), { force: true });
    } else {
      fs.rmSync(abs, { force: true });
    }
    delete this.state.journal[rel];
    delete this.state.owners[rel];
    delete this.state.colourBase[rel];
  }

  // ---------- tweaks / packs ----------
  libraryDir(id) { return path.join(this.dir, 'library', id); }

  tweakDefs() {
    return [...Object.values(BUILTIN_TWEAKS), ...this.state.custom];
  }

  listTweaks() {
    return this.tweakDefs().map((t) => {
      const lib = this.libraryDir(t.id);
      const files = fs.existsSync(lib) ? listFiles(lib) : [];
      const generated = t.generated ? Object.keys(t.generated) : [];
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        kind: t.kind || 'tweak',
        builtin: !!BUILTIN_TWEAKS[t.id],
        onLabel: t.onLabel || 'Installed',
        offLabel: t.offLabel || 'Off',
        enabled: !!(this.state.tweaks[t.id] && this.state.tweaks[t.id].enabled),
        files: files.length ? files : generated,
        hasFiles: files.length > 0 || generated.length > 0,
        customFiles: files.length > 0,
      };
    });
  }

    /** Copy files from a folder / zip / list of files into a tweak's library. */
  importFiles(id, sources) {
    const lib = this.libraryDir(id);
    const staged = [];
    const AdmZip = require('adm-zip');

    const readHead = (src) => {
      try {
        const fd = fs.openSync(src, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        return buf.slice(0, bytesRead).toString('utf8');
      } catch (e) {
        return '';
      }
    };

    const mapEntry = (fullPathOrRel, getSample) => {
      const n = norm(fullPathOrRel);
      if (isIgnored(n)) return null;
      // If citizen/ is in the path, strip up to citizen/
      const citMatch = n.match(/(?:^|\/)citizen\/(.*)$/i);
      if (citMatch) return citMatch[1];
      // If common/ or platform/ is in the path, keep from there
      const cpMatch = n.match(/(?:^|\/)(common|platform)\/(.*)$/i);
      if (cpMatch) return cpMatch[1].toLowerCase() + '/' + cpMatch[2];
      // If timecycle/ is in the path
      const tcMatch = n.match(/(?:^|\/)timecycle\/(.*)$/i);
      if (tcMatch) return 'common/data/timecycle/' + tcMatch[1];
      // If levels/gta5/ is in the path
      const lvMatch = n.match(/(?:^|\/)levels\/gta5\/(.*)$/i);
      if (lvMatch) return 'common/data/levels/gta5/' + lvMatch[1];
      // If data/ is in the path
      const dataMatch = n.match(/(?:^|\/)data\/(.*)$/i);
      if (dataMatch) return 'common/data/' + dataMatch[1];
      // Otherwise map as loose filename with sample
      return this.mapLoose(path.basename(n), getSample ? getSample() : '');
    };

    for (const src of sources) {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        const baseName = path.basename(src).toLowerCase();
        let folderPrefix = '';
        if (baseName === 'common' || baseName === 'platform') {
          folderPrefix = baseName + '/';
        }
        const allFiles = listFiles(src);
        for (const f of allFiles) {
          if (isIgnored(f)) continue;
          const abs = path.join(src, f);
          const candidate = folderPrefix ? folderPrefix + f : f;
          const rel = mapEntry(candidate, () => readHead(abs));
          if (rel) staged.push({ rel, from: abs });
        }
      } else if (src.toLowerCase().endsWith('.zip')) {
        const zip = new AdmZip(src);
        const entries = zip.getEntries().filter((e) => !e.isDirectory);
        for (const e of entries) {
          const n = norm(e.entryName);
          if (isIgnored(n)) continue;
          const rel = mapEntry(n, () => e.getData().slice(0, 4096).toString('utf8'));
          if (rel) staged.push({ rel, data: e.getData() });
        }
      } else {
        if (!isIgnored(src)) {
          const rel = mapEntry(path.basename(src), () => readHead(src));
          if (rel) staged.push({ rel, from: src });
        }
      }
    }
    if (!staged.length) throw new Error('No mod files found to import.');
    for (const s of staged) {
      if (s.rel.includes('..')) throw new Error('Refusing unsafe path ' + s.rel);
    }
    fs.rmSync(lib, { recursive: true, force: true });
    for (const s of staged) {
      const dest = path.join(lib, ...s.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (s.data) fs.writeFileSync(dest, s.data);
      else fs.copyFileSync(s.from, dest);
    }
    this.log('info', 'Loaded ' + staged.length + ' file(s) into ' + id);
    this.save();
    return staged.length;
  }

  mapLoose(name, sample = '') {
    if (isIgnored(name)) return null;
    const lower = name.toLowerCase();
    if (KNOWN_TARGETS[lower]) return KNOWN_TARGETS[lower];
    if (/^(w_.*|timecycle.*)\.xml$/.test(lower)) return 'common/data/timecycle/' + name;

    const sampleStr = typeof sample === 'string' ? sample : (Buffer.isBuffer(sample) ? sample.slice(0, 4096).toString('utf8') : '');
    if (sampleStr && /timecycle|<region|_col_r>|<modifier/i.test(sampleStr)) {
      return 'common/data/timecycle/' + name;
    }

    if (lower.endsWith('.xml')) {
      if (/cycle|weather|grade|tc|jay/i.test(lower)) {
        return 'common/data/timecycle/' + name;
      }
      return 'common/data/' + name;
    }

    if (lower.endsWith('.dat')) return 'common/data/' + name;
    if (lower.endsWith('.meta')) return 'common/data/' + name;
    if (lower.endsWith('.ymap') || lower.endsWith('.ytyp')) return 'common/data/levels/gta5/' + name;
    if (lower.endsWith('.ytd') || lower.endsWith('.ydr') || lower.endsWith('.yft')) return 'platform/data/cdimages/' + name;

    if (lower.includes('.')) {
      return 'common/data/' + name;
    }

    throw new Error('Not sure where "' + name + '" belongs. Import a folder that contains a citizen/ (or common/) structure instead.');
  }

  addCustom(name, sources, kind = 'pack') {
    const id = 'custom_' + crypto.randomBytes(4).toString('hex');
    this.state.custom.push({ id, name, kind, description: kind === 'pack' ? 'Graphics pack' : 'Custom tweak' });
    try {
      this.importFiles(id, sources);
    } catch (e) {
      this.state.custom = this.state.custom.filter((c) => c.id !== id);
      throw e;
    }
    this.save();
    return id;
  }

  removeCustom(id) {
    if (this.state.tweaks[id] && this.state.tweaks[id].enabled) this.setTweak(id, false);
    this.state.custom = this.state.custom.filter((c) => c.id !== id);
    fs.rmSync(this.libraryDir(id), { recursive: true, force: true });
    delete this.state.tweaks[id];
    this.save();
  }

  setTweak(id, enabled) {
    this.requireCitizen();
    const def = this.tweakDefs().find((t) => t.id === id);
    if (!def) throw new Error('Unknown tweak ' + id);
    const cur = this.state.tweaks[id] || { enabled: false, files: [] };
    if (enabled === cur.enabled) return { tweaks: this.listTweaks(), conflicts: [] };
    const conflicts = [];
    if (enabled) {
      const lib = this.libraryDir(id);
      const payload = {};
      if (fs.existsSync(lib)) for (const f of listFiles(lib)) payload[f] = fs.readFileSync(path.join(lib, ...f.split('/')));
      else if (def.generated) for (const [k, v] of Object.entries(def.generated)) payload[k] = Buffer.from(v);
      if (!Object.keys(payload).length) throw new Error('Load the files for "' + def.name + '" first.');
      for (const [rel, data] of Object.entries(payload)) {
        const owner = this.state.owners[rel];
        if (owner && owner !== id) conflicts.push(rel);
        this.writeFile(rel, data, id);
      }
      this.state.tweaks[id] = { enabled: true, files: Object.keys(payload) };
      this.log('success', def.name + ' ' + (def.onLabel || 'enabled').toLowerCase());
    } else {
      for (const rel of cur.files) {
        if (this.state.owners[rel] === id) this.restoreFile(rel);
      }
      this.state.tweaks[id] = { enabled: false, files: [] };
      this.log('success', def.name + ' ' + (def.offLabel || 'disabled').toLowerCase());
    }
    this.save();
    return { tweaks: this.listTweaks(), conflicts };
  }

  // ---------- timecycle editor ----------
  /** Resolve a citizen-relative XML path, refusing anything outside the folder. */
  timecyclePath(rel) {
    rel = norm(String(rel || ''));
    if (!rel.toLowerCase().endsWith('.xml') || rel.split('/').includes('..')) throw new Error('Not a timecycle file: ' + rel);
    const root = path.resolve(this.requireCitizen());
    const abs = path.resolve(root, ...rel.split('/'));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Not a timecycle file: ' + rel);
    return { rel, abs };
  }

  readTimecycle(rel, { stock = false } = {}) {
    const { rel: r, abs } = this.timecyclePath(rel);
    // "stock" = the file as it was before this app first changed it.
    if (stock && this.state.journal[r] && this.state.journal[r].existed && fs.existsSync(this.backupPath(r))) {
      return fs.readFileSync(this.backupPath(r), 'utf8');
    }
    if (!fs.existsSync(abs)) throw new Error('Timecycle file not found: ' + r);
    return fs.readFileSync(abs, 'utf8');
  }

  /** Save an edited timecycle into citizen. Journaled, so Backups can undo it. */
  writeTimecycle(rel, xml) {
    const { rel: r } = this.timecyclePath(rel);
    if (typeof xml !== 'string' || !/<[a-z_]/i.test(xml)) throw new Error('That does not look like timecycle XML.');
    this.writeFile(r, xml, this.state.owners[r] || 'timecycle_edit');
    // The colour grader keeps its own base copy of each file; drop it so the next grade starts from this edit.
    delete this.state.colourBase[r];
    this.log('success', 'Saved ' + path.basename(r) + ' from the timecycle editor');
    this.save();
    return r;
  }

  /** Make a new graphics pack out of in-memory files. It starts switched off. */
  createPack(name, files) {
    const entries = Object.entries(files || {});
    if (!entries.length) throw new Error('A pack needs at least one file.');
    for (const [rel] of entries) {
      if (norm(rel).split('/').includes('..') || path.isAbsolute(rel)) throw new Error('Refusing unsafe path ' + rel);
    }
    const id = 'custom_' + crypto.randomBytes(4).toString('hex');
    const lib = this.libraryDir(id);
    for (const [rel, data] of entries) {
      const dest = path.join(lib, ...norm(rel).split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    this.state.custom.push({ id, name: String(name || 'Custom pack').slice(0, 60), kind: 'pack', description: 'Graphics pack' });
    this.log('info', 'Created graphics pack "' + name + '" with ' + entries.length + ' file(s)');
    this.save();
    return id;
  }

  // ---------- colour grading ----------
  scanTimecycle() {
    const c = this.state.citizenPath;
    const files = [];
    const items = [];
    if (!c || !fs.existsSync(c)) return { files, items };
    const dir = path.join(c, 'common', 'data');
    if (!fs.existsSync(dir)) return { files, items };
    const seen = new Set();
    for (const f of listFiles(dir)) {
      if (!f.toLowerCase().endsWith('.xml')) continue;
      const rel = 'common/data/' + f;
      if (seen.has(rel)) continue;
      const abs = path.join(c, rel);
      let head = '';
      try { head = fs.readFileSync(abs, 'utf8').slice(0, 4096); } catch (e) { continue; }
      if (/timecycle|<region|_col_r>|<modifier/i.test(head)) {
        seen.add(rel);
        files.push(rel);
        const cycles = [];
        for (const m of head.matchAll(/<(?:cycle|modifier)\s+name="([^"]+)"/gi)) {
          cycles.push(m[1]);
        }
        items.push({
          rel,
          name: path.basename(rel),
          cycles: cycles.slice(0, 6),
          cycleCount: cycles.length,
          isWeather: /^(w_.*|jay.*)\.xml$/i.test(path.basename(rel)) || cycles.includes('EXTRASUNNY') || cycles.includes('CLEAR'),
        });
      }
    }
    return { files, items };
  }

  colourBase(rel) {
    const abs = path.join(this.requireCitizen(), rel);
    const now = fs.readFileSync(abs);
    const base = this.state.colourBase[rel];
    const basePath = path.join(this.dir, 'colourbase', ...rel.split('/'));
    // Re-capture the base if something else changed the file since we last wrote it.
    if (!base || base.written !== sha1(now) || !fs.existsSync(basePath)) {
      fs.mkdirSync(path.dirname(basePath), { recursive: true });
      fs.writeFileSync(basePath, now);
      if (!this.state.colourBase[rel]) this.state.colourBase[rel] = {};
      this.state.colourBase[rel].written = sha1(now);
      return now.toString('utf8');
    }
    return fs.readFileSync(basePath, 'utf8');
  }

  activateTimecycle(rel) {
    const c = this.requireCitizen();
    const abs = path.join(c, rel);
    if (!fs.existsSync(abs)) throw new Error('Timecycle file not found: ' + rel);
    const content = fs.readFileSync(abs);
    const targets = [
      'common/data/timecycle/w_extrasunny.xml',
      'common/data/timecycle/w_clear.xml',
    ];
    for (const t of targets) {
      this.writeFile(t, content, 'timecycle_active');
    }
    this.log('success', 'Activated ' + path.basename(rel) + ' as primary FiveM weather (w_extrasunny & w_clear)');
    this.save();
    return { activated: targets, source: path.basename(rel) };
  }

  /** opts: { r,g,b (0-255), strength 0-1, brightness -1..1, groups:[...], target?: string, activateWeather?: boolean } */
  applyColour(opts) {
    const { files, items } = this.scanTimecycle();
    if (!files.length) throw new Error('No timecycle files found in citizen/common/data. Install a graphics pack first.');
    const targetFiles = (opts.target && opts.target !== '__all__') ? [opts.target] : files;
    const groups = (opts.groups && opts.groups.length ? opts.groups : Object.keys(COLOUR_GROUPS)).map((g) => COLOUR_GROUPS[g]).filter(Boolean);
    const avg = (opts.r + opts.g + opts.b) / 3 || 1;
    const s = Math.max(0, Math.min(1, opts.strength));
    const bright = 1 + Math.max(-1, Math.min(1, opts.brightness || 0)) * 0.5;
    const factor = {
      r: (1 + s * (opts.r / avg - 1)) * bright,
      g: (1 + s * (opts.g / avg - 1)) * bright,
      b: (1 + s * (opts.b / avg - 1)) * bright,
    };
    let tags = 0;
    let lastOut = null;
    for (const rel of targetFiles) {
      if (!fs.existsSync(path.join(this.requireCitizen(), rel))) continue;
      const src = this.colourBase(rel);
      const out = src.replace(/<([a-z0-9_]+?)_(r|g|b)>([^<]*)<\/\1_\2>/gi, (m, name, ch, body) => {
        const key = name.toLowerCase();
        if (!/col$|colour$|color$|_col_?/.test(key + '_')) return m;
        if (!groups.some((g) => g.test(key))) return m;
        tags++;
        const f = factor[ch.toLowerCase()];
        const vals = body.trim().split(/\s+/).map((x) => {
          const n = parseFloat(x);
          return Number.isFinite(n) ? (n * f).toFixed(6).replace(/\.?0+$/, '') : x;
        });
        return '<' + name + '_' + ch + '>' + vals.join(' ') + '</' + name + '_' + ch + '>';
      });
      lastOut = out;
      this.writeFile(rel, out, this.state.owners[rel] || 'colour');
      if (!this.state.colourBase[rel]) this.state.colourBase[rel] = {};
      this.state.colourBase[rel].written = sha1(Buffer.from(out));
    }

    let activated = false;
    if (opts.activateWeather || targetFiles.some(f => /jay\.xml$/i.test(f))) {
      if (lastOut) {
        this.writeFile('common/data/timecycle/w_extrasunny.xml', lastOut, 'colour');
        this.writeFile('common/data/timecycle/w_clear.xml', lastOut, 'colour');
        activated = true;
      }
    }

    this.state.colour = { ...opts, at: Date.now() };
    this.log('success', 'Colour grade applied to ' + targetFiles.length + ' file(s), ' + tags + ' colour values' + (activated ? ' (activated as FiveM weather)' : ''));
    this.save();
    return { files: targetFiles.length, tags, activated };
  }

  resetColour() {
    const c = this.requireCitizen();
    let n = 0;
    for (const rel of Object.keys(this.state.colourBase)) {
      const basePath = path.join(this.dir, 'colourbase', ...rel.split('/'));
      if (fs.existsSync(basePath)) {
        fs.writeFileSync(path.join(c, rel), fs.readFileSync(basePath));
        fs.rmSync(basePath, { force: true });
        n++;
      }
      if (this.state.owners[rel] === 'colour') this.restoreFile(rel);
    }
    this.state.colourBase = {};
    this.state.colour = null;
    this.log('success', 'Colour grade reset');
    this.save();
    return n;
  }

  // ---------- presets ----------
  listPresets() { return this.state.presets || []; }

  savePreset(name, mods) {
    const p = {
      id: 'p_' + crypto.randomBytes(4).toString('hex'),
      name,
      at: Date.now(),
      tweaks: Object.entries(this.state.tweaks).filter(([, t]) => t.enabled).map(([id]) => id),
      colour: this.state.colour,
      mods: mods || null,
    };
    this.state.presets = [p, ...this.listPresets()];
    this.log('success', 'Saved preset "' + name + '"');
    this.save();
    return p;
  }

  deletePreset(id) {
    this.state.presets = this.listPresets().filter((p) => p.id !== id);
    this.save();
  }

  /** Switch tweaks and colour to match a preset. Mods are handled by the caller. */
  applyPreset(id) {
    const p = this.listPresets().find((x) => x.id === id);
    if (!p) throw new Error('Preset not found');
    const known = new Set(this.tweakDefs().map((t) => t.id));
    // Turn things off first so restores happen before new files land.
    for (const t of this.tweakDefs()) if (!p.tweaks.includes(t.id)) this.setTweak(t.id, false);
    for (const id2 of p.tweaks) if (known.has(id2)) this.setTweak(id2, true);
    if (p.colour) this.applyColour(p.colour);
    else if (this.state.colour) this.resetColour();
    this.log('success', 'Applied preset "' + p.name + '"');
    this.save();
    return p;
  }

  // ---------- profile ----------
  getProfile() { return this.state.profile || { name: '', avatar: '', discordClientId: '', discord: null }; }

  setProfile(patch) {
    this.state.profile = { ...this.getProfile(), ...patch };
    this.save();
    return this.state.profile;
  }

  // ---------- backups ----------
  listBackups() {
    return Object.entries(this.state.journal).map(([rel, j]) => ({ rel, existed: j.existed, at: j.at, owner: this.state.owners[rel] || null }));
  }

  restoreAll() {
    this.requireCitizen();
    const n = Object.keys(this.state.journal).length;
    for (const rel of Object.keys(this.state.journal)) this.restoreFile(rel);
    for (const id of Object.keys(this.state.tweaks)) this.state.tweaks[id] = { enabled: false, files: [] };
    fs.rmSync(path.join(this.dir, 'colourbase'), { recursive: true, force: true });
    this.state.colourBase = {};
    this.state.colour = null;
    this.log('warning', 'Restored ' + n + ' file(s) to stock');
    this.save();
    return n;
  }
}

module.exports = { CitizenManager, NO_WATER_XML, COLOUR_GROUPS };
