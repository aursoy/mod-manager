'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rpf = require('../src/core/rpf');
const { decodeResource, encodeResource, ResView, sizeFromFlags } = require('../src/core/rsc');
const { parseDrawable } = require('../src/core/ydr');
const { addGeometry, layoutPages, toHalf, GeometryWriteError } = require('../src/core/ydrwrite');
const { half } = require('../src/core/ydr');
const { GunPack } = require('../src/core/gunpack');
const { buildYdr } = require('./ydr-fixture');

const tri = (z = 0.3) => ({
  lod: 0, model: 0, geometry: 0, template: 1,
  positions: new Float32Array([0.05, -0.01, 0.03, 0.08, -0.01, 0.03, 0.08, -0.01, z]),
  normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
  uvs: new Float32Array([0.9, 0.9, 0.95, 0.9, 0.95, 0.95]),
  indices: new Uint32Array([0, 1, 2]),
});

for (const dataInGfx of [true, false]) {
  test('3D parts: triangles are added to a model part, everything else stays byte-identical (' + (dataInGfx ? 'Rockstar layout' : 'CodeWalker layout') + ')', () => {
    const stored = buildYdr({ dataInGfx });
    const orig = decodeResource(stored);
    const before = parseDrawable(new ResView(orig), 0);
    const res = decodeResource(stored);
    addGeometry(res, [tri()]);
    const re = decodeResource(encodeResource(res));
    assert.strictEqual(re.data.length, sizeFromFlags(re.sysFlags) + sizeFromFlags(re.gfxFlags), 'page flags describe the data');
    const after = parseDrawable(new ResView(re), 0);
    const [m0, m1] = after.meshes;
    assert.strictEqual(m0.positions.length / 3, before.meshes[0].positions.length / 3 + 3);
    assert.deepStrictEqual(Array.from(m0.positions.slice(0, 12)), Array.from(before.meshes[0].positions), 'old vertices untouched');
    assert.deepStrictEqual(Array.from(m0.indices), [0, 1, 2, 0, 2, 3, 4, 5, 6], 'new triangle uses the new vertices');
    assert.ok(Math.abs(m0.positions[20] - 0.3) < 1e-6);
    assert.ok(Math.abs(m0.uvs[8] - 0.9) < 1e-6 && Math.abs(m0.normals[13] + 1) < 1e-6);
    assert.deepStrictEqual(Array.from(m1.positions), Array.from(before.meshes[1].positions), 'other part untouched');
    const t0 = before.embeddedTextures[0], t1 = after.embeddedTextures[0];
    assert.ok(orig.data.subarray(t0.dataOffset, t0.dataOffset + t0.dataSize).equals(re.data.subarray(t1.dataOffset, t1.dataOffset + t1.dataSize)), 'texture data moved intact');
    const v = new ResView(re);
    assert.ok(v.f32(0x48) >= 0.3, 'drawable box grows to the new part');
    assert.ok(v.f32(0x2c) >= 0.29, 'bounding sphere too');
    // the vertex buffer, the geometry and the index buffer agree on the counts
    const geo = v.at(v.at(v.at(v.at(0x50))) + 0x08);
    const g = v.at(geo);
    assert.strictEqual(v.u16(g + 0x60), 7);
    assert.strictEqual(v.u32(g + 0x58), 9);
    assert.strictEqual(v.u32(g + 0x5c), 3);
    // the original template vertex's colour was copied
    const vb = v.at(g + 0x18);
    const data = v.at(vb + 0x10);
    assert.strictEqual(v.u32(data + 6 * 52 + 24), 0xff808080);
  });
}

test('3D parts: a file with data the app does not understand is left alone', () => {
  const stored = buildYdr();
  const res = decodeResource(stored);
  res.data.writeUInt32LE(0x60000010, 0x08); // a stray pointer into the graphics pages
  assert.throws(() => addGeometry(res, [tri()]), GeometryWriteError);
});

test('3D parts: too many vertices is refused with a clear message', () => {
  const res = decodeResource(buildYdr());
  const n = 70000;
  const big = { ...tri(), positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), uvs: new Float32Array(n * 2), indices: new Uint32Array([0, 1, 2]) };
  assert.throws(() => addGeometry(res, [big]), /Too much detail/);
});

test('page layout: blocks never straddle a page and flags match', () => {
  const sizes = [300000, 70000, 70000, 5000, 16, 9000, 131072];
  const lay = layoutPages(sizes, 100, 5);
  assert.strictEqual(sizeFromFlags(lay.flags), lay.P * lay.pages);
  assert.strictEqual(lay.flags >>> 28, 5);
  sizes.forEach((s, i) => assert.ok(Math.floor(lay.at[i] / lay.P) === Math.floor((lay.at[i] + s - 1) / lay.P), 'block ' + i + ' inside one page'));
  const spans = sizes.map((s, i) => [lay.at[i], lay.at[i] + s]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], 'no overlap');
});

test('half floats round trip', () => {
  for (const x of [0, 1, -1, 0.5, 0.123, 65504, 1e-5]) assert.ok(Math.abs(half(toHalf(x)) - x) <= Math.abs(x) * 1e-3 + 1e-7, String(x));
});

test('gun pack: exporting 3D parts twice gives the same file, and the parts are in the model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-gun3d-'));
  const stored = buildYdr();
  const file = path.join(dir, 'w_pi_test.rpf');
  fs.writeFileSync(file, rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'res', name: 'w_pi_test.ydr', stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) }] }));
  const gun = new GunPack(file);
  const d = gun.describe();
  const t = d.assets[0].textures[0];
  const edits = [{ assetId: 0, textureIndex: 0, data: Buffer.alloc(t.data.length, 0x42) }];
  const geometry = [{ assetId: 0, ...tri() }];
  gun.applyEdits(edits, geometry);
  const a = gun.write(path.join(dir, 'a.rpf'));
  gun.applyEdits(edits, geometry);
  const b = gun.write(path.join(dir, 'b.rpf'));
  assert.strictEqual(a, b);
  assert.ok(fs.readFileSync(path.join(dir, 'a.rpf')).equals(fs.readFileSync(path.join(dir, 'b.rpf'))), 'no parts added twice');
  const back = new GunPack(path.join(dir, 'a.rpf'));
  assert.strictEqual(back.assets[0].meshes[0].positions.length / 3, 7);
  const tex = back.describe().assets[0].textures[0];
  assert.ok(Buffer.from(tex.data).every((x) => x === 0x42), 'texture edit kept after the pages moved');
});
