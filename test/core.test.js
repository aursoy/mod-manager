'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const rpf = require('../src/core/rpf');
const { sizeFromFlags, RSC7_MAGIC } = require('../src/core/rsc');
const { GunPack } = require('../src/core/gunpack');
const { CitizenManager } = require('../src/core/citizen');

// Build a minimal gen8 texture dictionary resource with one DXT1 texture.
function buildYtd(name, w, h, fill) {
  const sys = Buffer.alloc(0x2000);
  const gfx = Buffer.alloc(0x2000);
  const S = 0x50000000, G = 0x60000000;
  // dictionary at 0, texture list at 0x40, texture at 0x80, name at 0x120
  sys.writeUInt32LE(S + 0x40, 0x30); sys.writeUInt16LE(1, 0x38); sys.writeUInt16LE(1, 0x3a);
  sys.writeUInt32LE(S + 0x80, 0x40);
  const t = 0x80;
  sys.writeUInt32LE(S + 0x120, t + 0x28);
  sys.writeUInt16LE(w, t + 0x50); sys.writeUInt16LE(h, t + 0x52); sys.writeUInt16LE(1, t + 0x54);
  sys.writeUInt32LE(0x31545844, t + 0x58); sys[t + 0x5d] = 1;
  sys.writeUInt32LE(G + 0, t + 0x70);
  sys.write(name + '\0', 0x120, 'latin1');
  gfx.fill(fill, 0, (w / 4) * (h / 4) * 8);
  const sysFlags = (1 << 27) | 4;
  const gfxFlags = ((13 << 28) | (1 << 27) | 4) >>> 0;
  assert.strictEqual(sizeFromFlags(sysFlags), 0x2000);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(RSC7_MAGIC, 0); hdr.writeUInt32LE(13, 4); hdr.writeUInt32LE(sysFlags, 8); hdr.writeUInt32LE(gfxFlags, 12);
  return { stored: Buffer.concat([hdr, zlib.deflateRawSync(Buffer.concat([sys, gfx]))]), sysFlags, gfxFlags };
}

function buildArchive() {
  const a = buildYtd('w_pi_pistol', 64, 64, 0x11);
  const b = buildYtd('w_ar_rifle', 32, 32, 0x22);
  const inner = {
    type: 'dir', name: '', children: [
      { type: 'res', name: 'w_ar_rifle.ytd', stored: b.stored, sysFlags: b.sysFlags, gfxFlags: b.gfxFlags },
    ],
  };
  const innerBuf = rpf.writeRpf(inner);
  return {
    type: 'dir', name: '', children: [
      { type: 'dir', name: 'weapons', children: [
        { type: 'res', name: 'w_pi_pistol.ytd', stored: a.stored, sysFlags: a.sysFlags, gfxFlags: a.gfxFlags },
        { type: 'bin', name: 'readme.txt', stored: zlib.deflateRawSync(Buffer.from('hello')), compressed: true, size: 5 },
      ] },
      { type: 'bin', name: 'nested.rpf', stored: innerBuf, compressed: false, size: innerBuf.length },
    ],
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-test-'));

test('rpf round trip keeps tree and data', () => {
  const buf = rpf.writeRpf(buildArchive());
  const root = rpf.readRpf(buf);
  const names = [];
  rpf.walk(root, (e, p) => names.push(p));
  assert.deepStrictEqual(names.sort(), ['nested.rpf', 'weapons/readme.txt', 'weapons/w_pi_pistol.ytd']);
  const readme = root.children.find((c) => c.name === 'weapons').children.find((c) => c.name === 'readme.txt');
  assert.strictEqual(rpf.getBinaryData(readme).toString(), 'hello');
  assert.deepStrictEqual(rpf.readRpf(rpf.writeRpf(root)), root);
});

test('gun pack finds textures in nested archives, patches and re-exports', () => {
  const file = path.join(tmp, 'gun.rpf');
  fs.writeFileSync(file, rpf.writeRpf(buildArchive()));
  const pack = new GunPack(file);
  const d = pack.describe();
  const all = d.assets.flatMap((a) => a.textures.map((t) => ({ a: a.id, t })));
  assert.strictEqual(all.length, 2);
  const pistol = all.find((x) => x.t.name === 'w_pi_pistol');
  assert.strictEqual(pistol.t.width, 64);
  assert.strictEqual(pistol.t.format, 'DXT1');
  assert.ok(pistol.t.data.every((b) => b === 0x11));
  const rifle = all.find((x) => x.t.name === 'w_ar_rifle');

  pack.applyEdits([
    { assetId: pistol.a, textureIndex: 0, data: new Uint8Array(pistol.t.data.length).fill(0x99) },
    { assetId: rifle.a, textureIndex: 0, data: new Uint8Array(rifle.t.data.length).fill(0x77) },
  ]);
  const out = path.join(tmp, 'gun_out.rpf');
  pack.write(out);
  const again = new GunPack(out).describe();
  const t2 = again.assets.flatMap((a) => a.textures);
  assert.ok(t2.find((t) => t.name === 'w_pi_pistol').data.every((b) => b === 0x99));
  assert.ok(t2.find((t) => t.name === 'w_ar_rifle').data.every((b) => b === 0x77));
  assert.throws(() => pack.applyEdits([{ assetId: pistol.a, textureIndex: 0, data: new Uint8Array(3) }]), /size mismatch/);
});

test('encrypted archives give a clear error', () => {
  const buf = rpf.writeRpf(buildArchive());
  buf.writeUInt32LE(0x0fefffff, 12);
  assert.throws(() => rpf.readRpf(buf), /encrypted/);
});

test('dxt codec round trips with low error', async () => {
  const dxt = await import('../renderer/js/dxt.js');
  const w = 64, h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = x * 4; rgba[i + 1] = y * 4; rgba[i + 2] = 128; rgba[i + 3] = (x + y) * 2;
  }
  const opaque = new Uint8ClampedArray(rgba);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  for (const f of ['DXT1', 'DXT3', 'DXT5', 'A8R8G8B8', 'A8B8G8R8']) {
    // DXT1 only has 1-bit alpha, so test its colour on opaque input.
    const enc = dxt.encode(f, f === 'DXT1' ? opaque : rgba, w, h);
    assert.strictEqual(enc.length, dxt.levelSize(f, w, h));
    const dec = dxt.decode(f, enc, w, h);
    let err = 0;
    for (let i = 0; i < rgba.length; i += 4) err += Math.abs(dec[i] - rgba[i]) + Math.abs(dec[i + 1] - rgba[i + 1]);
    const mean = err / (w * h * 2);
    assert.ok(mean < 6, f + ' colour error too high: ' + mean);
    if (f !== 'DXT1') {
      let aerr = 0;
      for (let i = 3; i < rgba.length; i += 4) aerr += Math.abs(dec[i] - rgba[i]);
      assert.ok(aerr / (w * h) < 10, f + ' alpha error too high');
    }
  }
});

test('citizen manager: tweaks, colour and full restore are reversible', () => {
  const cit = path.join(tmp, 'FiveM.app', 'citizen');
  const tc = path.join(cit, 'common', 'data', 'timecycle');
  fs.mkdirSync(tc, { recursive: true });
  const original = '<timecycle_keyframe_data><region name="GLOBAL"><sky_zenith_col_r>0.5 1.0</sky_zenith_col_r><sky_zenith_col_g>0.5 1.0</sky_zenith_col_g><sky_zenith_col_b>0.5 1.0</sky_zenith_col_b><light_dir_mult>2.0</light_dir_mult></region></timecycle_keyframe_data>';
  fs.writeFileSync(path.join(tc, 'w_extrasunny.xml'), original);

  const m = new CitizenManager(path.join(tmp, 'userdata'));
  assert.strictEqual(m.setCitizen(path.join(tmp, 'FiveM.app')).citizenPath, cit);

  const water = path.join(cit, 'common', 'data', 'levels', 'gta5', 'water.xml');
  m.setTweak('water', true);
  assert.ok(fs.readFileSync(water, 'utf8').includes('<WaterQuads>'));
  m.setTweak('water', false);
  assert.ok(!fs.existsSync(water));

  const src = path.join(tmp, 'mtn', 'citizen', 'common', 'data');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'mountain.dat'), 'x');
  const mtn = m.addCustom('My tweak', [path.join(tmp, 'mtn')], 'tweak');
  m.setTweak(mtn, true);
  assert.ok(fs.existsSync(path.join(cit, 'common', 'data', 'mountain.dat')));

  const r = m.applyColour({ r: 255, g: 0, b: 0, strength: 1, brightness: 0, groups: ['sky'] });
  assert.strictEqual(r.tags, 3);
  m.applyColour({ r: 255, g: 0, b: 0, strength: 1, brightness: 0, groups: ['sky'] }); // not cumulative
  const graded = fs.readFileSync(path.join(tc, 'w_extrasunny.xml'), 'utf8');
  assert.ok(graded.includes('<sky_zenith_col_r>1.5 3</sky_zenith_col_r>'), graded);
  assert.ok(graded.includes('<sky_zenith_col_g>0 0</sky_zenith_col_g>'));
  assert.ok(graded.includes('<light_dir_mult>2.0</light_dir_mult>'));

  m.restoreAll();
  assert.strictEqual(fs.readFileSync(path.join(tc, 'w_extrasunny.xml'), 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(cit, 'common', 'data', 'mountain.dat')));
  assert.strictEqual(m.listBackups().length, 0);
});


test('citizen manager: loose files like jay.xml and folders with readme import cleanly', () => {
  const cit = path.join(tmp, 'FiveM_loose.app', 'citizen');
  fs.mkdirSync(path.join(cit, 'common'), { recursive: true });
  const m = new CitizenManager(path.join(tmp, 'userdata_loose'));
  m.setCitizen(path.join(tmp, 'FiveM_loose.app'));

  // 1. Direct loose jay.xml file import
  const jayPath = path.join(tmp, 'jay.xml');
  const jayContent = '<timecycle_keyframe_data><region name="GLOBAL"><sky_zenith_col_r>0.2 0.8</sky_zenith_col_r></region></timecycle_keyframe_data>';
  fs.writeFileSync(jayPath, jayContent);

  const customId = m.addCustom('Jay Graphics', [jayPath], 'pack');
  assert.ok(customId);
  m.setTweak(customId, true);
  const installedJay = path.join(cit, 'common', 'data', 'timecycle', 'jay.xml');
  assert.ok(fs.existsSync(installedJay), 'jay.xml should be installed in common/data/timecycle/');
  assert.strictEqual(fs.readFileSync(installedJay, 'utf8'), jayContent);

  // scanTimecycle should find it
  const scan = m.scanTimecycle();
  assert.ok(scan.files.includes('common/data/timecycle/jay.xml'));

  // 2. Loose folder import with readme.txt and custom data XML
  const folder = path.join(tmp, 'LoosePack');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'readme.txt'), 'Instructions');
  fs.writeFileSync(path.join(folder, 'preview.png'), 'fake-png');
  fs.writeFileSync(path.join(folder, 'custom.dat'), 'data-content');

  const folderId = m.addCustom('Folder Pack', [folder], 'pack');
  assert.ok(folderId);
  m.setTweak(folderId, true);
  const installedDat = path.join(cit, 'common', 'data', 'custom.dat');
  assert.ok(fs.existsSync(installedDat), 'custom.dat should be in common/data/');
  assert.ok(!fs.existsSync(path.join(cit, 'readme.txt')), 'readme.txt must not be imported');

  m.restoreAll();
  assert.ok(!fs.existsSync(installedJay));
  assert.ok(!fs.existsSync(installedDat));
});


test('citizen manager: timecycle cycler items, targeted grading and weather activation', () => {
  const cit = path.join(tmp, 'FiveM_tc.app', 'citizen');
  const tc = path.join(cit, 'common', 'data', 'timecycle');
  fs.mkdirSync(tc, { recursive: true });

  const jayXml = '<timecycle_keyframe_data><cycle name="EXTRASUNNY"><region name="GLOBAL"><sky_zenith_col_r>0.5 1.0</sky_zenith_col_r><sky_zenith_col_g>0.5 1.0</sky_zenith_col_g><sky_zenith_col_b>0.5 1.0</sky_zenith_col_b></region></cycle></timecycle_keyframe_data>';
  const modsXml = '<timecycle_modifier_data><modifier name="pulse"><light_dir_col_r>1.0</light_dir_col_r><light_dir_col_g>1.0</light_dir_col_g><light_dir_col_b>1.0</light_dir_col_b></modifier></timecycle_modifier_data>';

  fs.writeFileSync(path.join(tc, 'jay.xml'), jayXml);
  fs.writeFileSync(path.join(tc, 'timecycle_mods_1.xml'), modsXml);

  const m = new CitizenManager(path.join(tmp, 'userdata_tc'));
  m.setCitizen(path.join(tmp, 'FiveM_tc.app'));

  const scan = m.scanTimecycle();
  assert.strictEqual(scan.files.length, 2);
  assert.ok(scan.items.length >= 2);
  const jayItem = scan.items.find((x) => x.name === 'jay.xml');
  assert.ok(jayItem);
  assert.ok(jayItem.cycles.includes('EXTRASUNNY'));

  // Target specific file and activate as weather
  const res = m.applyColour({
    target: 'common/data/timecycle/jay.xml',
    activateWeather: true,
    r: 255, g: 0, b: 0, strength: 1, brightness: 0, groups: ['sky']
  });
  assert.strictEqual(res.files, 1);
  assert.strictEqual(res.tags, 3);
  assert.ok(res.activated);

  // Both w_extrasunny.xml and w_clear.xml should be created with the graded jay.xml
  const activeSunny = path.join(tc, 'w_extrasunny.xml');
  const activeClear = path.join(tc, 'w_clear.xml');
  assert.ok(fs.existsSync(activeSunny));
  assert.ok(fs.existsSync(activeClear));
  assert.ok(fs.readFileSync(activeSunny, 'utf8').includes('<sky_zenith_col_r>1.5 3</sky_zenith_col_r>'));

  // Manual activate test
  const act = m.activateTimecycle('common/data/timecycle/jay.xml');
  assert.ok(act.activated.length >= 2);

  m.restoreAll();
  assert.ok(!fs.existsSync(activeSunny));
  assert.ok(!fs.existsSync(activeClear));
});

test('texture codec: single-channel, normal map, 16-bit and 8-bit formats round trip', async () => {
  const dxt = await import('../renderer/js/dxt.js');
  const w = 32, h = 32;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = (i * 7) & 255; rgba[i * 4 + 1] = (i * 3) & 255; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = i & 1 ? 255 : 0; }
  const near = (f, ch, tol) => {
    const dec = dxt.decode(f, dxt.encode(f, rgba, w, h), w, h);
    let e = 0;
    for (let i = 0; i < w * h; i++) e += Math.abs(dec[i * 4 + ch] - rgba[i * 4 + ch]);
    assert.ok(e / (w * h) <= tol, f + ' channel ' + ch + ' error ' + e / (w * h));
  };
  for (const f of ['ATI1', 'ATI2']) assert.strictEqual(dxt.encode(f, rgba, w, h).length, dxt.levelSize(f, w, h));
  near('ATI1', 0, 40); near('ATI2', 0, 40); near('ATI2', 1, 40);
  near('A1R5G5B5', 0, 4); near('A1R5G5B5', 3, 0);
  near('X8R8G8B8', 0, 0); near('A8', 3, 0);
  const l8 = dxt.decode('L8', dxt.encode('L8', rgba, w, h), w, h);
  assert.strictEqual(l8[0], l8[1]);
  for (const f of ['ATI1', 'ATI2', 'A1R5G5B5', 'X8R8G8B8', 'A8', 'L8']) assert.ok(dxt.EDITABLE.includes(f));
});
