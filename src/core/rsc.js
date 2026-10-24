'use strict';
// RSC7 resource container (.ytd / .ydr / .yft ...).
// Layout: 16-byte header (magic, version, sysFlags, gfxFlags) + raw deflate
// of [system pages][graphics pages]. Pointers inside use 0x5xxxxxxx for the
// system segment and 0x6xxxxxxx for the graphics segment.

const zlib = require('zlib');

const RSC7_MAGIC = 0x37435352;

class RscError extends Error {}

function sizeFromFlags(flags) {
  const s0 = ((flags >>> 27) & 0x1) << 0;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const ss = flags & 0xf;
  const baseSize = 0x200 << ss;
  return baseSize * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

/** Decode a stored resource (with RSC7 header). */
function decodeResource(stored, sysFlagsHint, gfxFlagsHint) {
  let sysFlags = sysFlagsHint;
  let gfxFlags = gfxFlagsHint;
  let version = 0;
  let header = null;
  if (stored.length >= 16 && stored.readUInt32LE(0) === RSC7_MAGIC) {
    header = Buffer.from(stored.subarray(0, 16));
    version = stored.readUInt32LE(4);
    sysFlags = stored.readUInt32LE(8);
    gfxFlags = stored.readUInt32LE(12);
  } else if (sysFlags === undefined) {
    throw new RscError('Not an RSC7 resource.');
  }
  const body = header ? stored.subarray(16) : stored;
  let data;
  try {
    data = zlib.inflateRawSync(body);
  } catch (e) {
    throw new RscError('Resource data could not be decompressed (encrypted?).');
  }
  let sysSize = sizeFromFlags(sysFlags);
  const gfxSize = sizeFromFlags(gfxFlags);
  if (sysSize + gfxSize !== data.length) {
    // Be lenient: some tools pad differently. Graphics follow system pages.
    if (sysSize > data.length) sysSize = data.length - gfxSize;
  }
  if (!header) {
    header = Buffer.alloc(16);
    header.writeUInt32LE(RSC7_MAGIC, 0);
    header.writeUInt32LE(((sysFlags >>> 28) << 4) | (gfxFlags >>> 28), 4);
    header.writeUInt32LE(sysFlags >>> 0, 8);
    header.writeUInt32LE(gfxFlags >>> 0, 12);
  }
  return { header, version, sysFlags, gfxFlags, data, sysSize, gfxSize };
}

/** Re-encode decoded resource data (same page layout) into stored bytes. */
function encodeResource(res) {
  const comp = zlib.deflateRawSync(res.data, { level: 9 });
  return Buffer.concat([res.header, comp]);
}

/** Pointer-resolving view over decompressed resource data. */
class ResView {
  constructor(res) {
    this.res = res;
    this.d = res.data;
  }
  off(ptr) {
    if (!ptr) return -1;
    const p = Number(ptr) >>> 0;
    const seg = p >>> 28;
    const o = p & 0x0fffffff;
    let abs;
    if (seg === 5) abs = o;
    else if (seg === 6) abs = this.res.sysSize + o;
    else return -1;
    return abs < this.d.length ? abs : -1;
  }
  u8(o) { return this.d[o]; }
  u16(o) { return this.d.readUInt16LE(o); }
  u32(o) { return this.d.readUInt32LE(o); }
  f32(o) { return this.d.readFloatLE(o); }
  ptr(o) {
    // 64-bit pointers; high dword is always zero for valid pointers.
    const lo = this.d.readUInt32LE(o);
    const hi = this.d.readUInt32LE(o + 4);
    return hi === 0 ? lo : 0;
  }
  at(o) { return this.off(this.ptr(o)); }
  str(abs) {
    if (abs < 0) return '';
    let e = abs;
    while (e < this.d.length && this.d[e] !== 0 && e - abs < 256) e++;
    return this.d.toString('latin1', abs, e);
  }
}

module.exports = { decodeResource, encodeResource, sizeFromFlags, ResView, RscError, RSC7_MAGIC };
