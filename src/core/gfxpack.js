'use strict';
// A graphics pack dropped into the Pack AI chat. It is staged in memory (paths
// for folders, bytes for zip entries) so the AI can build a new pack on top of
// it without touching the original or citizen.

const fs = require('fs');
const path = require('path');

const TC_SNIFF = /_col_r>|<cycle\s+name=|<region\s+name=|timecycle_keyframe_data/i;
const WEATHER_NAMES = /^(w_|weather)/i;

function readStaged(s) {
  return s.data ? Buffer.from(s.data) : fs.readFileSync(s.from);
}

/** staged: [{ rel, from } | { rel, data }] from CitizenManager.stageSources */
function describePack(name, staged) {
  const timecycles = [];
  const weather = [];
  let skydome = null;
  let bytes = 0;
  for (const s of staged) {
    const size = s.data ? s.data.length : (() => { try { return fs.statSync(s.from).size; } catch (e) { return 0; } })();
    bytes += size;
    const base = path.basename(s.rel).toLowerCase();
    if (base === 'skydome.ytd' && !skydome) skydome = s.rel;
    if (!base.endsWith('.xml') || size > 16 * 1048576) continue;
    const inTcDir = /(^|\/)timecycle\//i.test(s.rel);
    let head = '';
    if (!inTcDir) { try { head = readStaged(s).subarray(0, 8192).toString('utf8'); } catch (e) { /* unreadable */ } }
    if (!inTcDir && !TC_SNIFF.test(head)) continue;
    timecycles.push(s.rel);
    if (WEATHER_NAMES.test(base)) weather.push(s.rel);
  }
  return { name, count: staged.length, bytes, timecycles, weather, skydome };
}

/** The timecycle files the AI should edit: the weather files, or every timecycle when none are named w_*. */
function editableTimecycles(staged, info) {
  const pick = new Set(info.weather.length ? info.weather : info.timecycles);
  const out = {};
  for (const s of staged) if (pick.has(s.rel)) out[s.rel] = readStaged(s).toString('utf8');
  return out;
}

/** Files for a new pack: everything from the dropped pack, then the AI's edits on top. */
function mergeForPack(staged, edits, extra = {}) {
  const files = {};
  for (const s of staged || []) files[s.rel] = s.data ? Buffer.from(s.data) : { from: s.from };
  for (const [rel, v] of Object.entries(edits || {})) files[rel] = v;
  for (const [rel, v] of Object.entries(extra)) files[rel] = v;
  return files;
}

/** Install a new pack (switched on unless opts.enable === false), then flip each world
 *  switch. Switches whose files are missing are reported, not fatal. */
function createPackWithTweaks(mgr, name, edits, tweaks = {}, opts = {}) {
  const files = mergeForPack(opts.staged || [], edits, opts.extra || {});
  const id = Object.keys(files).length ? mgr.createPack(name, files) : null;
  const applied = [];
  const skipped = [];
  let conflicts = [];
  if (id && opts.enable !== false) conflicts = mgr.setTweak(id, true).conflicts;
  for (const [tid, on] of Object.entries(tweaks || {})) {
    try {
      conflicts = conflicts.concat(mgr.setTweak(tid, on).conflicts);
      applied.push(tid);
    } catch (e) {
      skipped.push({ id: tid, reason: e.message });
    }
  }
  mgr.log('success', (id ? 'Installed pack "' : 'Applied "') + name + '"');
  mgr.save();
  return { id, applied, skipped, conflicts };
}

module.exports = { describePack, editableTimecycles, mergeForPack, readStaged, createPackWithTweaks };
