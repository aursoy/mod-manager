'use strict';
// Builds a small but complete gen8 drawable (.ydr) the way GTA V lays them out:
// drawable -> shader group (embedded texture dictionary, one shader) -> high LOD
// model list -> one model with two geometries (vertex/index buffers, a GTAV1
// vertex declaration, shader mapping, bounds). Vertex/index data go in the
// graphics segment (Rockstar files) or the system segment (CodeWalker exports).

const zlib = require('zlib');

const GTAV1 = 0x7755555555996996n;
const DECL_FLAGS = 0x4059; // position, normal, colour0, texcoord0, tangent
const STRIDE = 12 + 12 + 4 + 8 + 16;

function buildYdr({ dataInGfx = true } = {}) {
  const sys = Buffer.alloc(0x2000);
  const gfx = Buffer.alloc(0x2000);
  let sp = 0, gp = 0;
  const alloc = (n, align = 16) => { sp = (sp + align - 1) & ~(align - 1); const o = sp; sp += n; return o; };
  const galloc = (n) => { gp = (gp + 15) & ~15; const o = gp; gp += n; return o; };
  const sptr = (field, off) => { sys.writeUInt32LE(0x50000000 + off, field); };
  const gptr = (field, off) => { sys.writeUInt32LE(0x60000000 + off, field); };
  const dptr = (field, off, inGfx) => (inGfx ? gptr(field, off) : sptr(field, off));

  const drawable = alloc(0xd0);
  // texture dictionary + texture
  const sg = alloc(0x40);
  const txd = alloc(0x40);
  const list = alloc(8);
  const tex = alloc(0x90);
  const name = alloc(16);
  sys.write('w_pi_test\0', name, 'latin1');
  sptr(sg + 0x08, txd);
  sptr(txd + 0x30, list); sys.writeUInt16LE(1, txd + 0x38); sys.writeUInt16LE(1, txd + 0x3a);
  sptr(list, tex);
  sptr(tex + 0x28, name);
  sys.writeUInt16LE(64, tex + 0x50); sys.writeUInt16LE(64, tex + 0x52);
  sys.writeUInt32LE(0x31545844, tex + 0x58); sys[tex + 0x5d] = 1;
  const texData = galloc(2048);
  for (let i = 0; i < 2048; i++) gfx[texData + i] = (i * 7) & 0xff;
  gptr(tex + 0x70, texData);
  // one shader with the texture as its first parameter
  const shaders = alloc(8);
  const shader = alloc(0x30);
  const params = alloc(16);
  sptr(sg + 0x10, shaders); sys.writeUInt16LE(1, sg + 0x18);
  sptr(shaders, shader);
  sptr(shader, params); sys[shader + 0x10] = 1;
  sys[params] = 0; sptr(params + 8, tex);
  sptr(drawable + 0x10, sg);

  // vertex declaration
  const decl = alloc(16);
  sys.writeUInt32LE(DECL_FLAGS, decl); sys.writeUInt16LE(STRIDE, decl + 4); sys[decl + 7] = 5;
  sys.writeBigUInt64LE(GTAV1, decl + 8);

  const meshes = [
    { verts: [[0, 0, 0], [0.2, 0, 0], [0.2, 0, 0.1], [0, 0, 0.1]], idx: [0, 1, 2, 0, 2, 3] },
    { verts: [[0, -0.02, -0.08], [0.03, -0.02, -0.08], [0.03, -0.02, 0]], idx: [0, 1, 2] },
  ];
  const geoms = [];
  for (const m of meshes) {
    const g = alloc(0x98), vb = alloc(0x80), ib = alloc(0x60);
    const vdata = Buffer.alloc(m.verts.length * STRIDE);
    m.verts.forEach((p, i) => {
      const o = i * STRIDE;
      p.forEach((x, k) => vdata.writeFloatLE(x, o + k * 4));
      [0, -1, 0].forEach((x, k) => vdata.writeFloatLE(x, o + 12 + k * 4));
      vdata.writeUInt32LE(0xff808080, o + 24);
      vdata.writeFloatLE(p[0] * 2, o + 28); vdata.writeFloatLE(p[2] * 2, o + 32);
      [1, 0, 0, 1].forEach((x, k) => vdata.writeFloatLE(x, o + 36 + k * 4));
    });
    const idata = Buffer.alloc(m.idx.length * 2);
    m.idx.forEach((x, i) => idata.writeUInt16LE(x, i * 2));
    let vOff, iOff;
    if (dataInGfx) { vOff = galloc(vdata.length); vdata.copy(gfx, vOff); iOff = galloc(idata.length); idata.copy(gfx, iOff); }
    else { vOff = alloc(vdata.length); vdata.copy(sys, vOff); iOff = alloc(idata.length); idata.copy(sys, iOff); }
    sptr(g + 0x18, vb); sptr(g + 0x38, ib);
    sys.writeUInt32LE(m.idx.length, g + 0x58); sys.writeUInt32LE(m.idx.length / 3, g + 0x5c);
    sys.writeUInt16LE(m.verts.length, g + 0x60); sys.writeUInt16LE(3, g + 0x62);
    sys.writeUInt16LE(STRIDE, g + 0x70);
    dptr(g + 0x78, vOff, dataInGfx);
    sys.writeUInt16LE(STRIDE, vb + 0x08);
    dptr(vb + 0x10, vOff, dataInGfx); sys.writeUInt32LE(m.verts.length, vb + 0x18); dptr(vb + 0x20, vOff, dataInGfx);
    sptr(vb + 0x30, decl);
    sys.writeUInt32LE(m.idx.length, ib + 0x08); dptr(ib + 0x10, iOff, dataInGfx);
    geoms.push(g);
  }
  // model: geometry pointers, shader mapping, bounds (overall + one per geometry)
  const model = alloc(0x30);
  const gptrs = alloc(16);
  const mapping = alloc(4);
  const bounds = alloc(32 * 3);
  geoms.forEach((g, i) => sptr(gptrs + i * 8, g));
  sptr(model + 0x08, gptrs); sys.writeUInt16LE(2, model + 0x10); sys.writeUInt16LE(2, model + 0x12);
  sptr(model + 0x18, bounds); sptr(model + 0x20, mapping); sys.writeUInt16LE(2, model + 0x2e);
  const box = (i, mn, mx) => { mn.forEach((x, k) => sys.writeFloatLE(x, bounds + i * 32 + k * 4)); mx.forEach((x, k) => sys.writeFloatLE(x, bounds + i * 32 + 16 + k * 4)); };
  box(0, [0, -0.02, -0.08], [0.2, 0, 0.1]); box(1, [0, 0, 0], [0.2, 0, 0.1]); box(2, [0, -0.02, -0.08], [0.03, -0.02, 0]);
  const models = alloc(16);
  const marr = alloc(8);
  sptr(models, marr); sys.writeUInt16LE(1, models + 8); sys.writeUInt16LE(1, models + 10);
  sptr(marr, model);
  sptr(drawable + 0x50, models);
  // drawable bounds
  [0.1, -0.01, 0.01].forEach((x, k) => sys.writeFloatLE(x, drawable + 0x20 + k * 4));
  sys.writeFloatLE(0.15, drawable + 0x2c);
  [0, -0.02, -0.08].forEach((x, k) => sys.writeFloatLE(x, drawable + 0x30 + k * 4));
  [0.2, 0, 0.1].forEach((x, k) => sys.writeFloatLE(x, drawable + 0x40 + k * 4));
  if (sp > sys.length || gp > gfx.length) throw new Error('fixture too big');

  const sysFlags = 0xa8000004, gfxFlags = 0x58000004; // one 0x2000 page each, resource version 165
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x37435352, 0); header.writeUInt32LE(165, 4);
  header.writeUInt32LE(sysFlags, 8); header.writeUInt32LE(gfxFlags, 12);
  return Buffer.concat([header, zlib.deflateRawSync(Buffer.concat([sys, gfx]))]);
}

module.exports = { buildYdr, STRIDE };
