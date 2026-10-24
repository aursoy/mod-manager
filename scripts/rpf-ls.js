'use strict';
// Header-only RPF7 lister: prints encryption type and file entries without
// loading the whole archive, recursing into nested .rpf entries.
// Usage: node scripts/rpf-ls.js <file.rpf> [max]
const fs = require('fs');

const file = process.argv[2];
const max = +(process.argv[3] || 60);
const fd = fs.openSync(file, 'r');
const ext = {};
let shown = 0;

function list(base, label, depth) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, base);
  const count = head.readUInt32LE(4), namesLen = head.readUInt32LE(8), enc = head.readUInt32LE(12);
  const encName = { 0: 'NONE', 0x4e45504f: 'OPEN', 0x0ffffff9: 'AES', 0x0fefffff: 'NG' }[enc] || '0x' + enc.toString(16);
  const pad = '  '.repeat(depth);
  console.log(pad + '[' + label + '] entries=' + count + ' enc=' + encName);
  if (encName !== 'OPEN' && encName !== 'NONE') return;
  const body = Buffer.alloc(count * 16 + namesLen);
  fs.readSync(fd, body, 0, body.length, base + 16);
  const names = body.subarray(count * 16);
  const nm = (o) => { let e = o; while (names[e]) e++; return names.toString('latin1', o, e); };
  // Rebuild paths via directory entries.
  const paths = new Array(count).fill('');
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    if (body.readUInt32LE(o + 4) !== 0x7fffff00) continue;
    const dname = i === 0 ? '' : paths[i];
    const idx = body.readUInt32LE(o + 8), n = body.readUInt32LE(o + 12);
    for (let c = idx; c < idx + n; c++) {
      const co = c * 16;
      const isDir = body.readUInt32LE(co + 4) === 0x7fffff00;
      const cname = nm(isDir ? body.readUInt32LE(co) : body.readUInt16LE(co));
      paths[c] = (dname ? dname + '/' : '') + cname;
    }
  }
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    const x = body.readUInt32LE(o + 4);
    if (x === 0x7fffff00) continue;
    const name = paths[i];
    const e = (name.split('.').pop() || '').toLowerCase();
    ext[e] = (ext[e] || 0) + 1;
    const res = (x & 0x80000000) !== 0;
    const size = body.readUIntLE(o + 2, 3);
    const off = body.readUIntLE(o + 5, 3) & 0x7fffff;
    if (!res) {
      const unc = body.readUInt32LE(o + 8);
      const peek = Buffer.alloc(4);
      fs.readSync(fd, peek, 0, 4, base + off * 512);
      if (shown++ < max) console.log(pad + '  BIN ' + name + ' unc=' + unc + ' magic=' + peek.toString('hex') + (size ? ' deflated' : ''));
      if (e === 'rpf' && peek.readUInt32LE(0) === 0x52504637) list(base + off * 512, name, depth + 1);
    } else if (shown++ < max) {
      console.log(pad + '  RES ' + name + ' size=' + size + ' sys=' + body.readUInt32LE(o + 8).toString(16) + ' gfx=' + body.readUInt32LE(o + 12).toString(16));
    }
  }
}

list(0, file, 0);
console.log('by extension:', ext);
