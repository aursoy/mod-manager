'use strict';
// Dev probe: open an encrypted audio RPF with the Sound Lab engine.
// Usage: node scripts/sound-probe.js <GTA5.exe> <archive.rpf> [outRpf]
const fs = require('fs');
const rpf = require('../src/core/rpf');
const { GtaKeys, findAesKey } = require('../src/core/ngcrypto');
const { SoundPack } = require('../src/core/soundpack');

(async () => {
  const [exe, file, out] = process.argv.slice(2);
  rpf.setKeys(new GtaKeys(await findAesKey(exe)));
  let t = Date.now();
  const sp = new SoundPack();
  const d = sp.open(file);
  console.log('opened in', Date.now() - t, 'ms;', d.banks.length, 'banks');
  const cats = {};
  for (const b of d.banks) cats[b.category] = (cats[b.category] || 0) + 1;
  console.log('categories', cats);
  let ok = 0, fail = 0, streams = 0, played = 0;
  const errors = {};
  t = Date.now();
  for (const b of d.banks) {
    try {
      const s = sp.streams(b.id);
      ok++;
      streams += s.streams.length;
      const first = s.streams.find((x) => x.playable);
      if (first) {
        const p = sp.pcm(b.id, first.id);
        let peak = 0;
        for (let i = 0; i < p.pcm.length; i++) peak = Math.max(peak, Math.abs(p.pcm[i]));
        if (peak > 50) played++;
      }
    } catch (e) {
      fail++;
      errors[e.message] = (errors[e.message] || 0) + 1;
    }
  }
  console.log('parsed', ok, 'banks,', fail, 'failed,', streams, 'sounds,', played, 'decoded with real audio, in', Date.now() - t, 'ms');
  console.log('errors', errors);
  const feet = d.banks.find((b) => /feet_materials/.test(b.name));
  if (feet) {
    const s = sp.streams(feet.id).streams;
    console.log('feet_materials:', s.length, 'sounds, e.g.', s.slice(0, 3).map((x) => x.hex + ' ' + x.codec + ' ' + x.rate + 'Hz ' + x.seconds.toFixed(2) + 's'));
    if (out) {
      const tone = new Int16Array(8000).map((_, i) => Math.round(Math.sin(i / 10) * 8000));
      sp.replace(feet.id, s[0].id, tone, 32000);
      t = Date.now();
      fs.writeFileSync(out, sp.build(d.archives[0].id));
      console.log('wrote', out, 'in', Date.now() - t, 'ms');
      const again = new SoundPack();
      const d2 = again.open(out);
      const f2 = d2.banks.find((b) => /feet_materials/.test(b.name));
      const s2 = again.streams(f2.id).streams;
      const back = again.pcm(f2.id, s[0].id).pcm;
      console.log('reopened OPEN copy:', d2.banks.length, 'banks; edited sound', s2[0].codec, s2[0].rate, 'Hz, samples match:', back.length === tone.length && back.every((v, i) => v === tone[i]));
      const other = again.pcm(f2.id, s[1].id).pcm;
      const orig = sp.pcm(feet.id, s[1].id, true).pcm;
      console.log('untouched sound identical:', other.length === orig.length && other.every((v, i) => v === orig[i]));
    }
  }
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
