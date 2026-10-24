'use strict';
// Mods folder manager, FiveM cache cleaner and setup presets.

const fs = require('fs');
const path = require('path');

const OFF = '.off';

// Async so scanning multi-GB cache folders never blocks the app.
async function dirSize(p) {
  let total = 0, files = 0;
  const walk = async (d) => {
    let list;
    try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    await Promise.all(list.map(async (e) => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) return walk(f);
      try { total += (await fs.promises.stat(f)).size; files++; } catch (err) { /* locked */ }
    }));
  };
  await walk(p);
  return { bytes: total, files };
}

// ---------- mods ----------
function listMods(modsPath) {
  if (!modsPath || !fs.existsSync(modsPath)) return [];
  return fs.readdirSync(modsPath, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.toLowerCase().endsWith('.rpf') || e.name.toLowerCase().endsWith('.rpf' + OFF)))
    .map((e) => {
      const st = fs.statSync(path.join(modsPath, e.name));
      const enabled = !e.name.toLowerCase().endsWith(OFF);
      return { file: e.name, name: enabled ? e.name : e.name.slice(0, -OFF.length), enabled, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function setModEnabled(modsPath, name, enabled) {
  const on = path.join(modsPath, name);
  const off = on + OFF;
  if (enabled && fs.existsSync(off)) fs.renameSync(off, on);
  if (!enabled && fs.existsSync(on)) fs.renameSync(on, off);
}

function addMods(modsPath, files) {
  fs.mkdirSync(modsPath, { recursive: true });
  const added = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.rpf')) throw new Error(path.basename(f) + ' is not an .rpf file.');
    const dest = path.join(modsPath, path.basename(f));
    if (path.resolve(dest) === path.resolve(f)) continue;
    fs.copyFileSync(f, dest);
    added.push(path.basename(f));
  }
  return added;
}

// ---------- cache ----------
const CACHE_TARGETS = [
  { id: 'cache', name: 'Game cache', rel: 'data/cache', desc: 'Downloaded game data. Rebuilds on next launch.' },
  { id: 'server', name: 'Server cache', rel: 'data/server-cache', desc: 'Streamed server assets. Fixes most texture loss.' },
  { id: 'serverpriv', name: 'Private server cache', rel: 'data/server-cache-priv', desc: 'Per-server streamed files.' },
  { id: 'nui', name: 'NUI storage', rel: 'data/nui-storage', desc: 'Browser storage for server UIs.' },
  { id: 'crashes', name: 'Crash dumps', rel: 'crashes', desc: 'Old crash reports.' },
  { id: 'logs', name: 'Logs', rel: 'logs', desc: 'FiveM log files.' },
];

function cacheInfo(appPath) {
  return Promise.all(CACHE_TARGETS.map(async (t) => {
    const p = path.join(appPath, ...t.rel.split('/'));
    return { ...t, path: p, ...(await dirSize(p)) };
  }));
}

async function clearCache(appPath, ids) {
  let freed = 0;
  const failed = [];
  for (const t of CACHE_TARGETS.filter((x) => ids.includes(x.id))) {
    const p = path.join(appPath, ...t.rel.split('/'));
    freed += (await dirSize(p)).bytes;
    try {
      await fs.promises.rm(p, { recursive: true, force: true });
      await fs.promises.mkdir(p, { recursive: true });
    } catch (e) {
      failed.push(t.name);
    }
  }
  if (failed.length) throw new Error('Close FiveM first. Could not clear: ' + failed.join(', '));
  return freed;
}

module.exports = { listMods, setModEnabled, addMods, cacheInfo, clearCache, dirSize, CACHE_TARGETS };
