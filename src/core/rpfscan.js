'use strict';
// Look inside RPFs on disk without loading them. Graphics-pack RPFs can be over a
// gigabyte; their file list (header + table of contents) is a few kilobytes. Nested
// RPFs are read on their own, so finding skydome.ytd or cloudhat_*.ytd in a huge
// archive costs a few small reads instead of the whole file.

const fs = require('fs');
const rpf = require('./rpf');

const MAX_NESTED = 512 * 1048576;

function readAt(fd, start, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, start + got);
    if (!n) break;
    got += n;
  }
  return got === len ? b : b.subarray(0, got);
}

/** Read just the header and table of contents of an RPF that starts at `base` in the file. */
function readToc(fd, base, size, name) {
  const head = readAt(fd, base, 16);
  if (head.length < 16) throw new rpf.RpfError('Too small to be an RPF.');
  const tocLen = 16 + head.readUInt32LE(4) * 16 + head.readUInt32LE(8);
  return rpf.readRpf(readAt(fd, base, tocLen), name, size);
}

/**
 * Every file path inside an RPF on disk, nested RPFs included, matched by `test(name)`.
 * Returns [{ path }] (cheap: only tables of contents and nested archives are read).
 */
function findInFile(file, test) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const out = [];
    const scan = (root, prefix, base, getNested) => {
      rpf.walk(root, (e, p) => {
        const full = prefix ? prefix + '/' + p : p;
        if (test(e.name)) out.push({ path: full });
        if (e.type === 'bin' && /\.rpf$/i.test(e.name)) {
          try {
            const inner = getNested(e);
            if (inner) scan(rpf.readRpf(inner, e.name), full, 0, (x) => rpf.getBinaryData(x));
          } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; /* unreadable inner archive */ }
        }
      });
    };
    const root = readToc(fd, 0, size, require('path').basename(file));
    scan(root, '', 0, (e) => {
      if (!e.at || e.at.len > MAX_NESTED) return null;
      e.stored = readAt(fd, e.at.start, e.at.len);
      return rpf.getBinaryData(e);
    });
    return out;
  } finally { fs.closeSync(fd); }
}

/**
 * Copy matching resource files (e.g. cloudhat_*.ytd) out of an RPF on disk, reading
 * only what is needed. Returns [{ path, name, stored }] where stored is the .ytd bytes.
 */
function extractFromFile(file, test) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const out = [];
    const scan = (root, prefix, fromDisk) => {
      rpf.walk(root, (e, p) => {
        const full = prefix ? prefix + '/' + p : p;
        if (e.type === 'res' && test(e.name)) {
          let stored = null;
          if (!fromDisk) stored = Buffer.from(e.stored);
          else if (e.at) {
            let len = e.at.len;
            if (!(len >= 16)) {
              // over 16 MB: the size is scrambled into the RSC7 header, same as rpf.readRpf
              const h = readAt(fd, e.at.start, 16);
              len = ((h[7] << 0) | (h[14] << 8) | (h[5] << 16) | (h[2] << 24)) >>> 0;
            }
            if (len < MAX_NESTED) stored = readAt(fd, e.at.start, len);
          }
          // big resources keep their real size in the RSC7 header; read it again once we have it
          if (stored && stored.length >= 16) out.push({ path: full, name: e.name, stored });
        }
        if (e.type === 'bin' && /\.rpf$/i.test(e.name)) {
          try {
            let data;
            if (fromDisk) { if (!e.at || e.at.len > MAX_NESTED) return; e.stored = readAt(fd, e.at.start, e.at.len); }
            data = rpf.getBinaryData(e);
            scan(rpf.readRpf(data, e.name), full, false);
          } catch (err) { if (err.code === rpf.NEED_KEYS) throw err; }
        }
      });
    };
    scan(readToc(fd, 0, size, require('path').basename(file)), '', true);
    return out;
  } finally { fs.closeSync(fd); }
}

/**
 * Read one plain file (e.g. common/data/visualsettings.dat) out of a game RPF without
 * loading the archive: only its table of contents and that entry are read.
 * `want` is the path inside the archive, compared case-insensitively.
 */
function readFileFrom(file, want) {
  want = want.toLowerCase().replace(/\\/g, '/');
  const fd = fs.openSync(file, 'r');
  try {
    const root = readToc(fd, 0, fs.fstatSync(fd).size, require('path').basename(file));
    let hit = null;
    rpf.walk(root, (e, p) => { if (!hit && e.type === 'bin' && p.toLowerCase() === want) hit = e; });
    if (!hit || !hit.at) return null;
    hit.stored = readAt(fd, hit.at.start, hit.at.len);
    return Buffer.from(rpf.getBinaryData(hit));
  } finally { fs.closeSync(fd); }
}

module.exports = { findInFile, extractFromFile, readFileFrom };
