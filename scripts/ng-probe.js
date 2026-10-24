'use strict';
// Dev probe: find the AES key in GTA5.exe, unpack keys, decrypt an NG RPF header.
// Usage: node scripts/ng-probe.js <GTA5.exe> <archive.rpf>
const fs = require('fs');
const path = require('path');
const { GtaKeys, findAesKey } = require('../src/core/ngcrypto');

(async () => {
  const [exe, rpfFile] = process.argv.slice(2);
  let t = Date.now();
  const aes = await findAesKey(exe, () => {});
  console.log('aes key found in', Date.now() - t, 'ms');
  t = Date.now();
  const keys = new GtaKeys(aes);
  console.log('magic unpacked in', Date.now() - t, 'ms; lut[65]=', keys.lut[65], 'lut[97]=', keys.lut[97]);
  if (!rpfFile) return;
  const fd = fs.openSync(rpfFile, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const count = head.readUInt32LE(4), namesLen = head.readUInt32LE(8);
  const body = Buffer.alloc(count * 16 + namesLen);
  fs.readSync(fd, body, 0, body.length, 16);
  const name = path.basename(rpfFile);
  const k = keys.keyIndex(name, size);
  const entries = keys.decryptNG(body.subarray(0, count * 16), k);
  const names = keys.decryptNG(body.subarray(count * 16), k);
  console.log('key index', k, 'root ident 0x' + entries.readUInt32LE(4).toString(16), 'first names:', names.toString('latin1', 0, 120).split('\0').filter(Boolean).slice(0, 8));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
