'use strict';
// Sound pack session: open audio RPFs (WEAPONS_PLAYER, RESIDENT, ...), browse
// their .awc banks, replace streams with new PCM, and write the archives back.

const fs = require('fs');
const path = require('path');
const rpf = require('./rpf');
const awc = require('./awc');

function categorize(archiveName, bankPath) {
  const s = (archiveName + '/' + bankPath).toLowerCase();
  const name = path.basename(bankPath).toLowerCase();
  if (/foot|feet|step|shoe|_land|jump/.test(name)) return 'footsteps';
  if (/frontend|hud|hit|kill|death|headshot|ui_|beep|menu|notify|ping|marker|ped_damage|bullet_impact|impacts/.test(name)) return 'kill';
  if (/weapon|gun|pistol|rifle|smg|shotgun|sniper|mg_|minigun|spl_|reload|shell|cock|silenc|explos/.test(s)) return 'guns';
  return 'other';
}

class SoundPack {
  constructor() {
    this.archives = [];
    this.banks = [];
  }

  open(file) {
    const already = this.archives.find((a) => path.resolve(a.file) === path.resolve(file));
    if (already) return this.describe();
    const root = rpf.readRpf(fs.readFileSync(file), path.basename(file));
    const archive = { id: this.archives.length, file, name: path.basename(file), root };
    const before = this.banks.length;
    const scan = (node, prefix) => {
      rpf.walk(node, (entry, p) => {
        const full = prefix ? prefix + '/' + p : p;
        const ext = path.extname(entry.name).toLowerCase();
        if (entry.type !== 'bin') return;
        if (ext === '.rpf') {
          try { entry.nested = rpf.readRpf(rpf.getBinaryData(entry), entry.name); scan(entry.nested, full); } catch (e) { if (e.code === rpf.NEED_KEYS) throw e; }
        } else if (ext === '.awc') {
          this.banks.push({
            id: this.banks.length, archiveId: archive.id, path: full, entry,
            name: path.basename(entry.name, '.awc'), category: categorize(archive.name, full),
            size: entry.size, edits: new Map(), parsed: null, error: null,
          });
        }
      });
    };
    scan(root, '');
    if (this.banks.length === before) throw new Error('No .awc sound banks inside ' + archive.name + '.');
    this.archives.push(archive);
    return this.describe();
  }

  close(archiveId) {
    this.archives = this.archives.filter((a) => a.id !== archiveId);
    this.banks = this.banks.filter((b) => b.archiveId !== archiveId);
    return this.describe();
  }

  describe() {
    return {
      archives: this.archives.map((a) => ({ id: a.id, name: a.name, file: a.file, banks: this.banks.filter((b) => b.archiveId === a.id).length, edits: this.editCount(a.id) })),
      banks: this.banks.map((b) => ({ id: b.id, archiveId: b.archiveId, name: b.name, path: b.path, category: b.category, size: b.size, edits: b.edits.size })),
    };
  }

  editCount(archiveId) {
    return this.banks.filter((b) => b.archiveId === archiveId).reduce((n, b) => n + b.edits.size, 0);
  }

  bank(id) {
    const b = this.banks.find((x) => x.id === id);
    if (!b) throw new Error('Unknown sound bank');
    if (!b.parsed) b.parsed = awc.parseAwc(rpf.getBinaryData(b.entry.orig || b.entry));
    return b;
  }

  streams(bankId) {
    const b = this.bank(bankId);
    return { multichannel: b.parsed.multichannel, streams: awc.describeAwc(b.parsed).map((s) => ({ ...s, edited: b.edits.has(s.id) })) };
  }

  pcm(bankId, streamId, original = false) {
    const b = this.bank(bankId);
    if (!original && b.edits.has(streamId)) return b.edits.get(streamId);
    return awc.streamPcm(b.parsed, streamId);
  }

  replace(bankId, streamId, pcm, rate) {
    const b = this.bank(bankId);
    if (b.parsed.multichannel) throw new Error('This bank is multi-channel music/stream audio and cannot be edited.');
    if (!b.parsed.streams.some((s) => s.id === streamId)) throw new Error('Unknown sound');
    if (!pcm.length) throw new Error('Sound is empty');
    b.edits.set(streamId, { pcm: Int16Array.from(pcm), rate: Math.round(rate) });
    return this.streams(bankId);
  }

  revert(bankId, streamId) {
    this.bank(bankId).edits.delete(streamId);
    return this.streams(bankId);
  }

  /** Apply all edits into the archive tree; returns the archive's bytes. */
  build(archiveId) {
    const a = this.archives.find((x) => x.id === archiveId);
    if (!a) throw new Error('Unknown archive');
    for (const b of this.banks.filter((x) => x.archiveId === archiveId && x.edits.size)) {
      const fresh = awc.parseAwc(rpf.getBinaryData(b.entry.orig || b.entry));
      for (const [id, e] of b.edits) awc.replaceStream(fresh, id, e.pcm, e.rate);
      if (!b.entry.orig) b.entry.orig = { type: 'bin', stored: b.entry.stored, compressed: b.entry.compressed, size: b.entry.size };
      rpf.setBinaryData(b.entry, awc.writeAwc(fresh), b.entry.orig.compressed);
    }
    const rebuild = (root) => rpf.walk(root, (entry) => {
      if (entry.nested) { rebuild(entry.nested); rpf.setBinaryData(entry, rpf.writeRpf(entry.nested), false); }
    });
    rebuild(a.root);
    return rpf.writeRpf(a.root);
  }
}

module.exports = { SoundPack, categorize };
