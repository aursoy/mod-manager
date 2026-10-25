'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTimecycle, buildYtd } = require('./tc-fixture');

const tcP = import('../renderer/js/timecycle.js');
const aiP = import('../renderer/js/gfxai.js');

test('timecycle: parse finds colours, scalars and cycles; untouched files serialize byte-identical', async () => {
  const tc = await tcP;
  const xml = buildTimecycle(['EXTRASUNNY', 'RAIN']);
  const model = tc.parse(xml);
  assert.deepStrictEqual(model.sections.map((s) => s.label), ['EXTRASUNNY / GLOBAL', 'EXTRASUNNY / URBAN', 'RAIN / GLOBAL', 'RAIN / URBAN']);
  const sec = model.sections[0];
  assert.strictEqual(sec.colours.length, 11);
  const zen = sec.colours.find((c) => c.name === 'sky_zenith_col');
  assert.strictEqual(zen.r.values.length, 9);
  assert.strictEqual(zen.role, 'zenith');
  assert.ok(sec.scalars.find((p) => p.name === 'lod_mult'));
  assert.strictEqual(tc.serialize(model), xml);
  const attr = tc.parse('<a><cycle name="X"><b value="2.5"/></cycle></a>');
  assert.strictEqual(attr.params[0].form, 'attr');
  assert.deepStrictEqual(attr.params[0].values, [2.5]);
  attr.params[0].values[0] = 4;
  assert.strictEqual(tc.serialize(attr), '<a><cycle name="X"><b value="4"/></cycle></a>');
  assert.strictEqual(tc.isDirty(model), false);
});

test('timecycle: edits touch only the edited values and survive a re-parse', async () => {
  const tc = await tcP;
  const xml = buildTimecycle(['EXTRASUNNY', 'RAIN']);
  const model = tc.parse(xml);
  const col = model.sections[1].colours.find((c) => c.name === 'sky_zenith_col');
  tc.setColour(col, 4, [1, 0, 0.5]);
  model.sections[0].scalars.find((p) => p.name === 'sky_sun_disc_size').values[3] = 4;
  const out = tc.serialize(model);
  assert.notStrictEqual(out, xml);
  const again = tc.parse(out);
  const c2 = again.sections[1].colours.find((c) => c.name === 'sky_zenith_col');
  assert.deepStrictEqual([c2.r.values[4], c2.g.values[4], c2.b.values[4]], [1, 0, 0.5]);
  assert.strictEqual(again.sections[0].scalars.find((p) => p.name === 'sky_sun_disc_size').values[3], 4);
  assert.strictEqual(again.sections[0].scalars.find((p) => p.name === 'sky_sun_disc_size').values[2], 2.5);
  // the same colour in the other region and the other weather is untouched
  for (const i of [0, 2, 3]) assert.deepStrictEqual(tc.colourAt(again.sections[i].colours.find((c) => c.name === 'sky_zenith_col'), 4), tc.colourAt(tc.parse(xml).sections[i].colours.find((c) => c.name === 'sky_zenith_col'), 4));
  // everything else identical
  assert.strictEqual(again.sections[0].colours[0].r.values.join(), model.sections[0].colours[0].r.values.join());
  assert.ok(out.includes('<!-- fixture -->'));
  assert.ok(out.includes('<sky_sun_disc_size>2.5 2.5 2.5 4 2.5'));
  tc.revert(model);
  assert.strictEqual(tc.serialize(model), xml);
});

test('timecycle: sampling wraps around midnight and keyframes map to hours', async () => {
  const tc = await tcP;
  assert.strictEqual(tc.keyHours(9).length, 9);
  assert.strictEqual(tc.keyHours(24)[13], 13);
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  assert.strictEqual(tc.sample(v, 12), 4);
  const mid = tc.sample(v, 23);
  assert.ok(mid > 0 && mid < 8, 'between 21:00 (8) and midnight (0): ' + mid);
  assert.strictEqual(tc.sample([3], 7), 3);
  assert.strictEqual(tc.nearestKey(9, 11.5), 4);
  assert.ok(tc.daylight(12) > 0.95 && tc.daylight(0) < 0.05);
});

test('timecycle: grouping puts ambient light with ambient and sun with sun', async () => {
  const tc = await tcP;
  assert.strictEqual(tc.groupOf('light_natural_amb_down_col'), 'ambient');
  assert.strictEqual(tc.groupOf('light_dir_col'), 'light');
  assert.strictEqual(tc.groupOf('sky_sun_col'), 'sun');
  assert.strictEqual(tc.groupOf('sky_cloud_base_col'), 'cloud');
  assert.strictEqual(tc.groupOf('sky_zenith_col'), 'sky');
  assert.strictEqual(tc.groupOf('ssao_inten'), 'perf');
  assert.strictEqual(tc.groupOf('postfx_exposure'), 'post');
});

test('timecycle: gradeColours tints and desaturates', async () => {
  const tc = await tcP;
  const model = tc.parse(buildTimecycle());
  const sec = model.sections[0];
  const before = tc.colourAt(sec.colours.find((c) => c.name === 'sky_zenith_col'), 4);
  const n = tc.gradeColours(model, { r: 255, g: 0, b: 0, strength: 1, groups: ['sky'] });
  assert.ok(n >= 2);
  const after = tc.colourAt(sec.colours.find((c) => c.name === 'sky_zenith_col'), 4);
  assert.ok(after[0] > before[0] && after[1] < before[1]);
  const gray = tc.parse(buildTimecycle());
  tc.gradeColours(gray, { saturation: 0, groups: ['sky'] });
  const z = tc.colourAt(gray.sections[0].colours.find((c) => c.name === 'sky_zenith_col'), 4);
  assert.ok(Math.abs(z[0] - z[1]) < 1e-3 && Math.abs(z[1] - z[2]) < 1e-3);
});

test('ai: prompt reader handles the pack options in the request', async () => {
  const ai = await aiP;
  let p = ai.parsePrompt('no water, no black mountains, add snow');
  assert.deepStrictEqual(p.world, { water: 'remove', mountains: 'remove', snow: 'keep' });
  assert.strictEqual(p.sky, undefined, 'black mountains must not read as a black sky');
  p = ai.parsePrompt('Remove black mountains and water, keep snow');
  assert.deepStrictEqual(p.world, { mountains: 'remove', water: 'remove', snow: 'keep' });
  p = ai.parsePrompt('no water, have water');
  assert.strictEqual(p.world.water, 'keep');
  assert.strictEqual(ai.parsePrompt('a winter pack').world.snow, 'keep', 'winter brings snow');
  p = ai.parsePrompt('I want an FPS pack for more FPS and boost');
  assert.strictEqual(p.fps, 2);
  assert.strictEqual(ai.parsePrompt('maximum fps').fps, 3);
  p = ai.parsePrompt('a neon cyberpunk look, called Night City');
  assert.strictEqual(p.mood, 'neon');
  assert.strictEqual(p.name, 'Night City');
  assert.strictEqual(p.constant, true);
  p = ai.parsePrompt('purple sky');
  assert.ok(p.sky && p.sky.zenith);
  p = ai.parsePrompt('make it a bit darker');
  assert.ok(p.grade.brightness < 0 && p.grade.brightness > -0.2);
  assert.ok(ai.isEmptySpec(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('hello there'))));
});

test('ai: follow-ups layer on the previous spec', async () => {
  const ai = await aiP;
  let spec = ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('sunset sky, no water'));
  spec = ai.mergeSpec(spec, ai.parsePrompt('now make it darker and add fps boost'));
  assert.strictEqual(spec.mood, 'sunset');
  assert.strictEqual(spec.world.water, 'remove');
  assert.strictEqual(spec.fps, 2);
  assert.ok(spec.grade.brightness < 0 && spec.grade.tint, 'keeps the sunset tint and adds the darkening');
});

test('ai: palette comes from the image: top is zenith, bottom is horizon', async () => {
  const ai = await aiP;
  const w = 40, h = 40;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const t = y / (h - 1);
    data[i] = 20 + 230 * t; data[i + 1] = 40 + 100 * t; data[i + 2] = 160 - 100 * t; data[i + 3] = 255;
  }
  const pal = ai.extractPalette({ data, width: w, height: h });
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  assert.ok(hex(pal.zenith)[2] > hex(pal.zenith)[0], 'top is blue');
  assert.ok(hex(pal.horizon)[0] > hex(pal.horizon)[2], 'bottom is orange');
});

test('ai: buildPack recolours the sky by role, follows the day, and leaves night dark', async () => {
  const ai = await aiP;
  const tc = await tcP;
  const xml = buildTimecycle(['EXTRASUNNY']);
  const spec = ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('red sky'));
  const res = ai.buildPack(spec, { 'common/data/timecycle/w_extrasunny.xml': xml });
  assert.strictEqual(res.changed, 1);
  const m = tc.parse(res.files['common/data/timecycle/w_extrasunny.xml']);
  const zen = m.sections[0].colours.find((c) => c.name === 'sky_zenith_col');
  const noon = tc.colourAt(zen, 4);
  const night = tc.colourAt(zen, 0);
  assert.ok(noon[0] > noon[2] * 2, 'noon zenith is red-dominant');
  assert.ok(tc.lum(night) < tc.lum(noon) * 0.3, 'night is much darker than noon');
  // colours not tied to the sky are left alone
  const amb = m.sections[0].colours.find((c) => c.name === 'light_natural_amb_down_col');
  assert.ok(amb.r.values.every((v, i) => v === tc.parse(xml).sections[0].colours.find((c) => c.name === 'light_natural_amb_down_col').r.values[i]) || spec.grade);
});

test('ai: constant looks stay bright at night, FPS lowers only matching values', async () => {
  const ai = await aiP;
  const tc = await tcP;
  const xml = buildTimecycle();
  const day = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('sunset sky')), { a: xml });
  const m = tc.parse(day.files.a);
  const hor = m.sections[0].colours.find((c) => c.name === 'sky_azimuth_transition_col');
  assert.ok(tc.lum(tc.colourAt(hor, 0)) > 0.25, 'sunset look is kept at midnight: ' + tc.lum(tc.colourAt(hor, 0)));

  const fps = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('max fps')), { a: xml });
  const f = tc.parse(fps.files.a).sections[0];
  assert.ok(f.scalars.find((p) => p.name === 'ssao_inten').values.every((v) => v === 0));
  assert.ok(f.scalars.find((p) => p.name === 'shadow_distance_mult').values[0] < 0.5);
  assert.strictEqual(f.scalars.find((p) => p.name === 'postfx_exposure').values[0], 1, 'unrelated values untouched');
  assert.ok(fps.report[0].ok);

  const none = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('fps boost')), { a: '<timecycle_keyframe_data><x>1</x></timecycle_keyframe_data>' });
  assert.strictEqual(none.changed, 0);
  assert.strictEqual(none.report[0].ok, false, 'says plainly that nothing was found');
});

test('ai: world switches are returned for the tweak layer', async () => {
  const ai = await aiP;
  const res = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('no water, no black mountains, add snow')), {});
  assert.deepStrictEqual(res.tweaks, { water: true, mountains: true, snow: true }, 'water/mountains: removed, snow: on');
});

// ---------- main-process side ----------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CitizenManager } = require('../src/core/citizen');
const { YtdFile } = require('../src/core/skytex');
const { describePack, editableTimecycles, mergeForPack, createPackWithTweaks } = require('../src/core/gfxpack');

function makeCitizen() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-gfx-'));
  const cit = path.join(root, 'FiveM.app', 'citizen');
  const tc = path.join(cit, 'common', 'data', 'timecycle');
  fs.mkdirSync(tc, { recursive: true });
  const xml = buildTimecycle(['EXTRASUNNY']);
  fs.writeFileSync(path.join(tc, 'w_extrasunny.xml'), xml);
  const m = new CitizenManager(path.join(root, 'userdata'));
  m.setCitizen(path.join(root, 'FiveM.app'));
  return { m, cit, xml, rel: 'common/data/timecycle/w_extrasunny.xml' };
}

test('timecycle editor saves are journaled and Backups restores stock', () => {
  const { m, cit, xml, rel } = makeCitizen();
  const edited = xml.replace('<lod_mult>1.0', '<lod_mult>0.5');
  m.writeTimecycle(rel, edited);
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), edited);
  assert.strictEqual(m.readTimecycle(rel), edited);
  assert.strictEqual(m.readTimecycle(rel, { stock: true }), xml, 'stock read returns the pre-edit file');
  m.writeTimecycle(rel, edited.replace('0.5', '0.4'));
  assert.strictEqual(m.readTimecycle(rel, { stock: true }), xml, 'second save keeps the first backup');
  m.restoreAll();
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), xml);
});

test('timecycle editor refuses paths outside citizen and non-xml files', () => {
  const { m } = makeCitizen();
  assert.throws(() => m.readTimecycle('../../secret.xml'), /Not a timecycle/);
  assert.throws(() => m.readTimecycle('common/data/timecycle/../../../../x.xml'), /Not a timecycle/);
  assert.throws(() => m.readTimecycle('common/data/gta5.exe'), /Not a timecycle/);
  assert.throws(() => m.writeTimecycle('common/data/timecycle/a.xml', 'plain text'), /does not look like/);
});

test('createPack makes a switchable pack and rejects unsafe paths', () => {
  const { m, cit, xml, rel } = makeCitizen();
  assert.throws(() => m.createPack('bad', { '../evil.xml': '<a/>' }), /unsafe/);
  assert.throws(() => m.createPack('empty', {}), /at least one/);
  const edited = xml.replace('<lod_mult>1.0', '<lod_mult>0.3');
  const id = m.createPack('My pack', { [rel]: edited });
  let t = m.listTweaks().find((x) => x.id === id);
  assert.strictEqual(t.kind, 'pack');
  assert.strictEqual(t.enabled, false);
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), xml, 'creating a pack does not touch citizen');
  m.setTweak(id, true);
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), edited);
  m.setTweak(id, false);
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), xml);
});

test('ai: "add stars, bigger moon, no fog" become adjustments; negated words are not moods', async () => {
  const ai = await aiP;
  let p = ai.parsePrompt('add stars, bigger moon, no fog');
  assert.deepStrictEqual(p.adjust, { stars: 'more', moon: 'bigger', fog: 'none' });
  assert.strictEqual(p.mood, undefined, '"no fog" must not pick the foggy mood');
  p = ai.parsePrompt('no clouds and less glow');
  assert.deepStrictEqual(p.adjust, { clouds: 'none', bloom: 'less' });
  p = ai.parsePrompt('foggy morning');
  assert.strictEqual(p.mood, 'foggy');
});

test('ai: image use is read from the prompt', async () => {
  const ai = await aiP;
  assert.strictEqual(ai.parsePrompt('use this image as the actual sky').imageUse, 'texture');
  assert.strictEqual(ai.parsePrompt('put my picture in the sky').imageUse, 'texture');
  assert.strictEqual(ai.parsePrompt('only the colours from the image').imageUse, 'colours');
  assert.strictEqual(ai.parsePrompt('picture as the sky, all day').imageAllDay, true);
});

test('ai: adjustments scale only matching values and never fog_start', async () => {
  const ai = await aiP;
  const tc = await tcP;
  const xml = buildTimecycle();
  const res = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('more stars, bigger sun, no fog')), { a: xml });
  const sec = tc.parse(res.files.a).sections[0];
  const orig = tc.parse(xml).sections[0];
  const val = (s, n) => s.scalars.find((p) => p.name === n).values;
  assert.ok(val(sec, 'sky_stars_iten')[0] > val(orig, 'sky_stars_iten')[0]);
  assert.ok(val(sec, 'sky_sun_disc_size')[0] > 2.5);
  assert.deepStrictEqual(val(sec, 'fog_start'), val(orig, 'fog_start'), 'fog_start is a distance, not an amount');
  assert.deepStrictEqual(val(sec, 'sky_moon_iten'), val(orig, 'sky_moon_iten'));
  assert.ok(val(sec, 'fog_density').every((v) => v === 0), 'no fog = fog thickness 0');
  const moon = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('smaller glow')), { a: '<a><cycle name="X"><region name="GLOBAL"><x>1 1</x></region></cycle></a>' });
  assert.strictEqual(moon.report[0].ok, false, 'reports plainly when nothing matched');
});

test('ai: sky picture keeps star intensity on at night, all-day mode darkens the day sky', async () => {
  const ai = await aiP;
  const tc = await tcP;
  const xml = buildTimecycle();
  const night = ai.buildPack({ ...ai.emptySpec(), skyImage: { allDay: false } }, { a: xml });
  const s1 = tc.parse(night.files.a).sections[0];
  const stars = s1.scalars.find((p) => p.name === 'sky_stars_iten').values;
  assert.strictEqual(stars[0], 1); assert.strictEqual(stars[4], 0, 'noon stays without the picture');
  const day = ai.buildPack({ ...ai.emptySpec(), skyImage: { allDay: true } }, { a: xml });
  const s2 = tc.parse(day.files.a).sections[0];
  assert.ok(s2.scalars.find((p) => p.name === 'sky_stars_iten').values.every((v) => v >= 1));
  const z1 = tc.colourAt(tc.parse(xml).sections[0].colours.find((c) => c.role === 'zenith'), 4);
  const z2 = tc.colourAt(s2.colours.find((c) => c.role === 'zenith'), 4);
  assert.ok(tc.lum(z2) < tc.lum(z1) * 0.3);
  assert.ok(day.report.some((r) => /all the time/.test(r.text)));
});

test('sky texture: finds the starfield, replaces it in place, and the result reopens', () => {
  const ytd = new YtdFile(buildYtd(['moon', 'starfield']), 'skydome.ytd');
  assert.strictEqual(ytd.textures.length, 2);
  const i = ytd.skyIndex();
  assert.strictEqual(ytd.textures[i].name, 'starfield');
  const size = ytd.textures[i].dataSize;
  assert.throws(() => ytd.replace(i, new Uint8Array(3)), /size mismatch/);
  const out = ytd.replace(i, new Uint8Array(size).fill(0x5a));
  const again = new YtdFile(out).describe(true);
  assert.ok(again.find((t) => t.name === 'starfield').data.every((b) => b === 0x5a));
  assert.ok(again.find((t) => t.name === 'moon').data.every((b) => b === 0x11), 'other textures untouched');
});

test('dropped pack: timecycles and skydome are found, new pack keeps every original file', () => {
  const { m, cit } = makeCitizen();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-drop-'));
  const pack = path.join(src, 'CoolPack', 'citizen');
  fs.mkdirSync(path.join(pack, 'common', 'data', 'timecycle'), { recursive: true });
  fs.mkdirSync(path.join(pack, 'platform', 'textures'), { recursive: true });
  const w = buildTimecycle(['EXTRASUNNY']);
  fs.writeFileSync(path.join(pack, 'common', 'data', 'timecycle', 'w_extrasunny.xml'), w);
  fs.writeFileSync(path.join(pack, 'common', 'data', 'timecycle', 'timecycle_mods_1.xml'), '<timecycle_modifier_data><modifier name="x"><a_col_r>1</a_col_r></modifier></timecycle_modifier_data>');
  fs.writeFileSync(path.join(pack, 'common', 'data', 'visualsettings.dat'), 'x 1');
  fs.writeFileSync(path.join(pack, 'platform', 'textures', 'skydome.ytd'), buildYtd(['starfield']));
  fs.writeFileSync(path.join(src, 'CoolPack', 'readme.txt'), 'hi');

  const staged = m.stageSources([path.join(src, 'CoolPack')]);
  const info = describePack('CoolPack', staged);
  assert.strictEqual(info.count, 4, 'readme is ignored');
  assert.deepStrictEqual(info.weather, ['common/data/timecycle/w_extrasunny.xml']);
  assert.strictEqual(info.timecycles.length, 2);
  assert.strictEqual(info.skydome, 'platform/textures/skydome.ytd');
  const tcs = editableTimecycles(staged, info);
  assert.deepStrictEqual(Object.keys(tcs), ['common/data/timecycle/w_extrasunny.xml']);

  const edited = w.replace('<lod_mult>1.0', '<lod_mult>0.5');
  const files = mergeForPack(staged, { 'common/data/timecycle/w_extrasunny.xml': edited }, { 'platform/textures/skydome.ytd': Buffer.from('new sky') });
  const id = m.createPack('Cool AI', files);
  m.setTweak(id, true);
  assert.strictEqual(fs.readFileSync(path.join(cit, 'common/data/timecycle/w_extrasunny.xml'), 'utf8'), edited);
  assert.strictEqual(fs.readFileSync(path.join(cit, 'common/data/visualsettings.dat'), 'utf8'), 'x 1');
  assert.strictEqual(fs.readFileSync(path.join(cit, 'platform/textures/skydome.ytd'), 'utf8'), 'new sky');
  assert.ok(fs.existsSync(path.join(src, 'CoolPack', 'citizen', 'platform', 'textures', 'skydome.ytd')), 'the dropped pack is not modified');
  assert.strictEqual(m.findInCitizen('skydome.ytd'), 'platform/textures/skydome.ytd');
  m.setTweak(id, false);
  assert.ok(!fs.existsSync(path.join(cit, 'platform/textures/skydome.ytd')));
});

test('a loose skydome.ytd maps to the textures folder, not cdimages', () => {
  const { m } = makeCitizen();
  assert.strictEqual(m.mapLoose('skydome.ytd'), 'platform/textures/skydome.ytd');
});

test('installing an AI pack: files go live, water switches, missing world files are reported', () => {
  const { m, cit, xml, rel } = makeCitizen();
  const edited = xml.replace('<lod_mult>1.0', '<lod_mult>0.7');
  const out = createPackWithTweaks(m, 'AI Test', { [rel]: edited }, { water: true, nosuch: true }, { extra: { 'platform/textures/skydome.ytd': Buffer.from('sky') } });
  assert.ok(out.id);
  assert.deepStrictEqual(out.applied, ['water']);
  assert.strictEqual(out.skipped[0].id, 'nosuch');
  assert.match(out.skipped[0].reason, /Unknown tweak/);
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), edited);
  assert.strictEqual(fs.readFileSync(path.join(cit, 'platform/textures/skydome.ytd'), 'utf8'), 'sky');
  assert.ok(fs.readFileSync(path.join(cit, 'common/data/levels/gta5/water.xml'), 'utf8').includes('IsInvisible'));
  const onlyWorld = createPackWithTweaks(m, 'World only', {}, { water: false });
  assert.strictEqual(onlyWorld.id, null, 'no files means no empty pack');
  assert.deepStrictEqual(onlyWorld.applied, ['water']);
  m.restoreAll();
  assert.strictEqual(fs.readFileSync(path.join(cit, rel), 'utf8'), xml);
});

test('every renderer api.call has a handler in main.js', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const handlers = new Set([...main.matchAll(/handle\('([\w:]+)'/g)].map((x) => x[1]));
  const dir = path.join(root, 'renderer', 'js');
  const missing = [];
  for (const f of fs.readdirSync(dir)) {
    for (const x of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/api\.call\('([\w:]+)'/g)) {
      if (!x[1].endsWith(':') && !handlers.has(x[1])) missing.push(f + ': ' + x[1]);
    }
  }
  assert.deepStrictEqual(missing, []);
});

const { findGtaDirs } = require('../src/core/skytex');

test('GTA V is found through FiveM\'s CitizenFX.ini, so the sky file needs no popup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-gta-'));
  const gta = path.join(root, 'Games', 'GTAV');
  fs.mkdirSync(gta, { recursive: true });
  fs.writeFileSync(path.join(gta, 'x64a.rpf'), 'x');
  const cit = path.join(root, 'FiveM', 'FiveM.app', 'citizen');
  fs.mkdirSync(cit, { recursive: true });
  fs.writeFileSync(path.join(root, 'FiveM', 'FiveM.app', 'CitizenFX.ini'), '[Game]\r\nIVPath=' + gta + '\r\nUpdateChannel=production\r\n');
  assert.deepStrictEqual(findGtaDirs({ citizenPath: cit }), [path.resolve(gta)]);
  assert.deepStrictEqual(findGtaDirs({ citizenPath: cit, knownExe: path.join(gta, 'GTA5.exe') }), [path.resolve(gta)], 'no duplicates');
  assert.deepStrictEqual(findGtaDirs({ citizenPath: path.join(root, 'nope', 'citizen') }), []);
  assert.deepStrictEqual(findGtaDirs({ exes: [path.join(root, 'missing', 'GTA5.exe')] }), [], 'only folders that really have x64a.rpf');
});

test('editor shows plain names and splits weather from area', async () => {
  const tc = await tcP;
  assert.strictEqual(tc.labelOf('sky_zenith_col'), 'Sky colour (top)');
  assert.strictEqual(tc.labelOf('sky_zenith_col_inten'), 'Sky (top) brightness');
  assert.strictEqual(tc.labelOf('sky_stars_iten'), 'Stars brightness');
  assert.strictEqual(tc.labelOf('light_artificial_ext_down_intensity'), 'Light artificial ext down intensity');
  assert.deepStrictEqual(tc.splitSection('EXTRASUNNY / URBAN'), { weather: 'EXTRASUNNY', area: 'URBAN' });
  assert.deepStrictEqual(tc.splitSection('Global'), { weather: 'Global', area: null });
});

// ---------- sky inside RPFs (how graphics packs ship it for FiveM.app/mods) ----------
const rpf = require('../src/core/rpf');
const { RpfSky } = require('../src/core/skytex');
const { openSkySource, skySources } = require('../src/core/skysource');

function skyRpf({ nested = false, w = 64, h = 64 } = {}) {
  const stored = buildYtd(['moon', 'starfield'], w, h);
  const res = { type: 'res', name: 'skydome.ytd', stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) };
  const other = { type: 'bin', name: 'readme.txt', stored: Buffer.from('keep me'), compressed: false, size: 7 };
  let tree = { type: 'dir', name: '', children: [{ type: 'dir', name: 'textures', children: [res] }, other] };
  if (nested) {
    const inner = rpf.writeRpf(tree);
    tree = { type: 'dir', name: '', children: [{ type: 'bin', name: 'x64a.rpf', stored: inner, compressed: false, size: inner.length }] };
  }
  return rpf.writeRpf(tree);
}

test('sky RPF: finds skydome.ytd (also inside an inner RPF), swaps the picture, keeps everything else', () => {
  for (const nested of [false, true]) {
    const sky = new RpfSky(skyRpf({ nested }), 'sky.rpf');
    assert.strictEqual(sky.path, nested ? 'x64a.rpf/textures/skydome.ytd' : 'textures/skydome.ytd');
    const i = sky.skyIndex();
    assert.strictEqual(sky.textures[i].name, 'starfield');
    const out = sky.replace(i, new Uint8Array(sky.textures[i].dataSize).fill(0x42));
    const again = new RpfSky(out, 'sky.rpf');
    const tex = again.describe(true);
    assert.ok(tex.find((t) => t.name === 'starfield').data.every((b) => b === 0x42));
    assert.ok(tex.find((t) => t.name === 'moon').data.every((b) => b === 0x11), 'moon untouched');
    let root = rpf.readRpf(out);
    if (nested) root = rpf.readRpf(rpf.getBinaryData(root.children[0]));
    assert.strictEqual(rpf.getBinaryData(root.children.find((c) => c.name === 'readme.txt')).toString(), 'keep me');
  }
  assert.throws(() => new RpfSky(rpf.writeRpf({ type: 'dir', name: '', children: [] }), 'empty.rpf'), /no skydome/);
});

test('sky RPF from a dropped pack goes to FiveM.app/mods, and switching the pack off removes it', async () => {
  const { m, cit } = makeCitizen();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-rpfpack-'));
  const packDir = path.join(src, 'Cool Sky');
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.mkdirSync(path.join(packDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), buildTimecycle());
  fs.writeFileSync(path.join(packDir, 'mods', 'coolsky.rpf'), skyRpf({ nested: true }));
  fs.writeFileSync(path.join(packDir, 'mods', 'other.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [] }));

  const staged = m.stageSources([packDir]);
  assert.ok(staged.some((s) => s.rel === '@mods/coolsky.rpf'), 'rpfs are staged for the mods folder');
  const pack = { staged, info: describePack('Cool Sky', staged) };
  assert.strictEqual(pack.info.rpfs, 2);
  const ctx = { pack, mgr: m, gtaDirs: () => [], unlock: null };
  assert.deepStrictEqual(skySources(ctx), ['pack-rpf']);
  const got = await openSkySource('pack-rpf', ctx);
  assert.strictEqual(got.rel, '@mods/coolsky.rpf', 'the sky-looking archive is found');
  const i = got.obj.skyIndex();
  const out = got.obj.replace(i, new Uint8Array(got.obj.textures[i].dataSize).fill(0x77));

  const res = createPackWithTweaks(m, 'AI Sky', {}, {}, { staged, extra: { [got.rel]: out } });
  const modsFile = path.join(path.dirname(cit), 'mods', 'coolsky.rpf');
  assert.ok(new RpfSky(fs.readFileSync(modsFile)).describe(true).find((t) => t.name === 'starfield').data.every((b) => b === 0x77));
  assert.ok(fs.existsSync(path.join(path.dirname(cit), 'mods', 'other.rpf')), 'the other rpf is installed too');
  assert.ok(!fs.existsSync(path.join(cit, 'common', 'data', 'coolsky.rpf')), 'rpfs never land in citizen');
  m.setTweak(res.id, false);
  assert.ok(!fs.existsSync(modsFile), 'switching the pack off takes it back out');
});

test('a sky RPF already in the mods folder is edited, and the original comes back when the pack is off', async () => {
  const { m, cit } = makeCitizen();
  const mods = path.join(path.dirname(cit), 'mods');
  fs.mkdirSync(mods, { recursive: true });
  const original = skyRpf();
  fs.writeFileSync(path.join(mods, 'weather_sky.rpf'), original);
  fs.writeFileSync(path.join(mods, 'cars.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [] }));
  const ctx = { pack: null, mgr: m, gtaDirs: () => [], unlock: null };
  assert.deepStrictEqual(skySources(ctx), ['mods']);
  const got = await openSkySource('mods', ctx);
  assert.strictEqual(got.rel, '@mods/weather_sky.rpf');
  const i = got.obj.skyIndex();
  const out = got.obj.replace(i, new Uint8Array(got.obj.textures[i].dataSize).fill(0x33));
  const res = createPackWithTweaks(m, 'My sky', {}, {}, { extra: { [got.rel]: out } });
  assert.notDeepStrictEqual(fs.readFileSync(path.join(mods, 'weather_sky.rpf')), original);
  m.setTweak(res.id, false);
  assert.deepStrictEqual(fs.readFileSync(path.join(mods, 'weather_sky.rpf')), original, 'the player\'s own sky rpf is put back exactly');
});

test('real-shaped sky RPF (content/x.rpf/x64/y.rpf/skydome.ytd, 1024² DXT1): the picture really ends up in the file', async () => {
  const dxt = await import('../renderer/js/dxt.js');
  const stored = buildYtd(['baseperlinnoise3channel', 'dither', 'moon-new', 'noise16_p', 'starfield'], 1024, 1024);
  const ytdRes = { type: 'res', name: 'skydome.ytd', stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) };
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'x64', children: [{ type: 'bin', name: 'opallinio_bbv.rpf', stored: rpf.writeRpf({ type: 'dir', name: '', children: [ytdRes] }), compressed: false, size: 0 }] }] });
  // fix size of the nested bin entry
  const innerRoot = rpf.readRpf(inner);
  const deep = innerRoot.children[0].children[0];
  rpf.setBinaryData(deep, rpf.getBinaryData(deep), false);
  const middle = rpf.writeRpf(innerRoot);
  const outer = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'content', children: [{ type: 'bin', name: 'opallinio_bbv.rpf', stored: middle, compressed: false, size: middle.length }] }] });

  const sky = new RpfSky(outer, 'clouds.rpf');
  assert.strictEqual(sky.path, 'content/opallinio_bbv.rpf/x64/opallinio_bbv.rpf/skydome.ytd');
  const i = sky.skyIndex();
  const t = sky.textures[i];
  assert.deepStrictEqual([t.name, t.width, t.height, t.format], ['starfield', 1024, 1024, 'DXT1']);

  // a picture: purple top fading to orange bottom, with a white square in the middle
  const w = 1024, h = 1024;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4; const f = y / h;
    const sq = x > 400 && x < 624 && y > 400 && y < 624;
    px[k] = sq ? 255 : 120 + 120 * f; px[k + 1] = sq ? 255 : 30 + 90 * f; px[k + 2] = sq ? 255 : 200 - 160 * f; px[k + 3] = 255;
  }
  const out = sky.replace(i, dxt.encode('DXT1', px, w, h));

  const back = new RpfSky(out, 'clouds.rpf').describe(true);
  const star = back.find((x) => x.name === 'starfield');
  const dec = dxt.decode('DXT1', star.data, w, h);
  let err = 0;
  for (let k = 0; k < px.length; k += 4) err += Math.abs(dec[k] - px[k]) + Math.abs(dec[k + 1] - px[k + 1]) + Math.abs(dec[k + 2] - px[k + 2]);
  assert.ok(err / (w * h * 3) < 8, 'decoded starfield matches the picture (mean error ' + (err / (w * h * 3)).toFixed(2) + ')');
  assert.ok(dec[(512 * w + 512) * 4] > 240, 'the white square is there');
  assert.ok(back.find((x) => x.name === 'moon-new').data.every((b) => b === 0x33), 'other textures untouched');
  assert.strictEqual(sky.ytdBytes().length > 0, true, 'the edited skydome.ytd is also available on its own');
});

test('ai: PvP, always night, no sun', async () => {
  const ai = await aiP;
  const tc = await tcP;
  let p = ai.parsePrompt('make me a pvp pack');
  assert.strictEqual(p.mood, 'pvp');
  assert.strictEqual(p.fps, 2);
  assert.deepStrictEqual(p.adjust, { fog: 'none', bloom: 'none', blur: 'none' });
  const pv = ai.buildPack(ai.mergeSpec(ai.emptySpec(), p), { a: buildTimecycle() });
  const ps = tc.parse(pv.files.a).sections[0];
  const v = (n) => ps.scalars.find((x) => x.name === n).values;
  assert.ok(v('fog_density').every((x) => x === 0) && v('postfx_intensity_bloom').every((x) => x === 0) && v('dof_blur_far').every((x) => x === 0), 'pvp: no fog, no glow, no blur');
  assert.ok(v('dof_far').every((x) => x === 800), 'distances are left alone');
  assert.ok(p.grade.saturation > 1);
  assert.strictEqual(ai.parsePrompt('always night, purple sky').timeLock, 'night');
  assert.strictEqual(ai.parsePrompt('no daytime please').timeLock, 'night');
  assert.strictEqual(ai.parsePrompt('only day').timeLock, 'day');
  assert.strictEqual(ai.parsePrompt('my picture as the sky').imageAllDay, true);
  assert.strictEqual(ai.parsePrompt('my picture as the sky only at night').imageAllDay, false);

  const xml = buildTimecycle();
  const res = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('always night, no sun')), { a: xml });
  const sec = tc.parse(res.files.a).sections[0];
  for (const p2 of sec.params) assert.ok(p2.values.every((v) => v === p2.values[0]), p2.name + ' is the same at every hour');
  const zen = sec.colours.find((c) => c.name === 'sky_zenith_col');
  const orig = tc.parse(xml).sections[0].colours.find((c) => c.name === 'sky_zenith_col');
  assert.ok(tc.lum(tc.colourAt(zen, 4)) < tc.lum(tc.colourAt(orig, 4)) * 0.3, 'noon is now night-dark');
  assert.ok(sec.scalars.find((p2) => p2.name === 'sky_sun_disc_size').values.every((v) => v === 0), 'no sun = no sun disc');
  assert.ok(res.report.some((r) => /Always night/.test(r.text)));
});

test('custom background: picture or video is copied in, settings are clamped, reset removes it', () => {
  const { Appearance } = require('../src/core/appearance');
  const { m } = makeCitizen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-look-'));
  const look = new Appearance(m, path.join(dir, 'data'));
  const pic = path.join(dir, 'wall.png');
  fs.writeFileSync(pic, Buffer.from('png-bytes'));
  assert.throws(() => look.setFile(path.join(dir, 'x.exe')), /picture/);
  look.setFile(pic);
  fs.rmSync(pic);
  const l = look.load();
  assert.strictEqual(l.kind, 'image');
  assert.strictEqual(Buffer.from(l.data).toString(), 'png-bytes', 'still there after the original is deleted');
  assert.deepStrictEqual([look.set({ dim: 5, blur: -3 }).dim, look.get().blur], [0.95, 0]);
  const vid = path.join(dir, 'loop.mp4');
  fs.writeFileSync(vid, 'mp4');
  assert.strictEqual(look.setFile(vid).kind, 'video');
  assert.strictEqual(look.clear().kind, null);
  assert.strictEqual(look.load().data, null);
});

// ---------- clouds (cloudhat_*.ytd) and RPFs with any name ----------
const { listCloudSources, openCloudSource, cloudName } = require('../src/core/clouds');
const { findInFile } = require('../src/core/rpfscan');

const resOf = (name, stored) => ({ type: 'res', name, stored, sysFlags: stored.readUInt32LE(8), gfxFlags: stored.readUInt32LE(12) });
const binOf = (name, buf) => ({ type: 'bin', name, stored: buf, compressed: false, size: buf.length });

test('clouds in a mods RPF with any name are found, edited and installed; Undo restores the original', async () => {
  const { m, cit } = makeCitizen();
  const mods = path.join(path.dirname(cit), 'mods');
  fs.mkdirSync(mods, { recursive: true });
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'x64', children: [
    resOf('cloudhat_wispy.ytd', buildYtd(['cloudhat_wispy_d', 'cloudhat_wispy_n'], 64, 64)),
    resOf('cloudhat_nimbus.ytd', buildYtd(['cloudhat_nimbus_d'], 64, 64)),
    resOf('skydome.ytd', buildYtd(['starfield'], 64, 64)),
  ] }] });
  const original = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'content', children: [binOf('zz_my_mate_pack.rpf', inner)] }] });
  fs.writeFileSync(path.join(mods, 'Totally Random Name 2.rpf'), original);
  fs.writeFileSync(path.join(mods, 'cars.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [] }));

  const ctx = { pack: null, mgr: m, gtaDirs: () => [], unlock: null };
  const sources = await listCloudSources(ctx);
  assert.deepStrictEqual(sources.map((x) => [x.id, x.count]), [['mods:Totally Random Name 2.rpf', 2]]);
  const src = await openCloudSource(sources[0].id, ctx);
  assert.deepStrictEqual(src.items.map((x) => x.name).sort(), ['Nimbus', 'Wispy']);
  const wispy = src.items.find((x) => x.name === 'Wispy');
  const t = wispy.ytd.textures[1];
  src.replace(wispy.key, 1, new Uint8Array(t.dataSize).fill(0x5c));
  const out = src.outputs();
  assert.deepStrictEqual(Object.keys(out), ['@mods/Totally Random Name 2.rpf']);

  const res = createPackWithTweaks(m, 'Custom clouds', {}, {}, { extra: out }, (rel) => fs.readFileSync(m.absFor(rel)));
  assert.deepStrictEqual(res.verified, ['@mods/Totally Random Name 2.rpf']);
  const again = await openCloudSource('mods:Totally Random Name 2.rpf', ctx);
  const w2 = again.items.find((x) => x.name === 'Wispy').ytd.describe(true);
  assert.ok(w2[1].data.every((b) => b === 0x5c), 'edited texture is in the installed file');
  assert.ok(w2[0].data.every((b) => b === 0x11), 'the other texture is untouched');
  m.setTweak(res.id, false);
  assert.deepStrictEqual(fs.readFileSync(path.join(mods, 'Totally Random Name 2.rpf')), original, 'switching off puts the original back exactly');
});

test('stock clouds from GTA V go into a new mods/kt_clouds.rpf, the game files are never touched', async () => {
  const { m, cit } = makeCitizen();
  const gta = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-gta-clouds-'));
  const vclouds = rpf.writeRpf({ type: 'dir', name: '', children: [resOf('cloudhat_cirro.ytd', buildYtd(['cirro'], 64, 64)), resOf('cloudhat_clear01.ytd', buildYtd(['clear'], 64, 64))] });
  const x64b = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'levels', children: [{ type: 'dir', name: 'gta5', children: [{ type: 'dir', name: 'cloudhats', children: [binOf('v_clouds.rpf', vclouds)] }] }] }] });
  fs.writeFileSync(path.join(gta, 'x64b.rpf'), x64b);
  fs.writeFileSync(path.join(gta, 'x64a.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [] }));
  const ctx = { pack: null, mgr: m, gtaDirs: () => [gta], unlock: null };
  const sources = await listCloudSources(ctx);
  assert.deepStrictEqual(sources.map((x) => x.id), ['game:x64b.rpf']);
  const src = await openCloudSource('game:x64b.rpf', ctx);
  assert.deepStrictEqual(src.items.map((x) => x.name), ['Cirrus', 'Clear']);
  assert.deepStrictEqual(src.outputs(), {}, 'nothing to install before an edit');
  src.replace(0, 0, new Uint8Array(src.items[0].ytd.textures[0].dataSize).fill(0x21));
  const out = src.outputs();
  const res = createPackWithTweaks(m, 'Custom clouds', {}, {}, { extra: out }, (rel) => fs.readFileSync(m.absFor(rel)));
  assert.deepStrictEqual(res.verified, ['@mods/kt_clouds.rpf']);
  const made = rpf.readRpf(fs.readFileSync(path.join(path.dirname(cit), 'mods', 'kt_clouds.rpf')));
  assert.deepStrictEqual(made.children.map((c) => c.name), ['cloudhat_cirro.ytd']);
  assert.deepStrictEqual(fs.readFileSync(path.join(gta, 'x64b.rpf')), x64b, 'GTA V files untouched');
});

test('sky is found in a pack RPF whatever it is called, and RPFs without a sky are never loaded', async () => {
  const { m, cit } = makeCitizen();
  const mods = path.join(path.dirname(cit), 'mods');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(mods, 'aaa_nothing_here.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [binOf('big.bin', Buffer.alloc(200000))] }));
  fs.writeFileSync(path.join(mods, 'x_pvp_v4_final.rpf'), skyRpf({ nested: true }));
  const got = await openSkySource('mods', { pack: null, mgr: m, gtaDirs: () => [], unlock: null });
  assert.strictEqual(got.rel, '@mods/x_pvp_v4_final.rpf');
  assert.deepStrictEqual(findInFile(path.join(mods, 'x_pvp_v4_final.rpf'), (n) => n === 'skydome.ytd').map((x) => x.path), ['x64a.rpf/textures/skydome.ytd']);
  assert.strictEqual(cloudName('cloudhat_stormy.ytd'), 'Stormy');
});

// ---------- black mountains / snow / visual settings (data files edited in place) ----------
const { WorldFiles, VS, WEATHER, PED_LOD } = require('../src/core/worldfiles');

const VS_TEXT = '# Misc Values\nmisc.Multiplier.heightStart\t100\nmisc.Multiplier.farClipMultiplier\t1\n\n# black mountains fix\nlod.fadedist.slod3\t\t25.0\r\n\n# vehicles\ncar.lod.distance.high\t90.00\n';
const WEATHER_XML = '<CWeatherTypes><WeatherTypes><Item><Name>EXTRASUNNY</Name><Snow value="0.000000"/><SnowMist value="0.000000"/><DropSettingName /><MistSettingName>MIST_NONE</MistSettingName><GroundSettingName>DRY</GroundSettingName><TimeCycleFilename>EXTRASUNNY</TimeCycleFilename></Item><Item><Name>XMAS</Name><Snow value="1.000000"/><SnowMist value="1.000000"/><DropSettingName>SNOW_XMAS</DropSettingName><MistSettingName>MIST_SNOW</MistSettingName><GroundSettingName>SNOW_GROUND</GroundSettingName><TimeCycleFilename>XMAS</TimeCycleFilename></Item></WeatherTypes></CWeatherTypes>';

test('black mountains: lowers the draw distance on top of a pack\'s visualsettings.dat, and off puts the pack\'s file back exactly', () => {
  const { m, cit } = makeCitizen();
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-vs-'));
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'visualsettings.dat'), VS_TEXT);
  const pack = m.addCustom('Pack', [packDir], 'pack');
  m.setTweak(pack, true);
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf-' + Date.now()));
  let st = wf.mountains();
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.removed, false);
  assert.deepStrictEqual(st.packKeys.map((k) => k.key), ['lod.fadedist.slod3'], 'the pack\'s own "black mountains" lines are found');
  st = wf.setMountains({ removed: true });
  assert.strictEqual(st.removed, true);
  assert.strictEqual(st.value, 0.5);
  const now = fs.readFileSync(path.join(cit, VS), 'utf8');
  assert.ok(now.startsWith(VS_TEXT.replace('heightStart\t100', 'heightStart\t-1000').replace('farClipMultiplier\t1', 'farClipMultiplier\t0.5').replace(/\n$/, '')), 'far clip halved and used at every height');
  assert.ok(/misc\.Multiplier\.heightEnd\t-999/.test(now), 'the missing heightEnd line is added');
  wf.setMountains({ removed: true, keys: { 'lod.fadedist.slod3': 0 } });
  assert.ok(fs.readFileSync(path.join(cit, VS), 'utf8').includes('slod3\t\t0\r\n'));
  wf.setMountains({ removed: false });
  assert.strictEqual(fs.readFileSync(path.join(cit, VS), 'utf8'), VS_TEXT, 'the pack\'s file is back');
  assert.strictEqual(m.state.owners[VS], pack);
});

test('snow: switches on snow for every weather from GTA V\'s own weather.xml, off removes the file again', () => {
  const { m, cit } = makeCitizen();
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf2-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && inner.endsWith('weather.xml') ? Buffer.from(WEATHER_XML) : null));
  assert.deepStrictEqual(wf.snow(), { available: true, modsWeather: [], amount: 1, on: false, weathers: 2 });
  const st = wf.setSnow(0.8);
  assert.strictEqual(st.on, true);
  const x = fs.readFileSync(path.join(cit, WEATHER), 'utf8');
  assert.strictEqual((x.match(/<Snow value="0.800000"\/>/g) || []).length, 2);
  assert.strictEqual((x.match(/<SnowMist value="0.480000"\/>/g) || []).length, 2);
  assert.strictEqual((x.match(/<DropSettingName>SNOW_XMAS<\/DropSettingName>/g) || []).length, 2, 'snowfall particles in every weather');
  assert.strictEqual((x.match(/<MistSettingName>MIST_SNOW</g) || []).length, 2);
  assert.strictEqual((x.match(/<GroundSettingName>SNOW_GROUND</g) || []).length, 2);
  assert.ok(x.includes('<TimeCycleFilename>EXTRASUNNY</TimeCycleFilename>'), 'each weather keeps its own look');
  wf.setSnow(0);
  assert.ok(!fs.existsSync(path.join(cit, WEATHER)), 'the game\'s own file is used again');
});

test('visual settings editor: any line can be changed and reset', () => {
  const { m, cit } = makeCitizen();
  fs.mkdirSync(path.join(cit, 'common', 'data'), { recursive: true });
  fs.writeFileSync(path.join(cit, VS), VS_TEXT);
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf3-' + Date.now()));
  const vs = wf.visualSettings();
  assert.strictEqual(vs.entries.length, 4);
  assert.strictEqual(vs.entries.find((e) => e.key === 'car.lod.distance.high').section, 'vehicles');
  wf.saveVisualSettings({ 'car.lod.distance.high': 200 });
  assert.ok(fs.readFileSync(path.join(cit, VS), 'utf8').includes('car.lod.distance.high\t200\n'));
  assert.strictEqual(wf.visualSettings().edited, true);
  wf.resetVisualSettings();
  assert.strictEqual(fs.readFileSync(path.join(cit, VS), 'utf8'), VS_TEXT);
});

test('player detail fix: raises the ped LOD distances, works together with black mountains, and off puts each one back', () => {
  const { m, cit } = makeCitizen();
  const FPS_VS = VS_TEXT + '\n# peds\nped.lod.distance.high\t5.00\nped.lod.distance.medium\t10.00\nped.lod.distance.low\t15.00\npedincar.lod.distance.high\t2.00\n';
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf4-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && inner.endsWith('visualsettings.dat') ? Buffer.from(FPS_VS) : null));
  assert.deepStrictEqual(wf.pedLod(), { available: true, on: false, before: 5, now: 5, fixed: PED_LOD['ped.lod.distance.high'] });
  wf.setMountains({ removed: true });
  let st = wf.setPedLod(true);
  assert.strictEqual(st.on, true);
  assert.strictEqual(st.now, PED_LOD['ped.lod.distance.high']);
  let text = fs.readFileSync(path.join(cit, VS), 'utf8');
  assert.ok(text.includes('ped.lod.distance.low\t400\n') && text.includes('farClipMultiplier\t0.5'), 'both options are in the file');
  assert.ok(/# Kt Mod Manager\n[^#]*pedincar\.lod\.distance\.high\.x64\t80/.test(text), 'a line the file did not have is added');
  wf.setMountains({ removed: false });
  text = fs.readFileSync(path.join(cit, VS), 'utf8');
  assert.ok(text.includes('farClipMultiplier\t1\n') && text.includes('ped.lod.distance.high\t150'), 'mountains back, player fix kept');
  assert.strictEqual(wf.setPedLod(false).now, 5);
  assert.ok(!fs.existsSync(path.join(cit, VS)), 'nothing left on: the game\'s own file is used again');
});

// ---------- blood FX ----------
const tex = require('../src/core/texsource');

test('blood FX: found in GTA V, edited, and installed both as mods/kt_bloodfx.rpf and in citizen/platform/textures', async () => {
  const { m, cit } = makeCitizen();
  const gta = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-gta-blood-'));
  fs.writeFileSync(path.join(gta, 'x64a.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'textures', children: [
    resOf('fxdecal.ytd', buildYtd(['blood_splat_1', 'bullet_hole'], 64, 64)), resOf('peddamagedecals.ytd', buildYtd(['blood_drip'], 64, 64)), resOf('skydome.ytd', buildYtd(['starfield'], 64, 64)),
  ] }] }));
  const ctx = { pack: null, mgr: m, gtaDirs: () => [gta], unlock: null };
  const sources = await tex.listSources('blood', ctx);
  assert.deepStrictEqual(sources.map((s) => [s.id, s.count]), [['game:x64a.rpf', 2]]);
  const src = await tex.openSource('blood', 'game:x64a.rpf', ctx);
  assert.deepStrictEqual(src.items.map((x) => x.name), ['Blood splats & decals', 'Blood on players']);
  src.replace(0, 0, new Uint8Array(src.items[0].ytd.textures[0].dataSize).fill(0x66));
  const out = src.outputs();
  assert.deepStrictEqual(Object.keys(out).sort(), ['@mods/kt_bloodfx.rpf', 'platform/textures/fxdecal.ytd']);
  const res = createPackWithTweaks(m, 'Blood FX', {}, {}, { extra: out }, (rel) => fs.readFileSync(m.absFor(rel)));
  assert.strictEqual(res.verified.length, 2);
  assert.ok(new YtdFile(fs.readFileSync(path.join(cit, 'platform/textures/fxdecal.ytd'))).describe(true)[0].data.every((b) => b === 0x66));
});

test('blood FX: the RPF the player picks is edited in place and goes into mods under its own name', async () => {
  const { m, cit } = makeCitizen();
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-dl-blood-'));
  const file = path.join(dl, 'MyBlood_v2.rpf');
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [resOf('custom_splats.ytd', buildYtd(['splat'], 64, 64))] });
  fs.writeFileSync(file, rpf.writeRpf({ type: 'dir', name: '', children: [binOf('x64.rpf', inner), resOf('readme_tex.ytd', buildYtd(['logo'], 64, 64))] }));
  const ctx = { pack: null, mgr: m, gtaDirs: () => [], unlock: null };
  const src = await tex.openFiles('blood', [file], ctx);
  assert.deepStrictEqual(src.items.map((x) => x.path).sort(), ['readme_tex.ytd', 'x64.rpf/custom_splats.ytd'], 'no known blood names: every texture in the chosen RPF is shown');
  assert.deepStrictEqual(src.outputs(), {}, 'nothing changed yet');
  const it = src.items.find((x) => x.file === 'custom_splats.ytd');
  src.replace(it.key, 0, new Uint8Array(it.ytd.textures[0].dataSize).fill(0x22));
  const out = src.outputs();
  assert.deepStrictEqual(Object.keys(out), ['@mods/MyBlood_v2.rpf']);
  assert.strictEqual(src.files()[0].name, 'MyBlood_v2.rpf');
  createPackWithTweaks(m, 'Custom blood FX', {}, {}, { extra: out }, (rel) => fs.readFileSync(m.absFor(rel)));
  const again = await tex.openFiles('blood', [path.join(path.dirname(cit), 'mods', 'MyBlood_v2.rpf')], ctx);
  const at = (s2) => s2.items.find((x) => x.file === 'custom_splats.ytd').ytd.describe(true)[0].data;
  assert.ok(at(again).every((b) => b === 0x22), 'the edit is in the installed RPF');
  assert.ok(!at(await tex.openFiles('blood', [file], ctx)).every((b) => b === 0x22), 'the picked file itself is untouched');
});

test('blood FX: an RPF whose blood is in core.ypt (particle textures) opens with every texture, blood first, and installs', async () => {
  const { m, cit } = makeCitizen();
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-dl-sev-'));
  const file = path.join(dl, 'Severance.rpf');
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'x64', children: [{ type: 'dir', name: 'data', children: [{ type: 'dir', name: 'effects', children: [{ type: 'dir', name: 'ptfx', children: [
    resOf('core.ypt', buildYtd(['fire_flame', 'blood_spray_01', 'smoke_puff', 'blood_mist'], 64, 64, { ypt: true })),
  ] }] }] }] }] });
  fs.writeFileSync(file, rpf.writeRpf({ type: 'dir', name: '', children: [binOf('update.rpf', inner)] }));
  const ctx = { pack: null, mgr: m, gtaDirs: () => [], unlock: null };
  const src = await tex.openFiles('blood', [file], ctx);
  assert.strictEqual(src.items.length, 1);
  assert.strictEqual(src.items[0].name, 'Blood sprays (particles)');
  assert.deepStrictEqual(src.items[0].order.map((i) => src.items[0].ytd.textures[i].name), ['blood_spray_01', 'blood_mist', 'fire_flame', 'smoke_puff']);
  src.replace(0, 1, new Uint8Array(src.items[0].ytd.textures[1].dataSize).fill(0x55));
  const out = src.outputs();
  assert.deepStrictEqual(Object.keys(out), ['@mods/Severance.rpf']);
  createPackWithTweaks(m, 'Custom blood FX', {}, {}, { extra: out }, (rel) => fs.readFileSync(m.absFor(rel)));
  const again = await tex.openFiles('blood', [path.join(path.dirname(cit), 'mods', 'Severance.rpf')], ctx);
  const d = again.items[0].ytd.describe(true);
  assert.ok(d[1].data.every((b) => b === 0x55), 'the blood spray edit is in the installed RPF');
  assert.ok(!d[0].data.every((b) => b === 0x55), 'other particle textures untouched');
});

test('blood FX: an RPF with no textures says what is inside it', async () => {
  const { m } = makeCitizen();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kt-dl-none-')), 'empty.rpf');
  fs.writeFileSync(file, rpf.writeRpf({ type: 'dir', name: '', children: [binOf('readme.txt', Buffer.from('hi'))] }));
  await assert.rejects(tex.openFiles('blood', [file], { pack: null, mgr: m, gtaDirs: () => [], unlock: null }), /Inside: readme\.txt/);
});

// ---------- advanced editor: any pack, installed or not ----------
const { EditorPack } = require('../src/core/editorpack');

test('editor packs: timecycles open from a folder, a .zip and a nested .rpf, and saves go back into that pack', () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-edpack-'));
  const xml = buildTimecycle(['EXTRASUNNY']);
  // folder
  const dir = path.join(dl, 'Night Pack');
  fs.mkdirSync(path.join(dir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), xml);
  fs.writeFileSync(path.join(dir, 'readme.xml'), '<readme>hi</readme>');
  let p = EditorPack.open(dir);
  assert.deepStrictEqual(p.list().map((f) => f.name), ['w_extrasunny.xml'], 'only timecycles');
  p.save(p.list()[0].rel, xml.replace('EXTRASUNNY', 'EXTRASUNNY ').trimEnd() + '\n');
  assert.ok(fs.existsSync(path.join(dir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml.bak')));
  assert.ok(EditorPack.open(dir).read(p.list()[0].rel).includes('EXTRASUNNY '));
  // zip
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addFile('pack/timecycle/w_rain.xml', Buffer.from(buildTimecycle(['RAIN'])));
  const zf = path.join(dl, 'rain.zip');
  z.writeZip(zf);
  p = EditorPack.open(zf);
  assert.deepStrictEqual(p.list().map((f) => f.rel), ['pack/timecycle/w_rain.xml']);
  p.save('pack/timecycle/w_rain.xml', '<x><cycle name="RAIN_EDIT"/></x>');
  assert.ok(EditorPack.open(zf).read('pack/timecycle/w_rain.xml').includes('RAIN_EDIT'));
  // rpf with the timecycle inside a nested update.rpf
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'common', children: [{ type: 'dir', name: 'data', children: [{ type: 'dir', name: 'timecycle', children: [binOf('w_clear.xml', Buffer.from(buildTimecycle(['CLEAR'])))] }] }] }] });
  const rf = path.join(dl, 'gfx.rpf');
  fs.writeFileSync(rf, rpf.writeRpf({ type: 'dir', name: '', children: [binOf('update.rpf', inner)] }));
  p = EditorPack.open(rf);
  assert.deepStrictEqual(p.list().map((f) => f.rel), ['update.rpf/common/data/timecycle/w_clear.xml']);
  p.save('update.rpf/common/data/timecycle/w_clear.xml', '<x><cycle name="CLEAR_EDIT"/></x>');
  assert.ok(EditorPack.open(rf).read('update.rpf/common/data/timecycle/w_clear.xml').includes('CLEAR_EDIT'));
  assert.ok(fs.existsSync(rf + '.bak'));
});

test('editor packs: the pack\'s own sky picture is found (loose, in a .zip, in a nested .rpf), and mods-folder packs are listed', () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-edsky-'));
  const sky = buildYtd(['starfield'], 64, 32);
  const tc = Buffer.from(buildTimecycle(['EXTRASUNNY']));
  // folder with a loose skydome.ytd
  const dir = path.join(dl, 'Pic Pack');
  fs.mkdirSync(path.join(dir, 'citizen', 'platform', 'textures'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'citizen', 'platform', 'textures', 'skydome.ytd'), sky);
  fs.writeFileSync(path.join(dir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), tc);
  let got = EditorPack.open(dir).sky();
  assert.ok(got && /skydome\.ytd$/.test(got.label));
  const t = got.obj.describe(true)[got.obj.skyIndex()];
  assert.strictEqual(t.name, 'starfield'); assert.strictEqual(t.width, 64); assert.ok(t.data.length >= 64 * 32 / 2);
  // zip
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addFile('p/timecycle/w_rain.xml', tc); z.addFile('p/skydome.ytd', sky);
  z.writeZip(path.join(dl, 'p.zip'));
  assert.strictEqual(EditorPack.open(path.join(dl, 'p.zip')).sky().obj.describe()[0].name, 'starfield');
  // an rpf in FiveM.app/mods with the sky and timecycle inside a nested archive
  const mods = path.join(dl, 'mods');
  fs.mkdirSync(mods);
  const inner = rpf.writeRpf({ type: 'dir', name: '', children: [binOf('w_extrasunny.xml', tc), resOf('skydome.ytd', sky)] });
  fs.writeFileSync(path.join(mods, 'gfx.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [binOf('dlc.rpf', inner)] }));
  fs.writeFileSync(path.join(mods, 'cars.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [binOf('readme.txt', Buffer.from('x'))] }));
  const { modsPacks } = require('../src/core/editorpack');
  const { findInFile } = require('../src/core/rpfscan');
  assert.deepStrictEqual(modsPacks(mods, findInFile).map((x) => x.name), ['gfx.rpf'], 'only RPFs with timecycles');
  const rp = EditorPack.open(path.join(mods, 'gfx.rpf'));
  assert.deepStrictEqual(rp.list().map((f) => f.name), ['w_extrasunny.xml']);
  assert.ok(/dlc\.rpf\/skydome\.ytd/.test(rp.sky().label));
  // no sky: null, not an error
  const bare = path.join(dl, 'bare');
  fs.mkdirSync(bare); fs.writeFileSync(path.join(bare, 'w_clear.xml'), buildTimecycle(['CLEAR']));
  assert.strictEqual(EditorPack.open(bare).sky(), null);
});

test('editor packs: editing an installed pack that is on updates the game too', () => {
  const { m, cit } = makeCitizen();
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-edinst-'));
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), buildTimecycle(['EXTRASUNNY']));
  const id = m.addCustom('Pack', [packDir], 'pack');
  m.setTweak(id, true);
  const p = EditorPack.installed(m, id);
  p.save('common/data/timecycle/w_extrasunny.xml', '<x><cycle name="EDITED"/></x>');
  assert.ok(fs.readFileSync(path.join(cit, 'common', 'data', 'timecycle', 'w_extrasunny.xml'), 'utf8').includes('EDITED'));
  assert.ok(fs.readFileSync(path.join(m.libraryDir(id), 'common', 'data', 'timecycle', 'w_extrasunny.xml'), 'utf8').includes('EDITED'));
});

test('still clouds: every cloud hat stops turning and scrolling, and off puts clouds.xml back', () => {
  const { m, cit } = makeCitizen();
  const XML = `<CloudHatSettings>
  <mCloudHatFrags>
    <Item>
      <mName>Cloudy 01</mName>
      <mAngularVelocity x="0.000000" y="0.000000" z="0.000150" />
      <mUVVelocity>
        0.003000\t-0.001200
        0.010000\t0.000000
      </mUVVelocity>
      <mEnableAnimations value="true" />
    </Item>
  </mCloudHatFrags>
  <mDesiredTransitionTimeSec value="20.000000" />
  <mAltitudeScrollScaler value="0.120000" />
</CloudHatSettings>`;
  const { CLOUDS } = require('../src/core/worldfiles');
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf5-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && inner === 'common/data/clouds.xml' ? Buffer.from(XML) : null));
  assert.deepStrictEqual(wf.stillClouds(), { available: true, on: false, hats: 1 });
  assert.strictEqual(wf.setStillClouds(true).on, true);
  const t = fs.readFileSync(path.join(cit, CLOUDS), 'utf8');
  assert.ok(t.includes('<mAngularVelocity x="0.000000" y="0.000000" z="0.000000" />'));
  assert.ok(!/0\.003000|0\.010000|-0\.001200/.test(t), 'scroll speeds zeroed');
  assert.ok(t.includes('<mEnableAnimations value="false" />') && t.includes('<mAltitudeScrollScaler value="0.000000" />'));
  assert.ok(t.includes('<mDesiredTransitionTimeSec value="20.000000" />'), 'other values untouched');
  wf.setStillClouds(false);
  assert.ok(!fs.existsSync(path.join(cit, CLOUDS)));
});

test('lightning off and snow share weather.xml: each switches off on its own', () => {
  const { m, cit } = makeCitizen();
  const XML = WEATHER_XML.replace(/<\/Name>/g, '</Name><Lightning value="0.400000"/>');
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf6-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && inner.endsWith('weather.xml') ? Buffer.from(XML) : null));
  assert.deepStrictEqual(wf.lightning(), { available: true, off: false });
  wf.setLightning(true);
  wf.setSnow(0.5);
  let x = fs.readFileSync(path.join(cit, WEATHER), 'utf8');
  assert.strictEqual((x.match(/<Lightning value="0.000000"\/>/g) || []).length, 2);
  assert.strictEqual((x.match(/<Snow value="0.500000"\/>/g) || []).length, 2);
  wf.setLightning(false);
  x = fs.readFileSync(path.join(cit, WEATHER), 'utf8');
  assert.ok(x.includes('<Lightning value="0.400000"/>') && x.includes('<Snow value="0.500000"/>'), 'lightning back, snow kept');
  wf.setSnow(0);
  assert.ok(!fs.existsSync(path.join(cit, WEATHER)));
});

test('snow gets through a graphics pack whose weather.xml blanks or removes the snow settings', () => {
  const { m, cit } = makeCitizen();
  // the pack: no Snow lines at all, snow effects blanked, no XMAS weather
  const PACK = '<CWeatherTypes><WeatherTypes><Item><Name>EXTRASUNNY</Name><DropSettingName /><MistSettingName>MIST_NONE</MistSettingName><GroundSettingName>DRY</GroundSettingName></Item></WeatherTypes></CWeatherTypes>';
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-snowpack-'));
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data', 'levels', 'gta5'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'levels', 'gta5', 'weather.xml'), PACK);
  const pack = m.addCustom('NoSnow', [packDir], 'pack');
  m.setTweak(pack, true);
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf7-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && inner.endsWith('weather.xml') ? Buffer.from(WEATHER_XML) : null));
  wf.setSnow(1);
  const x = fs.readFileSync(path.join(cit, WEATHER), 'utf8');
  assert.ok(x.includes('<Snow value="1.000000"/>') && x.includes('<SnowMist value="0.600000"/>'), 'missing lines added');
  assert.ok(x.includes('<DropSettingName>SNOW_XMAS</DropSettingName>') && x.includes('<MistSettingName>MIST_SNOW</MistSettingName>') && x.includes('<GroundSettingName>SNOW_GROUND</GroundSettingName>'), 'effects from the game\'s own file');
  wf.setSnow(0);
  assert.strictEqual(fs.readFileSync(path.join(cit, WEATHER), 'utf8'), PACK, 'the pack\'s file is back');
});

test('stars: off on every timecycle (a pack\'s too), on gives stars at night, pack puts it back', () => {
  const { m, cit } = makeCitizen();
  const TC = (stars) => `<timecycle_keyframe_data><cycle name="X"><region name="GLOBAL"><sky_zenith_col_r>0.2 0.2 0.2 0.2 0.2 0.2 0.2 0.2 0.2</sky_zenith_col_r><sky_stars_iten>${stars}</sky_stars_iten></region></cycle></timecycle_keyframe_data>`;
  const packTc = TC('0 0 0 0 0 0 0 0 0'); // a pack with no stars
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-starpack-'));
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle', 'w_clear.xml'), packTc);
  const pack = m.addCustom('NoStars', [packDir], 'pack');
  m.setTweak(pack, true);
  const game = TC('2 0.5 0 0 0 0 0.5 1 2');
  const wf = new WorldFiles(m, path.join(os.tmpdir(), 'kt-wf8-' + Date.now()), (arc, inner) => (arc === 'update/update.rpf' && /timecycle\/w_(clear|rain)\.xml$/.test(inner) ? Buffer.from(game) : null));
  assert.deepStrictEqual(wf.stars(), { available: true, mode: 'pack', pictureSky: false });
  wf.setStars('on');
  const clear = () => /<sky_stars_iten>([^<]*)</.exec(fs.readFileSync(path.join(cit, 'common/data/timecycle/w_clear.xml'), 'utf8'))[1];
  assert.strictEqual(clear(), '1 0 0 0 0 0 0 0 1', 'night boxes (00:00, 21:00) get stars; the game file already had them so it is left alone');
  assert.ok(!fs.existsSync(path.join(cit, 'common/data/timecycle/w_rain.xml')));
  wf.setStars('off');
  assert.ok(/^(0\.0000 ?)+$/.test(clear()));
  assert.ok(fs.readFileSync(path.join(cit, 'common/data/timecycle/w_rain.xml'), 'utf8').includes('<sky_stars_iten>0.0000 0.0000'), 'the game\'s own weathers too');
  wf.setStars('pack');
  assert.strictEqual(fs.readFileSync(path.join(cit, 'common/data/timecycle/w_clear.xml'), 'utf8'), packTc);
  assert.ok(!fs.existsSync(path.join(cit, 'common/data/timecycle/w_rain.xml')));
});
