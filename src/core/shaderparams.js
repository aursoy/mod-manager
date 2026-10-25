'use strict';
// Shader settings of a drawable (.ydr), the numbers that decide how shiny a gun is.
// Each shader has a parameter block: count x 16-byte entries (type u8: 0 = texture,
// n = n vec4s of data; data pointer at +8), then the vec4 data, then one name hash
// (joaat of the lowercase name) per parameter.

const { ResView } = require('./rsc');

function joaat(s) {
  let h = 0;
  for (const c of String(s).toLowerCase()) {
    h = (h + c.charCodeAt(0)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  return (h + (h << 15)) >>> 0;
}

/** Every float parameter of every shader in the drawable at `base`:
 *  [{ shader, name hash, abs (offset of the vec4 in res.data), value: [x, y, z, w] }] */
function shaderParams(res, base = 0) {
  const v = new ResView(res);
  const out = [];
  const sg = v.at(base + 0x10);
  if (sg < 0) return out;
  const shaders = v.at(sg + 0x10);
  const count = v.u16(sg + 0x18);
  if (shaders < 0 || count > 512) return out;
  for (let i = 0; i < count; i++) {
    const s = v.at(shaders + i * 8);
    if (s < 0) continue;
    const params = v.at(s);
    const n = v.u8(s + 0x10);
    if (params < 0 || !n) continue;
    let dataSize = 0;
    for (let p = 0; p < n; p++) dataSize += v.u8(params + p * 16) * 16;
    const hashes = params + n * 16 + dataSize;
    if (hashes + n * 4 > v.d.length) continue;
    for (let p = 0; p < n; p++) {
      const type = v.u8(params + p * 16);
      if (!type) continue;
      const abs = v.at(params + p * 16 + 8);
      if (abs < 0 || abs + 16 > v.d.length) continue;
      out.push({ shader: i, hash: v.u32(hashes + p * 4), abs, value: [0, 4, 8, 12].map((k) => v.f32(abs + k)) });
    }
  }
  return out;
}

// What "shine" moves, from the gun's own value (0) to a polished, mirror-like finish (1).
const SHINE = {
  [joaat('specularIntensityMult')]: 3,
  [joaat('specularFalloffMult')]: 600,
  [joaat('specularFresnel')]: 0.97,
};

/** Make every shader in the drawable shinier (amount 0..1; 0 leaves it as it was). Returns how many values changed. */
function setShine(res, amount, base = 0) {
  const k = Math.max(0, Math.min(1, +amount || 0));
  if (!k) return 0;
  let n = 0;
  for (const p of shaderParams(res, base)) {
    const target = SHINE[p.hash];
    if (target == null) continue;
    res.data.writeFloatLE(p.value[0] + (Math.max(target, p.value[0]) - p.value[0]) * k, p.abs);
    n++;
  }
  return n;
}

module.exports = { joaat, shaderParams, setShine, SHINE };
