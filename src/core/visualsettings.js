'use strict';
// visualsettings.dat: one "name value" pair per line, with # or // comments that
// name the section below them. Edits replace only the value text, so the file's
// layout and every other line stay exactly as they were.

const LINE = /^(\s*)([A-Za-z_][\w.\-]*)([ \t]+)([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/;
const FAR_CLIP = 'misc.Multiplier.farClipMultiplier';

function parseVS(text) {
  const entries = [];
  let section = '';
  String(text).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) { section = ''; return; } // a blank line ends a section
    if (/^(#|\/\/)/.test(t)) { section = t.replace(/^(#|\/\/)\s*/, '').trim(); return; }
    const m = LINE.exec(line);
    if (m) entries.push({ line: i, key: m[2], value: Number(m[4]), section });
  });
  return entries;
}

/** Replace the values of the given keys (every line with that key). */
function setValues(text, changes) {
  const fmt = (v) => String(Number(Number(v).toFixed(6)));
  // split keeps each line ending as it was ("\n" or "\r\n")
  return String(text).split(/(\r?\n)/).map((part) => {
    const m = LINE.exec(part);
    if (!m || !(m[2] in changes)) return part;
    return m[1] + m[2] + m[3] + fmt(changes[m[2]]) + m[5];
  }).join('');
}

/** The lines a pack has put under a "black mountains" style heading, if any. */
function packMountainKeys(entries) {
  return entries.filter((e) => /black|mountain/i.test(e.section)).map((e) => e.key);
}

module.exports = { parseVS, setValues, packMountainKeys, FAR_CLIP };
