'use strict';
// Adds real geometry (3D text, a chain, a pendant) to a drawable (.ydr, gen8 PC).
//
// The new triangles are appended to an existing geometry of the model, so they
// use that geometry's shader, vertex format and textures, and move with the same
// bone. Vertex and index data are rebuilt into the graphics segment, which is
// re-laid out into new pages (blocks never straddle a page). The system segment
// (all the structures) keeps its size and layout; only counts, pointers and
// bounds inside it are updated.
//
// Struct offsets follow CodeWalker (DrawableBase, DrawableModel, DrawableGeometry,
// VertexBuffer, IndexBuffer, VertexDeclaration, RpfResourcePageFlags).

const { ResView, sizeFromFlags } = require('./rsc');
const { parseTexture } = require('./ytd');

const MAX_VERTS = 65535;
const ALIGN = 16;
// VertexComponentType -> size in bytes (CodeWalker VertexComponentTypes)
const COMP_SIZE = [0, 4, 4, 8, 0, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];
const SEM = { POS: 0, NORMAL: 3, COLOUR0: 4, UV0: 6, TANGENT: 14, BINORMAL: 15 };

class GeometryWriteError extends Error {}

// ---------- vertex encoding ----------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(x) {
  f32[0] = x;
  const b = u32[0];
  const s = (b >>> 16) & 0x8000;
  let e = ((b >>> 23) & 0xff) - 127 + 15;
  let m = b & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return s;
    m = (m | 0x800000) >> (1 - e);
    return s | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return s | 0x7c00;
  return s | Math.min(0x7c00, (e << 10) + ((m + 0x1000) >> 13)); // a rounding carry moves into the exponent
}

function writeComp(buf, o, type, vals) {
  switch (type) {
    case 1: for (let i = 0; i < 2; i++) buf.writeUInt16LE(toHalf(vals[i] || 0), o + i * 2); break;
    case 2: buf.writeFloatLE(vals[0] || 0, o); break;
    case 3: for (let i = 0; i < 4; i++) buf.writeUInt16LE(toHalf(vals[i] ?? 0), o + i * 2); break;
    case 5: for (let i = 0; i < 2; i++) buf.writeFloatLE(vals[i] || 0, o + i * 4); break;
    case 6: for (let i = 0; i < 3; i++) buf.writeFloatLE(vals[i] || 0, o + i * 4); break;
    case 7: for (let i = 0; i < 4; i++) buf.writeFloatLE(vals[i] ?? 0, o + i * 4); break;
    case 8: case 9: for (let i = 0; i < 4; i++) buf[o + i] = Math.max(0, Math.min(255, Math.round((vals[i] ?? 1) * 255))); break;
    case 10: for (let i = 0; i < 4; i++) buf.writeInt8(Math.max(-127, Math.min(127, Math.round((vals[i] ?? 0) * 127))), o + i); break;
    default: break;
  }
}

/** Component layout of a vertex declaration: { [semantic]: { o, t } }. */
function layoutOf(v, declAbs, stride) {
  if (declAbs < 0) throw new GeometryWriteError('This model has no vertex format.');
  const flags = v.u32(declAbs);
  const types = v.d.readBigUInt64LE(declAbs + 8);
  const out = {};
  let o = 0;
  for (let k = 0; k < 16; k++) {
    if (!((flags >>> k) & 1)) continue;
    const t = Number((types >> BigInt(k * 4)) & 0xfn);
    out[k] = { o, t };
    o += COMP_SIZE[t];
  }
  if (o !== stride || !out[SEM.POS]) throw new GeometryWriteError('Unsupported vertex format on this model.');
  return out;
}

// ---------- locating structures ----------

const LODS = [0x50, 0x58, 0x60, 0x68];

function modelsOf(v, base, lodOff) {
  const list = v.at(base + lodOff);
  if (list < 0) return [];
  const arr = v.at(list);
  const n = v.u16(list + 8);
  if (arr < 0 || n > 256) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(v.at(arr + i * 8)); // -1 for an empty slot, so indices match ydr.js
  return out;
}

function geometriesOf(v, model) {
  const arr = v.at(model + 0x08);
  const n = v.u16(model + 0x10);
  if (arr < 0 || n > 256) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(v.at(arr + i * 8));
  return out;
}

function geometryInfo(v, g) {
  const vb = v.at(g + 0x18);
  const ib = v.at(g + 0x38);
  if (vb < 0 || ib < 0) return null;
  const stride = v.u16(vb + 0x08);
  const vCount = v.u32(vb + 0x18);
  const iCount = v.u32(ib + 0x08);
  let vData = v.at(vb + 0x10);
  if (vData < 0) vData = v.at(vb + 0x20);
  const iData = v.at(ib + 0x10);
  return { g, vb, ib, stride, vCount, iCount, vData, iData, decl: v.at(vb + 0x30) };
}

/** Every pointer field into the graphics segment that this app understands, with the size of what it points to. */
function knownGfxFields(v, base) {
  const fields = new Map(); // fieldAbs -> size
  const add = (field, size) => {
    const p = v.ptr(field);
    if (p && (p >>> 28) === 6) fields.set(field, size);
  };
  const sg = v.at(base + 0x10);
  if (sg >= 0) {
    const txd = v.at(sg + 0x08);
    if (txd >= 0) {
      const list = v.at(txd + 0x30);
      const n = v.u16(txd + 0x38);
      for (let i = 0; list >= 0 && i < n && i < 1024; i++) {
        const t = v.at(list + i * 8);
        const tex = parseTexture(v, t);
        if (tex) add(t + 0x70, tex.dataSize);
      }
    }
  }
  for (const lod of LODS) {
    for (const m of modelsOf(v, base, lod)) {
      if (m < 0) continue;
      for (const g of geometriesOf(v, m)) {
        const info = g >= 0 && geometryInfo(v, g);
        if (!info) continue;
        const vsize = info.stride * info.vCount;
        add(info.vb + 0x10, vsize);
        add(info.vb + 0x20, vsize);
        add(g + 0x78, vsize);
        add(info.ib + 0x10, info.iCount * 2);
      }
    }
  }
  return fields;
}

// ---------- page layout (RpfResourcePageFlags) ----------

function pageCount(flags) {
  return ((flags >>> 4) & 1) + ((flags >>> 5) & 3) + ((flags >>> 7) & 0xf) + ((flags >>> 11) & 0x3f) + ((flags >>> 17) & 0x7f)
    + ((flags >>> 24) & 1) + ((flags >>> 25) & 1) + ((flags >>> 26) & 1) + ((flags >>> 27) & 1);
}

/** Place chunks (sizes) into equal pages of size P (P >= 0x2000, a power of two). All pages
 *  sit in the "base << 4" tier, so up to 127 of them; returns { P, pages, at[], flags }. */
function layoutPages(sizes, maxPages, typeNibble) {
  const pad = (x) => (x + ALIGN - 1) & ~(ALIGN - 1);
  let P = 0x2000;
  const largest = Math.max(ALIGN, ...sizes);
  while (P < largest) P *= 2;
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  for (;;) {
    const at = new Array(sizes.length);
    const fill = []; // used bytes per page
    for (const i of order) {
      const s = pad(sizes[i]);
      let p = fill.findIndex((f) => f + s <= P);
      if (p < 0) { fill.push(0); p = fill.length - 1; }
      at[i] = p * P + fill[p];
      fill[p] += s;
    }
    const pages = Math.max(1, fill.length);
    if (pages <= Math.min(127, maxPages)) {
      const shift = Math.log2(P / 16 / 0x200);
      const flags = ((typeNibble & 0xf) << 28 | (pages << 17) | shift) >>> 0;
      return { P, pages, at, flags };
    }
    P *= 2;
    if (P > 0x4000000) throw new GeometryWriteError('Model too large to rebuild.');
  }
}

// ---------- the write ----------

/**
 * Append triangles to one geometry of a drawable, in place on `res` (from decodeResource).
 * part: { lod (0..3), model, geometry, template (vertex index to copy unknown attributes from),
 *         positions Float32Array, normals Float32Array, uvs Float32Array, indices (Uint32Array) }
 * Several parts for the same drawable can be passed at once.
 * Returns the new gfxFlags (also written into res.header and res.gfxFlags).
 */
function addGeometry(res, parts, base = 0) {
  let v = new ResView(res);
  const sysSize = res.sysSize;
  const gfxSize = res.data.length - sysSize;

  // 1. new vertex/index data per touched geometry
  const byGeom = new Map();
  for (const part of parts) {
    const models = modelsOf(v, base, LODS[part.lod || 0]);
    const m = models[part.model];
    if (m === undefined || m < 0) throw new GeometryWriteError('Model ' + part.model + ' not found.');
    const g = geometriesOf(v, m)[part.geometry];
    if (g === undefined || g < 0) throw new GeometryWriteError('Geometry ' + part.geometry + ' not found.');
    if (!byGeom.has(g)) byGeom.set(g, { model: m, parts: [] });
    byGeom.get(g).parts.push(part);
  }

  const edits = []; // { info, model, vbytes, ibytes, added positions }
  for (const [g, { model, parts: list }] of byGeom) {
    const info = geometryInfo(v, g);
    if (!info || info.vData < 0 || info.iData < 0) throw new GeometryWriteError('This model part has no vertex data.');
    const lay = layoutOf(v, info.decl, info.stride);
    let addV = 0, addI = 0;
    for (const p of list) { addV += p.positions.length / 3; addI += p.indices.length; }
    const total = info.vCount + addV;
    if (total > MAX_VERTS) throw new GeometryWriteError('Too much detail: ' + total + ' vertices (max ' + MAX_VERTS + '). Use shorter text or fewer chain links.');
    const vbytes = Buffer.alloc(total * info.stride);
    res.data.copy(vbytes, 0, info.vData, info.vData + info.vCount * info.stride);
    const ibytes = Buffer.alloc((info.iCount + addI) * 2);
    res.data.copy(ibytes, 0, info.iData, info.iData + info.iCount * 2);
    let vo = info.vCount, io = info.iCount;
    const added = [];
    for (const p of list) {
      const n = p.positions.length / 3;
      const tpl = Math.max(0, Math.min(info.vCount - 1, p.template | 0));
      const tplBytes = res.data.subarray(info.vData + tpl * info.stride, info.vData + (tpl + 1) * info.stride);
      for (let i = 0; i < n; i++) {
        const o = (vo + i) * info.stride;
        tplBytes.copy(vbytes, o);
        const P = [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
        const N = p.normals ? [p.normals[i * 3], p.normals[i * 3 + 1], p.normals[i * 3 + 2]] : [0, 0, 1];
        // any tangent perpendicular to the normal (the colour patches are flat, so its direction does not matter)
        const ref = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let T = [ref[1] * N[2] - ref[2] * N[1], ref[2] * N[0] - ref[0] * N[2], ref[0] * N[1] - ref[1] * N[0]];
        const tl = Math.hypot(...T) || 1; T = T.map((x) => x / tl);
        const B = [N[1] * T[2] - N[2] * T[1], N[2] * T[0] - N[0] * T[2], N[0] * T[1] - N[1] * T[0]];
        writeComp(vbytes, o + lay[SEM.POS].o, lay[SEM.POS].t, P);
        if (lay[SEM.NORMAL]) writeComp(vbytes, o + lay[SEM.NORMAL].o, lay[SEM.NORMAL].t, lay[SEM.NORMAL].t === 9 || lay[SEM.NORMAL].t === 8 ? N.map((x) => x * 0.5 + 0.5).concat(0) : N.concat(0));
        if (lay[SEM.UV0] && p.uvs) writeComp(vbytes, o + lay[SEM.UV0].o, lay[SEM.UV0].t, [p.uvs[i * 2], p.uvs[i * 2 + 1], 0, 0]);
        if (lay[SEM.TANGENT]) writeComp(vbytes, o + lay[SEM.TANGENT].o, lay[SEM.TANGENT].t, T.concat(1));
        if (lay[SEM.BINORMAL]) writeComp(vbytes, o + lay[SEM.BINORMAL].o, lay[SEM.BINORMAL].t, B.concat(1));
        added.push(P);
      }
      for (let k = 0; k < p.indices.length; k++) {
        const idx = p.indices[k];
        if (idx >= n) throw new GeometryWriteError('Bad index in new geometry.');
        ibytes.writeUInt16LE(vo + idx, (io + k) * 2);
      }
      vo += n; io += p.indices.length;
    }
    edits.push({ info, model, vbytes, ibytes, vCount: total, iCount: io, added });
  }

  // 2. every pointer into the graphics segment must be one we understand
  const known = knownGfxFields(v, base);
  for (let o = 0; o + 8 <= sysSize; o += 8) {
    const lo = v.d.readUInt32LE(o), hi = v.d.readUInt32LE(o + 4);
    if (hi === 0 && (lo >>> 28) === 6 && (lo & 0x0fffffff) < gfxSize && !known.has(o)) {
      throw new GeometryWriteError('This model has data this app does not know (at 0x' + o.toString(16) + '), so nothing was added to it.');
    }
  }

  // 3. the pointers that move to the new data
  const redirect = new Map(); // fieldAbs -> index of new block
  const newBlocks = [];
  for (const e of edits) {
    const vi = newBlocks.push(e.vbytes) - 1;
    const ii = newBlocks.push(e.ibytes) - 1;
    for (const f of [e.info.vb + 0x10, e.info.vb + 0x20, e.info.g + 0x78]) if (v.ptr(f)) redirect.set(f, vi);
    if (!v.ptr(e.info.vb + 0x10)) redirect.set(e.info.vb + 0x10, vi);
    redirect.set(e.info.ib + 0x10, ii);
  }

  // 4. old graphics data that is still used, merged into contiguous chunks
  const ranges = [];
  for (const [field, size] of known) {
    if (redirect.has(field)) continue;
    const off = v.ptr(field) & 0x0fffffff;
    ranges.push({ field, s: off, e: Math.min(gfxSize, off + Math.max(size, 1)) });
  }
  ranges.sort((a, b) => a.s - b.s);
  const chunks = [];
  for (const r of ranges) {
    const last = chunks[chunks.length - 1];
    if (last && r.s < last.e) { last.e = Math.max(last.e, r.e); last.fields.push(r); }
    else chunks.push({ s: r.s, e: r.e, fields: [r] });
  }

  const sizes = chunks.map((c) => c.e - c.s).concat(newBlocks.map((b) => b.length));
  const sysPages = pageCount(res.sysFlags);
  const lay = layoutPages(sizes, 128 - sysPages, res.gfxFlags >>> 28);

  // 5. build the new graphics segment
  const gfx = Buffer.alloc(lay.P * lay.pages);
  const oldGfx = res.data.subarray(sysSize);
  const sys = Buffer.from(res.data.subarray(0, sysSize));
  const setPtr = (field, off) => { sys.writeUInt32LE((0x60000000 + off) >>> 0, field); sys.writeUInt32LE(0, field + 4); };
  chunks.forEach((c, i) => {
    oldGfx.copy(gfx, lay.at[i], c.s, c.e);
    for (const r of c.fields) setPtr(r.field, lay.at[i] + (r.s - c.s));
  });
  newBlocks.forEach((b, i) => b.copy(gfx, lay.at[chunks.length + i]));
  for (const [field, bi] of redirect) setPtr(field, lay.at[chunks.length + bi]);

  // 6. counts and bounds
  const fl = (o) => sys.readFloatLE(o);
  const grow = (minO, maxO, pts, margin = 0.002) => {
    for (const P of pts) {
      for (let k = 0; k < 3; k++) {
        if (P[k] - margin < fl(minO + k * 4)) sys.writeFloatLE(P[k] - margin, minO + k * 4);
        if (P[k] + margin > fl(maxO + k * 4)) sys.writeFloatLE(P[k] + margin, maxO + k * 4);
      }
    }
  };
  const allAdded = [];
  for (const e of edits) {
    const { info, model } = e;
    sys.writeUInt32LE(e.vCount, info.vb + 0x18);
    sys.writeUInt32LE(e.iCount, info.ib + 0x08);
    if (sys.readUInt32LE(info.g + 0x58) || sys.readUInt16LE(info.g + 0x60)) {
      sys.writeUInt32LE(e.iCount, info.g + 0x58);
      sys.writeUInt32LE(e.iCount / 3, info.g + 0x5c);
      sys.writeUInt16LE(e.vCount, info.g + 0x60);
    }
    const bounds = v.at(model + 0x18);
    if (bounds >= 0) {
      const n = v.u16(model + 0x10);
      const count = n > 1 ? n + 1 : n;
      for (let i = 0; i < count; i++) grow(bounds + i * 32, bounds + i * 32 + 16, e.added);
    }
    allAdded.push(...e.added);
  }
  // drawable box and sphere
  const hasBox = fl(base + 0x30) <= fl(base + 0x40);
  if (hasBox && allAdded.length) {
    grow(base + 0x30, base + 0x40, allAdded);
    const c = [fl(base + 0x20), fl(base + 0x24), fl(base + 0x28)];
    let r = fl(base + 0x2c);
    for (const P of allAdded) r = Math.max(r, Math.hypot(P[0] - c[0], P[1] - c[1], P[2] - c[2]) + 0.002);
    sys.writeFloatLE(r, base + 0x2c);
  }

  res.data = Buffer.concat([sys, gfx]);
  res.gfxFlags = lay.flags;
  res.gfxSize = gfx.length;
  if (sizeFromFlags(lay.flags) !== gfx.length) throw new GeometryWriteError('Page layout error.');
  res.header.writeUInt32LE(lay.flags, 12);
  return lay.flags;
}

module.exports = { addGeometry, layoutPages, toHalf, GeometryWriteError, pageCount };
