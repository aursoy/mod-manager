'use strict';
// GTA V PC archive crypto (NG table cipher, AES key, AWC XXTEA).
// Ported from CodeWalker (dexyfex, MIT) / GTACrypto (Neodymium, MIT); see
// vendor/codewalker/NOTICE.txt. Keys are never shipped: the AES key is found
// in the user's own GTA5.exe and used to unpack CodeWalker's magic.dat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const AES_KEY_SHA1 = Buffer.from('A0796128A775720AC204D9819F68C172E3952C6D', 'hex');
const MAGIC_PATH = path.join(__dirname, '..', '..', 'vendor', 'codewalker', 'magic.dat');

// ---------- helpers ----------
function jenk(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = (h + bytes[i]) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

/** System.Random (legacy seeded algorithm, as used by .NET Framework). */
function dotnetRandom(seed) {
  const MBIG = 2147483647, MSEED = 161803398;
  const sa = new Int32Array(56);
  const sub = seed === -2147483648 ? MBIG : Math.abs(seed);
  let mj = MSEED - sub;
  sa[55] = mj;
  let mk = 1;
  for (let i = 1; i < 55; i++) {
    const ii = (21 * i) % 55;
    sa[ii] = mk;
    mk = (mj - mk) | 0; // C# int arithmetic wraps on overflow
    if (mk < 0) mk += MBIG;
    mj = sa[ii];
  }
  for (let k = 1; k < 5; k++) {
    for (let i = 1; i < 56; i++) {
      let v = (sa[i] - sa[1 + ((i + 30) % 55)]) | 0;
      if (v < 0) v += MBIG;
      sa[i] = v;
    }
  }
  let inext = 0, inextp = 21;
  const sample = () => {
    if (++inext >= 56) inext = 1;
    if (++inextp >= 56) inextp = 1;
    let r = sa[inext] - sa[inextp];
    if (r === MBIG) r--;
    if (r < 0) r += MBIG;
    sa[inext] = r;
    return r;
  };
  return { nextBytes(n) { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = sample() & 0xff; return b; } };
}

function aesEcbDecrypt(data, key) {
  const len = data.length - (data.length % 16);
  const out = Buffer.from(data);
  if (len > 0) {
    const d = crypto.createDecipheriv('aes-256-ecb', key, null);
    d.setAutoPadding(false);
    Buffer.concat([d.update(data.subarray(0, len)), d.final()]).copy(out, 0);
  }
  return out;
}

// ---------- AES key search (runs in a worker so the UI stays responsive) ----------
const SEARCH_SRC = `
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const fs = require('fs');
const target = Buffer.from(workerData.hash, 'hex');
const buf = fs.readFileSync(workerData.exe);
const sha1 = crypto.hash ? (b) => crypto.hash('sha1', b, 'buffer') : (b) => crypto.createHash('sha1').update(b).digest();
let found = null;
const step = 1 << 20;
for (let p = 0; p + 32 <= buf.length; p += 8) {
  if (sha1(buf.subarray(p, p + 32)).equals(target)) { found = Buffer.from(buf.subarray(p, p + 32)).toString('hex'); break; }
  if ((p & (step - 1)) === 0) parentPort.postMessage({ progress: p / buf.length });
}
parentPort.postMessage({ done: true, key: found });
`;

function findAesKey(exePath, onProgress) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(SEARCH_SRC, { eval: true, workerData: { exe: exePath, hash: AES_KEY_SHA1.toString('hex') } });
    w.on('message', (m) => {
      if (m.progress !== undefined && onProgress) onProgress(m.progress);
      if (m.done) { w.terminate(); m.key ? resolve(Buffer.from(m.key, 'hex')) : reject(new Error('Key not found in ' + path.basename(exePath) + '. Is this the real GTA V executable?')); }
    });
    w.on('error', reject);
  });
}

// ---------- key set ----------
class GtaKeys {
  constructor(aesKey, magic = fs.readFileSync(MAGIC_PATH)) {
    if (!crypto.createHash('sha1').update(aesKey).digest().equals(AES_KEY_SHA1)) throw new Error('AES key is wrong.');
    this.aes = aesKey;
    const rnd = dotnetRandom(jenk(aesKey) | 0);
    const r = [rnd.nextBytes(magic.length), rnd.nextBytes(magic.length), rnd.nextBytes(magic.length), rnd.nextBytes(magic.length)];
    const db = Buffer.alloc(magic.length);
    for (let i = 0; i < magic.length; i++) db[i] = (magic[i] - r[0][i] - r[1][i] - r[2][i] - r[3][i]) & 0xff;
    const b = zlib.inflateRawSync(aesEcbDecrypt(db, aesKey), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (b.length < 27472 + 278528 + 256 + 16) throw new Error('magic.dat did not unpack correctly.');
    this.ngKeys = [];
    for (let i = 0; i < 101; i++) this.ngKeys.push(new Uint32Array(b.buffer.slice(b.byteOffset + i * 272, b.byteOffset + (i + 1) * 272)));
    let o = 27472;
    this.tables = [];
    for (let i = 0; i < 17; i++) {
      const round = [];
      for (let j = 0; j < 16; j++) { round.push(new Uint32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + 1024))); o += 1024; }
      this.tables.push(round);
    }
    this.lut = Buffer.from(b.subarray(o, o + 256)); o += 256;
    this.awcKey = new Uint32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + 16));
  }

  hashName(text) {
    let result = 0;
    for (let i = 0; i < text.length; i++) {
      const temp = Math.imul(1025, (this.lut[text.charCodeAt(i) & 0xff] + result) >>> 0) >>> 0;
      result = ((temp >>> 6) ^ temp) >>> 0;
    }
    const n = Math.imul(9, result) >>> 0;
    return Math.imul(32769, ((n >>> 11) ^ n) >>> 0) >>> 0;
  }

  keyIndex(name, length) { return ((this.hashName(name) + length + 61) >>> 0) % 101; }

  /** Decrypt a buffer with NG key index `k` (whole 16-byte blocks; tail copied). */
  decryptNG(data, k) {
    const key = this.ngKeys[k];
    const T = this.tables;
    const out = Buffer.from(data);
    const n = data.length - (data.length % 16);
    const s = new Uint8Array(16);
    for (let p = 0; p < n; p += 16) {
      for (let i = 0; i < 16; i++) s[i] = data[p + i];
      for (let r = 0; r < 17; r++) {
        const t = T[r], kb = r * 4;
        let x1, x2, x3, x4;
        if (r < 2 || r === 16) {
          x1 = t[0][s[0]] ^ t[1][s[1]] ^ t[2][s[2]] ^ t[3][s[3]] ^ key[kb];
          x2 = t[4][s[4]] ^ t[5][s[5]] ^ t[6][s[6]] ^ t[7][s[7]] ^ key[kb + 1];
          x3 = t[8][s[8]] ^ t[9][s[9]] ^ t[10][s[10]] ^ t[11][s[11]] ^ key[kb + 2];
          x4 = t[12][s[12]] ^ t[13][s[13]] ^ t[14][s[14]] ^ t[15][s[15]] ^ key[kb + 3];
        } else {
          x1 = t[0][s[0]] ^ t[7][s[7]] ^ t[10][s[10]] ^ t[13][s[13]] ^ key[kb];
          x2 = t[1][s[1]] ^ t[4][s[4]] ^ t[11][s[11]] ^ t[14][s[14]] ^ key[kb + 1];
          x3 = t[2][s[2]] ^ t[5][s[5]] ^ t[8][s[8]] ^ t[15][s[15]] ^ key[kb + 2];
          x4 = t[3][s[3]] ^ t[6][s[6]] ^ t[9][s[9]] ^ t[12][s[12]] ^ key[kb + 3];
        }
        s[0] = x1; s[1] = x1 >>> 8; s[2] = x1 >>> 16; s[3] = x1 >>> 24;
        s[4] = x2; s[5] = x2 >>> 8; s[6] = x2 >>> 16; s[7] = x2 >>> 24;
        s[8] = x3; s[9] = x3 >>> 8; s[10] = x3 >>> 16; s[11] = x3 >>> 24;
        s[12] = x4; s[13] = x4 >>> 8; s[14] = x4 >>> 16; s[15] = x4 >>> 24;
      }
      for (let i = 0; i < 16; i++) out[p + i] = s[i];
    }
    return out;
  }

  /**
   * Decrypt with the key derived from name + length; if `valid` rejects the
   * result (renamed file, odd tooling), try all 101 keys on the first block.
   */
  pickKey(data, name, length, valid) {
    const k0 = this.keyIndex(name, length);
    const head = data.subarray(0, Math.min(data.length, 64));
    if (!valid || valid(this.decryptNG(head, k0))) return k0;
    for (let k = 0; k < 101; k++) {
      if (k !== k0 && valid(this.decryptNG(head, k))) return k;
    }
    return k0;
  }

  decryptNGAuto(data, name, length, valid) {
    return this.decryptNG(data, this.pickKey(data, name, length, valid));
  }

  decryptAES(data) { return aesEcbDecrypt(data, this.aes); }

  /** Rockstar's modified XXTEA (AWC banks). Returns a new buffer. */
  decryptXXTEA(data) {
    const n = data.length >> 2;
    if (n < 2) return Buffer.from(data);
    const out = Buffer.from(data);
    const v = new Uint32Array(out.buffer, out.byteOffset, n);
    const key = this.awcKey;
    let i = Math.imul(0x9e3779b9 | 0, 6 + Math.floor(52 / n)) >>> 0;
    let b = v[0];
    do {
      for (let bi = n - 1; bi >= 0; bi--) {
        const a = v[(bi > 0 ? bi : n) - 1];
        const mx = ((((a >>> 5) ^ (b << 2)) + ((b >>> 3) ^ (a << 4))) ^ (((i ^ b) >>> 0) + ((key[(bi & 3) ^ ((i >>> 2) & 3)] ^ a ^ 0x7b3a207f) >>> 0))) >>> 0;
        v[bi] = (v[bi] - mx) >>> 0;
        b = v[bi];
      }
      i = (i - 0x9e3779b9) >>> 0;
    } while (i !== 0);
    return out;
  }
}

/** Guess GTA V install folders (Steam, Epic, Rockstar). */
function findGtaExes() {
  const out = [];
  const add = (dir) => {
    for (const exe of ['GTA5.exe', 'GTA5_Enhanced.exe']) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p) && !out.includes(p)) out.push(p);
    }
  };
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'D:\\', 'E:\\'].filter(Boolean);
  for (const base of pf) {
    add(path.join(base, 'Steam', 'steamapps', 'common', 'Grand Theft Auto V'));
    add(path.join(base, 'Steam', 'steamapps', 'common', 'Grand Theft Auto V Enhanced'));
    add(path.join(base, 'SteamLibrary', 'steamapps', 'common', 'Grand Theft Auto V'));
    add(path.join(base, 'Epic Games', 'GTAV'));
    add(path.join(base, 'Rockstar Games', 'Grand Theft Auto V'));
    add(path.join(base, 'Rockstar Games', 'Grand Theft Auto V Enhanced'));
  }
  // Extra Steam libraries.
  for (const base of pf) {
    const vdf = path.join(base, 'Steam', 'steamapps', 'libraryfolders.vdf');
    try {
      for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) {
        add(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common', 'Grand Theft Auto V'));
      }
    } catch (e) { /* none */ }
  }
  return out;
}

module.exports = { GtaKeys, findAesKey, findGtaExes, jenk, dotnetRandom, AES_KEY_SHA1 };
