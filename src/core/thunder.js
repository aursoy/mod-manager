'use strict';
// Silent thunder: the thunder sound banks in GTA V's audio archives (x64/audio/sfx/*.rpf)
// get every sound replaced with a moment of silence. FiveM loads replaced audio
// archives from citizen/platform/audio/sfx, the same place the Sound Lab installs to.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const awc = require('./awc');
const { findInFile } = require('./rpfscan');

const IS_THUNDER = (name) => /\.awc$/i.test(name) && /thunder/i.test(name);
const SFX = ['x64', 'audio', 'sfx'];

/** The audio archives in the GTA V folder that hold thunder banks: [{ name, file, banks }]. */
function findThunder(gtaDir) {
  if (!gtaDir) return [];
  const dir = path.join(gtaDir, ...SFX);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.rpf$/i.test(n)); } catch (e) { return []; }
  const out = [];
  let locked = null;
  for (const n of names) {
    try {
      const hits = findInFile(path.join(dir, n), IS_THUNDER);
      if (hits.length) out.push({ name: n, file: path.join(dir, n), banks: hits.map((h) => h.path) });
    } catch (e) { if (e.code === rpf.NEED_KEYS) locked = e; }
  }
  if (!out.length && locked) throw locked;
  return out;
}

/** The archive with every thunder sound silenced. Returns { bytes, muted } (muted = sounds). */
function muteThunder(buf, label) {
  const root = rpf.readRpf(buf, label);
  let muted = 0;
  const scan = (node) => rpf.walk(node, (e) => {
    if (e.type !== 'bin') return;
    if (/\.rpf$/i.test(e.name)) {
      try { e.nested = rpf.readRpf(rpf.getBinaryData(e), e.name); scan(e.nested); } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; }
      return;
    }
    if (!IS_THUNDER(e.name)) return;
    const bank = awc.parseAwc(rpf.getBinaryData(e));
    if (bank.multichannel) return;
    for (const s of awc.describeAwc(bank)) {
      awc.replaceStream(bank, s.id, new Int16Array(64), s.rate || 22050);
      muted++;
    }
    rpf.setBinaryData(e, awc.writeAwc(bank), e.compressed);
  });
  scan(root);
  const rebuild = (node) => rpf.walk(node, (e) => {
    if (e.nested) { rebuild(e.nested); rpf.setBinaryData(e, rpf.writeRpf(e.nested), false); }
  });
  rebuild(root);
  return { bytes: rpf.writeRpf(root), muted };
}

const citizenRel = (name) => 'platform/audio/sfx/' + name;

module.exports = { findThunder, muteThunder, citizenRel, IS_THUNDER };
