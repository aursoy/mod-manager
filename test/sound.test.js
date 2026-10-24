'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const rpf = require('../src/core/rpf');
const awc = require('../src/core/awc');
const { SoundPack } = require('../src/core/soundpack');
const extras = require('../src/core/extras');
const { CitizenManager } = require('../src/core/citizen');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-sound-'));

function tone(n, freq, rate) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((i / rate) * freq * Math.PI * 2) * 12000);
  return out;
}

function fmtChunk(samples, rate, codec) {
  const f = Buffer.alloc(24);
  f.writeUInt32LE(samples, 0); f.writeInt32LE(-1, 4); f.writeUInt16LE(rate, 8); f[19] = codec;
  return f;
}

// Build a bank with one PCM and one ADPCM stream, each with format/data/peak chunks.
function buildBank() {
  const a = tone(9000, 440, 32000), b = tone(12000, 220, 24000);
  const aData = Buffer.alloc(a.length * 2); a.forEach((v, i) => aData.writeInt16LE(v, i * 2));
  const bank = {
    version: 1, flags: 0xff01, chunkIndices: [0, 3],
    streams: [
      { id: 0x0abc1234, chunkCount: 3, chunks: [
        { type: awc.CHUNK.format, data: fmtChunk(a.length, 32000, awc.CODEC.PCM) },
        { type: awc.CHUNK.peak, data: Buffer.alloc(4) },
        { type: awc.CHUNK.data, data: aData },
      ] },
      { id: 0x1def5678, chunkCount: 3, chunks: [
        { type: awc.CHUNK.format, data: fmtChunk(b.length, 24000, awc.CODEC.ADPCM) },
        { type: awc.CHUNK.peak, data: Buffer.alloc(4) },
        { type: awc.CHUNK.data, data: awc.encodeAdpcm(b) },
      ] },
    ],
  };
  return { buf: awc.writeAwc(bank), a, b };
}

test('awc parse + adpcm decode round trip', () => {
  const { buf, a, b } = buildBank();
  const bank = awc.parseAwc(buf);
  const d = awc.describeAwc(bank);
  assert.deepStrictEqual(d.map((s) => [s.hex, s.codec, s.rate, s.samples]), [['0ABC1234', 'PCM', 32000, 9000], ['1DEF5678', 'ADPCM', 24000, 12000]]);
  assert.deepStrictEqual(Array.from(awc.streamPcm(bank, 0x0abc1234).pcm), Array.from(a));
  const dec = awc.streamPcm(bank, 0x1def5678).pcm;
  let err = 0;
  for (let i = 0; i < b.length; i++) err += Math.abs(dec[i] - b[i]);
  assert.ok(err / b.length < 400, 'adpcm error ' + err / b.length);
  assert.throws(() => awc.parseAwc(Buffer.alloc(32, 7)), /encrypted/);
});

test('sound pack: replace stream, export, reload', () => {
  const { buf, a } = buildBank();
  const file = path.join(tmp, 'WEAPONS_PLAYER.rpf');
  fs.writeFileSync(file, rpf.writeRpf({ type: 'dir', name: '', children: [
    { type: 'dir', name: 'weapons', children: [
      { type: 'bin', name: 'spl_pistol_player.awc', stored: zlib.deflateRawSync(buf), compressed: true, size: buf.length },
      { type: 'bin', name: 'feet_concrete.awc', stored: buf, compressed: false, size: buf.length },
    ] },
  ] }));

  const sp = new SoundPack();
  const d = sp.open(file);
  assert.strictEqual(d.banks.length, 2);
  assert.deepStrictEqual(d.banks.map((b) => b.category).sort(), ['footsteps', 'guns']);
  const gun = d.banks.find((b) => b.category === 'guns');
  const boom = tone(5000, 880, 44100);
  sp.replace(gun.id, 0x1def5678, boom, 44100);
  assert.ok(sp.streams(gun.id).streams.find((s) => s.id === 0x1def5678).edited);
  const out = path.join(tmp, 'out.rpf');
  fs.writeFileSync(out, sp.build(0));

  const again = new SoundPack();
  const d2 = again.open(out);
  const g2 = d2.banks.find((b) => b.category === 'guns');
  const s2 = again.streams(g2.id).streams;
  const edited = s2.find((s) => s.id === 0x1def5678);
  assert.strictEqual(edited.codec, 'PCM');
  assert.strictEqual(edited.rate, 44100);
  assert.deepStrictEqual(Array.from(again.pcm(g2.id, 0x1def5678).pcm), Array.from(boom));
  assert.deepStrictEqual(Array.from(again.pcm(g2.id, 0x0abc1234).pcm), Array.from(a));
  // Untouched bank is unchanged.
  const f2 = d2.banks.find((b) => b.category === 'footsteps');
  assert.strictEqual(again.streams(f2.id).streams[1].codec, 'ADPCM');
});

test('mods enable/disable and cache clear', async () => {
  const app = path.join(tmp, 'FiveM.app');
  const mods = path.join(app, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'gun.rpf'), 'x');
  extras.addMods(mods, [path.join(tmp, 'gun.rpf')]);
  assert.deepStrictEqual(extras.listMods(mods).map((m) => [m.name, m.enabled]), [['gun.rpf', true]]);
  extras.setModEnabled(mods, 'gun.rpf', false);
  assert.deepStrictEqual(extras.listMods(mods).map((m) => [m.name, m.enabled]), [['gun.rpf', false]]);
  extras.setModEnabled(mods, 'gun.rpf', true);
  assert.ok(fs.existsSync(path.join(mods, 'gun.rpf')));

  fs.mkdirSync(path.join(app, 'data', 'server-cache'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data', 'server-cache', 'a.bin'), Buffer.alloc(1000));
  assert.strictEqual((await extras.cacheInfo(app)).find((c) => c.id === 'server').bytes, 1000);
  assert.strictEqual(await extras.clearCache(app, ['server']), 1000);
  assert.strictEqual((await extras.cacheInfo(app)).find((c) => c.id === 'server').bytes, 0);
});

test('presets restore tweak + colour state', () => {
  const cit = path.join(tmp, 'p', 'citizen');
  fs.mkdirSync(path.join(cit, 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(cit, 'common', 'data', 'timecycle', 'w_clear.xml'), '<timecycle_keyframe_data><sky_zenith_col_r>1</sky_zenith_col_r><sky_zenith_col_g>1</sky_zenith_col_g><sky_zenith_col_b>1</sky_zenith_col_b></timecycle_keyframe_data>');
  const m = new CitizenManager(path.join(tmp, 'p-user'));
  m.setCitizen(cit);
  m.setTweak('water', true);
  m.applyColour({ r: 255, g: 0, b: 0, strength: 1, brightness: 0, groups: ['sky'] });
  const p = m.savePreset('Red no water');
  m.restoreAll();
  assert.ok(!fs.existsSync(path.join(cit, 'common', 'data', 'levels', 'gta5', 'water.xml')));
  m.applyPreset(p.id);
  assert.ok(fs.existsSync(path.join(cit, 'common', 'data', 'levels', 'gta5', 'water.xml')));
  assert.ok(fs.readFileSync(path.join(cit, 'common', 'data', 'timecycle', 'w_clear.xml'), 'utf8').includes('<sky_zenith_col_g>0</sky_zenith_col_g>'));
});
