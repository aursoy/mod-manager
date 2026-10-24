'use strict';
// Drawable (.ydr, gen8 PC) mesh extraction for preview purposes.
// Read-only: geometry is never written back, only textures are.

const { parseTextureDictionary } = require('./ytd');

// Vertex component type -> byte size.
const COMP_SIZE = [2, 4, 6, 8, 4, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];
// Semantic slots in declaration order.
const SEM = { POS: 0, NORMAL: 3, UV0: 6 };

function half(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readComp(v, o, type, n) {
  const out = new Array(n).fill(0);
  switch (type) {
    case 1: for (let i = 0; i < Math.min(n, 2); i++) out[i] = half(v.u16(o + i * 2)); break;
    case 3: for (let i = 0; i < Math.min(n, 4); i++) out[i] = half(v.u16(o + i * 2)); break;
    case 4: out[0] = v.f32(o); break;
    case 5: for (let i = 0; i < Math.min(n, 2); i++) out[i] = v.f32(o + i * 4); break;
    case 6: for (let i = 0; i < Math.min(n, 3); i++) out[i] = v.f32(o + i * 4); break;
    case 7: for (let i = 0; i < Math.min(n, 4); i++) out[i] = v.f32(o + i * 4); break;
    case 10: {
      // Packed signed normal (Dec3N style): 10/10/10.
      const p = v.u32(o);
      const c = (x) => { x &= 0x3ff; return (x & 0x200 ? x - 0x400 : x) / 511; };
      out[0] = c(p); out[1] = c(p >> 10); out[2] = c(p >> 20);
      break;
    }
    case 8: case 9:
      for (let i = 0; i < Math.min(n, 4); i++) out[i] = v.u8(o + i) / 255;
      break;
    default: break;
  }
  return out;
}

function parseGeometry(v, g, shaderTex) {
  const vbAbs = v.at(g + 0x18);
  const ibAbs = v.at(g + 0x38);
  if (vbAbs < 0 || ibAbs < 0) return null;
  const vStride = v.u16(vbAbs + 0x08);
  const vCount = v.u32(vbAbs + 0x18);
  let vData = v.at(vbAbs + 0x10);
  if (vData < 0) vData = v.at(vbAbs + 0x20);
  const declAbs = v.at(vbAbs + 0x30);
  const iCount = v.u32(ibAbs + 0x08);
  const iData = v.at(ibAbs + 0x10);
  if (vData < 0 || iData < 0 || !vStride || !vCount || vCount > 2000000 || iCount > 6000000) return null;
  if (vData + vStride * vCount > v.d.length || iData + iCount * 2 > v.d.length) return null;

  // Build component offsets from the declaration.
  let offs = { pos: 0, posType: 6, normal: -1, normalType: 0, uv: -1, uvType: 0 };
  if (declAbs >= 0) {
    const flags = v.u32(declAbs);
    const types = v.d.readBigUInt64LE(declAbs + 8);
    let o = 0;
    const found = {};
    for (let k = 0; k < 16; k++) {
      if (!((flags >>> k) & 1)) continue;
      const t = Number((types >> BigInt(k * 4)) & 0xfn);
      found[k] = { o, t };
      o += COMP_SIZE[t];
    }
    if (o === vStride && found[SEM.POS]) {
      offs.pos = found[SEM.POS].o; offs.posType = found[SEM.POS].t;
      if (found[SEM.NORMAL]) { offs.normal = found[SEM.NORMAL].o; offs.normalType = found[SEM.NORMAL].t; }
      if (found[SEM.UV0]) { offs.uv = found[SEM.UV0].o; offs.uvType = found[SEM.UV0].t; }
    }
  }

  const positions = new Float32Array(vCount * 3);
  const normals = offs.normal >= 0 ? new Float32Array(vCount * 3) : null;
  const uvs = offs.uv >= 0 ? new Float32Array(vCount * 2) : null;
  for (let i = 0; i < vCount; i++) {
    const base = vData + i * vStride;
    const p = readComp(v, base + offs.pos, offs.posType, 3);
    positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2];
    if (normals) {
      const n = readComp(v, base + offs.normal, offs.normalType, 3);
      normals[i * 3] = n[0]; normals[i * 3 + 1] = n[1]; normals[i * 3 + 2] = n[2];
    }
    if (uvs) {
      const u = readComp(v, base + offs.uv, offs.uvType, 2);
      uvs[i * 2] = u[0]; uvs[i * 2 + 1] = u[1];
    }
  }
  const indices = new Uint32Array(iCount);
  for (let i = 0; i < iCount; i++) {
    const idx = v.u16(iData + i * 2);
    indices[i] = idx < vCount ? idx : 0;
  }
  for (const x of positions) if (!Number.isFinite(x) || Math.abs(x) > 1e5) return null;
  return { positions, normals, uvs, indices, textures: shaderTex };
}

function isDiffuseName(n) {
  return n && !/(_n|_s|_m|_nm|_spec|_normal|_mask|_detail)$/i.test(n);
}

// Collect texture names referenced by each shader (best effort).
function shaderTextures(v, shaderGroupAbs) {
  const result = [];
  if (shaderGroupAbs < 0) return result;
  const shadersAbs = v.at(shaderGroupAbs + 0x10);
  const count = v.u16(shaderGroupAbs + 0x18);
  if (shadersAbs < 0 || count > 512) return result;
  for (let i = 0; i < count; i++) {
    const names = [];
    try {
      const s = v.at(shadersAbs + i * 8);
      const params = v.at(s + 0x00);
      const pCount = v.u8(s + 0x10);
      for (let p = 0; p < pCount && params >= 0; p++) {
        const po = params + p * 16;
        if (v.u8(po) !== 0) continue; // 0 == texture parameter
        const texAbs = v.at(po + 8);
        if (texAbs < 0) continue;
        const nm = v.str(v.at(texAbs + 0x28));
        if (nm) names.push(nm.toLowerCase());
      }
    } catch (e) { /* ignore broken shader */ }
    result.push(names);
  }
  return result;
}

/** Extract meshes (highest LOD available) and embedded textures from a drawable at `base`. */
function parseDrawable(v, base = 0) {
  const out = { meshes: [], embeddedTextures: [], warnings: [] };
  const sgAbs = v.at(base + 0x10);
  if (sgAbs >= 0) {
    try { out.embeddedTextures = parseTextureDictionary(v, v.at(sgAbs + 0x08)); }
    catch (e) { out.warnings.push('embedded textures unreadable'); }
  }
  const shTex = (() => { try { return shaderTextures(v, sgAbs); } catch (e) { return []; } })();

  let modelsList = -1;
  for (const lodOff of [0x50, 0x58, 0x60, 0x68]) {
    const lod = v.at(base + lodOff);
    if (lod >= 0) { modelsList = lod; break; }
  }
  if (modelsList < 0) { out.warnings.push('no LOD models'); return out; }
  const listAbs = v.at(modelsList);
  const modelCount = v.u16(modelsList + 8);
  if (listAbs < 0 || modelCount > 256) return out;

  for (let m = 0; m < modelCount; m++) {
    const model = v.at(listAbs + m * 8);
    if (model < 0) continue;
    const geoms = v.at(model + 0x08);
    const gCount = v.u16(model + 0x10);
    const mapAbs = v.at(model + 0x20);
    if (geoms < 0 || gCount > 256) continue;
    for (let g = 0; g < gCount; g++) {
      try {
        const gAbs = v.at(geoms + g * 8);
        const shaderIdx = mapAbs >= 0 ? v.u16(mapAbs + g * 2) : -1;
        const texNames = (shTex[shaderIdx] || []).filter(isDiffuseName);
        const geo = parseGeometry(v, gAbs, texNames);
        if (geo) out.meshes.push(geo);
      } catch (e) {
        out.warnings.push('geometry ' + g + ' unreadable');
      }
    }
  }
  return out;
}

module.exports = { parseDrawable, half };
