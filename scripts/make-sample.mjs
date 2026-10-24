// Builds samples/w_pi_sample.rpf: a blocky test pistol (.ydr) + texture (.ytd)
// laid out like gen8 PC resources, for trying the Gun Lab without real files.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { encode } from '../renderer/js/dxt.js';

const require = createRequire(import.meta.url);
const rpf = require('../src/core/rpf.js');

const S = 0x50000000, G = 0x60000000, RSC7 = 0x37435352;
const ptr = (b, at, to) => b.writeUInt32LE(to >>> 0, at);

function wrap(sys, gfx, version, sysFlags, gfxFlags) {
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(RSC7, 0); hdr.writeUInt32LE(version, 4); hdr.writeUInt32LE(sysFlags >>> 0, 8); hdr.writeUInt32LE(gfxFlags >>> 0, 12);
  return { stored: Buffer.concat([hdr, zlib.deflateRawSync(Buffer.concat([sys, gfx]))]), sysFlags: sysFlags >>> 0, gfxFlags: gfxFlags >>> 0 };
}

// ---- texture: brushed gunmetal panels with a stripe ----
const W = 256, H = 256, LEVELS = 9;
function texel(x, y) {
  const n = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  let v = 58 + Math.abs(n) * 18 + Math.sin(x * 0.4) * 4;
  if (x % 64 < 2 || y % 64 < 2) v = 20;
  if (y > 110 && y < 130) v = 210;
  return [v, v, v + 6, 255];
}
const levels = [];
for (let i = 0; i < LEVELS; i++) {
  const w = Math.max(1, W >> i), h = Math.max(1, H >> i);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(texel(x * (W / w), y * (H / h)), (y * w + x) * 4);
  levels.push(Buffer.from(encode('DXT1', px, w, h)));
}
const texData = Buffer.concat(levels);

function ytd(name) {
  const sys = Buffer.alloc(0x2000), gfx = Buffer.alloc(0x10000);
  ptr(sys, 0x30, S + 0x40); sys.writeUInt16LE(1, 0x38); sys.writeUInt16LE(1, 0x3a);
  ptr(sys, 0x40, S + 0x80);
  const t = 0x80;
  ptr(sys, t + 0x28, S + 0x120);
  sys.writeUInt16LE(W, t + 0x50); sys.writeUInt16LE(H, t + 0x52); sys.writeUInt16LE(1, t + 0x54); sys.writeUInt16LE(W / 2, t + 0x56);
  sys.writeUInt32LE(0x31545844, t + 0x58); sys[t + 0x5d] = LEVELS;
  ptr(sys, t + 0x70, G);
  sys.write(name + '\0', 0x120, 'latin1');
  texData.copy(gfx, 0);
  return wrap(sys, gfx, 13, (1 << 27) | 4, (13 << 28) | (1 << 24) | 4);
}

// ---- mesh: boxes with per-face UVs ----
function boxes() {
  const parts = [
    // [cx, cy, cz, sx, sy, sz] in GTA space (X forward, Z up)
    [0.06, 0, 0.06, 0.22, 0.032, 0.045],   // slide
    [0.17, 0, 0.065, 0.06, 0.018, 0.018],  // barrel tip
    [0.03, 0, 0.022, 0.16, 0.028, 0.03],   // frame
    [-0.025, 0, -0.04, 0.05, 0.03, 0.11],  // grip
    [0.025, 0, -0.005, 0.035, 0.006, 0.03] // trigger guard
  ];
  const pos = [], uv = [], idx = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  ];
  parts.forEach(([cx, cy, cz, sx, sy, sz], p) => {
    const half = [sx / 2, sy / 2, sz / 2];
    faces.forEach(([n, u, v], f) => {
      const base = pos.length / 3;
      const u0 = (f % 3) / 3, v0 = (Math.floor(f / 3) + p * 2) / 10;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const c = [0, 1, 2].map((k) => [cx, cy, cz][k] + n[k] * half[k] + u[k] * half[k] * a + v[k] * half[k] * b);
        pos.push(...c);
        uv.push(u0 + ((a + 1) / 2) / 3, v0 + ((1 - b) / 2) / 10);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  });
  return { pos, uv, idx };
}

function ydr(texName) {
  const sys = Buffer.alloc(0x2000), gfx = Buffer.alloc(0x2000);
  const m = boxes();
  const vCount = m.pos.length / 3, stride = 20;
  ptr(sys, 0x10, S + 0x200);                // shader group
  ptr(sys, 0x50, S + 0x100);                // high LOD
  ptr(sys, 0x100, S + 0x120); sys.writeUInt16LE(1, 0x108); sys.writeUInt16LE(1, 0x10a);
  ptr(sys, 0x120, S + 0x140);
  ptr(sys, 0x148, S + 0x1a0); sys.writeUInt16LE(1, 0x150); sys.writeUInt16LE(1, 0x152); // model geoms
  ptr(sys, 0x160, S + 0x1c0);               // shader mapping
  ptr(sys, 0x1a0, S + 0x400);
  sys.writeUInt16LE(0, 0x1c0);
  ptr(sys, 0x210, S + 0x220); sys.writeUInt16LE(1, 0x218);
  ptr(sys, 0x220, S + 0x240);
  ptr(sys, 0x240, S + 0x280); sys[0x250] = 1;
  sys[0x280] = 0; ptr(sys, 0x288, S + 0x700);
  ptr(sys, 0x728, S + 0x780); sys.write(texName + '\0', 0x780, 'latin1');
  ptr(sys, 0x418, S + 0x500); ptr(sys, 0x438, S + 0x600);
  sys.writeUInt16LE(stride, 0x508); ptr(sys, 0x510, G); sys.writeUInt32LE(vCount, 0x518); ptr(sys, 0x530, S + 0x5a0);
  sys.writeUInt32LE(0x41, 0x5a0); sys.writeUInt16LE(stride, 0x5a4); sys[0x5a7] = 2;
  sys.writeBigUInt64LE(6n | (5n << 24n), 0x5a8);
  const ibOff = Math.ceil((vCount * stride) / 16) * 16;
  sys.writeUInt32LE(m.idx.length, 0x608); ptr(sys, 0x610, G + ibOff);
  for (let i = 0; i < vCount; i++) {
    const o = i * stride;
    gfx.writeFloatLE(m.pos[i * 3], o); gfx.writeFloatLE(m.pos[i * 3 + 1], o + 4); gfx.writeFloatLE(m.pos[i * 3 + 2], o + 8);
    gfx.writeFloatLE(m.uv[i * 2], o + 12); gfx.writeFloatLE(m.uv[i * 2 + 1], o + 16);
  }
  m.idx.forEach((v, i) => gfx.writeUInt16LE(v, ibOff + i * 2));
  return wrap(sys, gfx, 165, (10 << 28) | (1 << 27) | 4, (5 << 28) | (1 << 27) | 4);
}

const name = 'w_pi_sample';
const a = ytd(name), b = ydr(name);
const root = {
  type: 'dir', name: '', children: [
    { type: 'res', name: name + '.ytd', ...a },
    { type: 'res', name: name + '.ydr', ...b },
  ],
};
const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'samples', name + '.rpf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rpf.writeRpf(root));
console.log('wrote', out);

// ---- sound sample: WEAPONS_PLAYER-style archive with a few banks ----
const awc = require('../src/core/awc.js');
function synth(n, rate, fn) { const o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(-32767, Math.min(32767, Math.round(fn(i / rate) * 30000))); return o; }
const noise = () => Math.random() * 2 - 1;
const gunshot = (t) => noise() * Math.exp(-t * 18) + Math.sin(t * 2 * Math.PI * 90) * Math.exp(-t * 9) * 0.6;
const step = (t) => noise() * Math.exp(-t * 60) * 0.7;
const ding = (t) => Math.sin(t * 2 * Math.PI * 1320) * Math.exp(-t * 7) * 0.6;
function bank(streams) {
  return awc.writeAwc({
    version: 1, flags: 0xff00, chunkIndices: null,
    streams: streams.map(([id, rate, secs, fn, codec]) => {
      const pcm = synth(Math.round(rate * secs), rate, fn);
      const f = Buffer.alloc(24); f.writeUInt32LE(pcm.length, 0); f.writeInt32LE(-1, 4); f.writeUInt16LE(rate, 8); f[19] = codec;
      let data;
      if (codec === awc.CODEC.ADPCM) data = awc.encodeAdpcm(pcm);
      else { data = Buffer.alloc(pcm.length * 2); pcm.forEach((v, i) => data.writeInt16LE(v, i * 2)); }
      return { id, chunkCount: 2, chunks: [{ type: awc.CHUNK.format, data: f }, { type: awc.CHUNK.data, data }] };
    }),
  });
}
const banks = {
  'spl_pistol_player.awc': bank([[0x0c1a2b3c, 32000, 0.6, gunshot, awc.CODEC.ADPCM], [0x0c1a2b3d, 32000, 0.45, gunshot, awc.CODEC.ADPCM]]),
  'spl_rifle_player.awc': bank([[0x0d00aa01, 32000, 0.8, gunshot, awc.CODEC.PCM]]),
  'feet_concrete.awc': bank([[0x01f00001, 24000, 0.25, step, awc.CODEC.ADPCM], [0x01f00002, 24000, 0.22, step, awc.CODEC.ADPCM], [0x01f00003, 24000, 0.27, step, awc.CODEC.ADPCM]]),
  'hud_kill_frontend.awc': bank([[0x0a11c0de, 44100, 0.5, ding, awc.CODEC.PCM]]),
};
const sroot = { type: 'dir', name: '', children: [{ type: 'dir', name: 'sfx', children: Object.entries(banks).map(([n, b]) => ({ type: 'bin', name: n, stored: b, compressed: false, size: b.length })) }] };
const sout = path.join(path.dirname(out), 'WEAPONS_PLAYER_sample.rpf');
fs.writeFileSync(sout, rpf.writeRpf(sroot));
console.log('wrote', sout);
