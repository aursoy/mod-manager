'use strict';
// RPF7 archive reader / writer.
// Reads OPEN archives directly. AES / NG archives are read once keys from the
// user's GTA5.exe are loaded (setKeys); without them a NEED_KEYS error is
// thrown. Archives are always written back as OPEN with plain entries.

const zlib = require('zlib');

let keys = null;
function setKeys(k) { keys = k; }
function getKeys() { return keys; }

const RPF7_MAGIC = 0x52504637;
const ENC_NONE = 0;
const ENC_OPEN = 0x4e45504f;
const ENC_AES = 0x0ffffff9;
const ENC_NG = 0x0fefffff;
const DIR_IDENT = 0x7fffff00;
const BLOCK = 512;

class RpfError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const NEED_KEYS = 'NEED_KEYS';

// Plausibility checks used to pick the right NG key for an entry.
function validatorFor(name, compressed) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (compressed) {
    return (h) => { try { zlib.inflateRawSync(h, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); return true; } catch (e) { return false; } };
  }
  if (ext === 'rpf') return (h) => h.readUInt32LE(0) === RPF7_MAGIC;
  if (ext === 'awc') return (h) => h.readUInt32LE(0) === 0x54414441;
  if (ext === 'xml' || ext === 'meta' || ext === 'txt') return (h) => h[0] === 0x3c || h[0] === 0xef || (h[0] >= 0x20 && h[0] < 0x7f);
  return null;
}

/** Decrypt an entry's stored bytes in place (once). */
function plain(entry) {
  if (!entry.enc) return entry;
  if (!keys) throw new RpfError('Encrypted entry: GTA keys are not loaded.', NEED_KEYS);
  const { mode, size } = entry.enc;
  entry.stored = mode === 'aes'
    ? keys.decryptAES(entry.stored)
    : keys.decryptNGAuto(entry.stored, entry.name, size, validatorFor(entry.name, entry.compressed));
  delete entry.enc;
  return entry;
}

function readName(names, offset) {
  let end = offset;
  while (end < names.length && names[end] !== 0) end++;
  return names.toString('latin1', offset, end);
}

/**
 * Parse an RPF7 buffer into a tree:
 *  { type:'dir', name, children:[...] }
 *  { type:'bin', name, stored:Buffer, compressed:bool, size }
 *  { type:'res', name, stored:Buffer (incl. RSC7 header), sysFlags, gfxFlags }
 * Nested .rpf files stay as 'bin' entries; open them with readRpf(getBinaryData(e), e.name).
 * `name` is the archive's file name (used to derive its NG key).
 */
function readRpf(buf, name = '') {
  if (buf.length < 16) throw new RpfError('File is too small to be an RPF archive.');
  const magic = buf.readUInt32LE(0);
  if (magic !== RPF7_MAGIC) throw new RpfError('Not an RPF7 archive (bad magic).');
  const entryCount = buf.readUInt32LE(4);
  const namesLength = buf.readUInt32LE(8);
  const encryption = buf.readUInt32LE(12);
  const entriesStart = 16;
  const namesStart = entriesStart + entryCount * 16;
  if (namesStart + namesLength > buf.length) throw new RpfError('RPF header is truncated.');
  let eb = buf.subarray(entriesStart, namesStart);
  let names = buf.subarray(namesStart, namesStart + namesLength);
  const encrypted = encryption === ENC_AES || encryption === ENC_NG;
  if (encrypted) {
    if (!keys) {
      throw new RpfError('This RPF is encrypted (' + (encryption === ENC_NG ? 'NG' : 'AES') + '). Unlock encrypted RPFs with your GTA V install first.', NEED_KEYS);
    }
    if (encryption === ENC_AES) {
      eb = keys.decryptAES(eb);
      names = keys.decryptAES(names);
    } else {
      const k = keys.pickKey(eb, name, buf.length, (h) => h.readUInt32LE(4) === DIR_IDENT && h.readUInt32LE(8) === 1);
      eb = keys.decryptNG(eb, k);
      names = keys.decryptNG(names, k);
    }
    if (eb.readUInt32LE(4) !== DIR_IDENT) throw new RpfError('Could not decrypt ' + (name || 'this RPF') + ' (wrong keys for this game version?).');
  } else if (encryption !== ENC_OPEN && encryption !== ENC_NONE) {
    throw new RpfError('Unknown RPF encryption type 0x' + encryption.toString(16));
  }

  const raw = [];
  for (let i = 0; i < entryCount; i++) {
    const o = i * 16;
    const x = eb.readUInt32LE(o + 4);
    if (x === DIR_IDENT) {
      raw.push({
        type: 'dir',
        name: readName(names, eb.readUInt32LE(o)),
        index: eb.readUInt32LE(o + 8),
        count: eb.readUInt32LE(o + 12),
      });
    } else if ((x & 0x80000000) === 0) {
      const nameOffset = eb.readUInt16LE(o);
      const fileSize = eb.readUIntLE(o + 2, 3);
      const fileOffset = eb.readUIntLE(o + 5, 3);
      const uncompressed = eb.readUInt32LE(o + 8);
      const encType = eb.readUInt32LE(o + 12);
      const start = fileOffset * BLOCK;
      const len = fileSize === 0 ? uncompressed : fileSize;
      const e = {
        type: 'bin',
        name: readName(names, nameOffset),
        stored: buf.subarray(start, start + len),
        compressed: fileSize !== 0,
        size: uncompressed,
      };
      if (encType === 1) {
        if (!keys) throw new RpfError('This RPF has encrypted files. Unlock encrypted RPFs with your GTA V install first.', NEED_KEYS);
        e.enc = { mode: encryption === ENC_AES ? 'aes' : 'ng', size: uncompressed };
      }
      raw.push(e);
    } else {
      const nameOffset = eb.readUInt16LE(o);
      let fileSize = eb.readUIntLE(o + 2, 3);
      const fileOffset = eb.readUIntLE(o + 5, 3) & 0x7fffff;
      const sysFlags = eb.readUInt32LE(o + 8);
      const gfxFlags = eb.readUInt32LE(o + 12);
      const start = fileOffset * BLOCK;
      if (fileSize === 0xffffff) {
        // Large resource: real size is scrambled into the RSC7 header.
        const h = buf.subarray(start, start + 16);
        fileSize = (h[7] << 0) | (h[14] << 8) | (h[5] << 16) | (h[2] << 24);
        fileSize >>>= 0;
      }
      raw.push({
        type: 'res',
        name: readName(names, nameOffset),
        stored: buf.subarray(start, start + fileSize),
        sysFlags,
        gfxFlags,
      });
    }
  }
  if (!raw.length || raw[0].type !== 'dir') throw new RpfError('RPF has no root directory.');

  const build = (i) => {
    const e = raw[i];
    if (e.type !== 'dir') return e;
    const node = { type: 'dir', name: e.name, children: [] };
    for (let c = e.index; c < e.index + e.count; c++) node.children.push(build(c));
    return node;
  };
  const root = build(0);
  root.name = '';
  return root;
}

/** Return the file's content bytes (decompressed for binary files). */
function getBinaryData(entry) {
  if (entry.type !== 'bin') throw new RpfError('Not a binary entry');
  plain(entry);
  return entry.compressed ? zlib.inflateRawSync(entry.stored) : entry.stored;
}

function setBinaryData(entry, data, compress) {
  entry.size = data.length;
  entry.compressed = !!compress;
  entry.stored = compress ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.from(data);
}

function sortKey(n) { return n.name.toLowerCase(); }

/** Serialize a tree back into an OPEN RPF7 buffer. */
function writeRpf(root) {
  // Breadth-first so every directory's children are contiguous.
  const flat = [root];
  const dirInfo = new Map();
  for (let i = 0; i < flat.length; i++) {
    const n = flat[i];
    if (n.type !== 'dir') continue;
    const kids = [...n.children].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    dirInfo.set(n, { index: flat.length, count: kids.length });
    flat.push(...kids);
  }

  // Names table (root's empty name at offset 0).
  const nameOffsets = new Map();
  const parts = [];
  let nlen = 0;
  const addName = (s) => {
    if (nameOffsets.has(s)) return nameOffsets.get(s);
    const b = Buffer.from(s + '\0', 'latin1');
    nameOffsets.set(s, nlen);
    parts.push(b);
    nlen += b.length;
    return nameOffsets.get(s);
  };
  addName('');
  for (const n of flat) addName(n.name);
  const namesPadded = Math.ceil(nlen / 16) * 16;
  if (namesPadded > 0xffff) throw new RpfError('Too many names for an RPF7 archive.');
  const namesBuf = Buffer.alloc(namesPadded);
  Buffer.concat(parts).copy(namesBuf);

  const headerLen = 16 + flat.length * 16 + namesPadded;
  let cursorBlocks = Math.ceil(headerLen / BLOCK);
  const placements = [];
  const entries = Buffer.alloc(flat.length * 16);

  flat.forEach((n, i) => {
    const o = i * 16;
    if (n.type === 'dir') {
      const d = dirInfo.get(n);
      entries.writeUInt32LE(nameOffsets.get(n.name), o);
      entries.writeUInt32LE(DIR_IDENT, o + 4);
      entries.writeUInt32LE(d.index, o + 8);
      entries.writeUInt32LE(d.count, o + 12);
      return;
    }
    if (n.type === 'bin') plain(n); // always written unencrypted (OPEN)
    const len = n.stored.length;
    if (cursorBlocks > 0x7fffff) throw new RpfError('Archive too large.');
    const blocks = Math.max(1, Math.ceil(len / BLOCK));
    if (n.type === 'bin') {
      entries.writeUInt16LE(nameOffsets.get(n.name), o);
      entries.writeUIntLE(n.compressed ? len : 0, o + 2, 3);
      entries.writeUIntLE(cursorBlocks, o + 5, 3);
      entries.writeUInt32LE(n.compressed ? n.size : len, o + 8);
      entries.writeUInt32LE(0, o + 12);
    } else {
      if (len >= 0xffffff) throw new RpfError('Resource "' + n.name + '" is too large (>16MB).');
      entries.writeUInt16LE(nameOffsets.get(n.name), o);
      entries.writeUIntLE(len, o + 2, 3);
      entries.writeUIntLE(cursorBlocks | 0x800000, o + 5, 3);
      entries.writeUInt32LE(n.sysFlags >>> 0, o + 8);
      entries.writeUInt32LE(n.gfxFlags >>> 0, o + 12);
    }
    placements.push({ at: cursorBlocks * BLOCK, data: n.stored });
    cursorBlocks += blocks;
  });

  const out = Buffer.alloc(cursorBlocks * BLOCK);
  out.writeUInt32LE(RPF7_MAGIC, 0);
  out.writeUInt32LE(flat.length, 4);
  out.writeUInt32LE(namesPadded, 8);
  out.writeUInt32LE(ENC_OPEN, 12);
  entries.copy(out, 16);
  namesBuf.copy(out, 16 + entries.length);
  for (const p of placements) p.data.copy(out, p.at);
  return out;
}

/** Walk every file entry, recursing into nested .rpf archives. */
function walk(root, fn, prefix = '') {
  for (const c of root.children) {
    const p = prefix ? prefix + '/' + c.name : c.name;
    if (c.type === 'dir') walk(c, fn, p);
    else fn(c, p);
  }
}

module.exports = { readRpf, writeRpf, getBinaryData, setBinaryData, walk, plain, setKeys, getKeys, RpfError, ENC_OPEN, NEED_KEYS };
