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
  let p = ai.parsePrompt('no water, no black mountains, no props, have trees, no bushes');
  assert.deepStrictEqual(p.world, { water: 'remove', mountains: 'remove', props: 'remove', trees: 'keep', bushes: 'remove' });
  assert.strictEqual(p.sky, undefined, 'black mountains must not read as a black sky');
  p = ai.parsePrompt('Remove trees and bushes, keep water');
  assert.deepStrictEqual(p.world, { trees: 'remove', bushes: 'remove', water: 'keep' });
  p = ai.parsePrompt('no props, have props');
  assert.strictEqual(p.world.props, 'keep');
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
  const res = ai.buildPack(ai.mergeSpec(ai.emptySpec(), ai.parsePrompt('no water, have trees')), {});
  assert.deepStrictEqual(res.tweaks, { water: true, trees: false });
});

test('ai: validateSpec drops anything the model got wrong', async () => {
  const ai = await aiP;
  const s = ai.validateSpec({ name: 'x'.repeat(100), sky: { zenith: '#fff', horizon: '#000000', sun: '#000000', cloud: '#000000', fog: '#000000' }, grade: { tint: 'red', strength: 7, saturation: -4 }, world: { water: 'remove', trees: 'maybe', evil: 'remove' }, fps: 99 });
  assert.strictEqual(s.name.length, 40);
  assert.strictEqual(s.sky, null);
  assert.strictEqual(s.grade.strength, 1);
  assert.strictEqual(s.grade.saturation, 0);
  assert.strictEqual(s.grade.tint, undefined);
  assert.deepStrictEqual(s.world, { water: 'remove' });
  assert.strictEqual(s.fps, 3);
  assert.deepStrictEqual(ai.extractJson('Sure!\n```json\n{"fps": 2}\n```'), { fps: 2 });
  assert.throws(() => ai.extractJson('no json here'));
});

// ---------- main-process side ----------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CitizenManager } = require('../src/core/citizen');
const { AiKey, askClaude } = require('../src/core/ai');

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

test('trees, bushes and props are world switches that need their files first', () => {
  const { m } = makeCitizen();
  const ids = m.listTweaks().map((t) => t.id);
  for (const id of ['water', 'mountains', 'trees', 'bushes', 'props']) assert.ok(ids.includes(id), id);
  assert.throws(() => m.setTweak('trees', true), /Load the files/);
  m.setTweak('water', true);
  assert.ok(m.listTweaks().find((t) => t.id === 'water').enabled);
});

test('ai: key is stored privately and validated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-key-'));
  const k = new AiKey(path.join(dir, 'ai.json'));
  assert.strictEqual(k.get(), null);
  assert.throws(() => k.set('hunter2'), /sk-ant-/);
  assert.strictEqual(k.set('sk-ant-api03-abcdefghijkl'), true);
  assert.strictEqual(k.get(), 'sk-ant-api03-abcdefghijkl');
  assert.strictEqual(k.set(''), false);
  assert.strictEqual(k.get(), null);
});

test('ai: Claude request is shaped correctly and errors are readable', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"fps":2}' }] }) }; };
  const text = await askClaude({ key: 'sk-ant-x', system: 'sys', prompt: 'hello', image: { mediaType: 'image/jpeg', data: 'AAAA' }, fetchImpl: ok });
  assert.strictEqual(text, '{"fps":2}');
  assert.strictEqual(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(seen.init.headers['x-api-key'], 'sk-ant-x');
  assert.strictEqual(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(seen.body.messages[0].content[0].type, 'image');
  assert.strictEqual(seen.body.messages[0].content[1].text, 'hello');
  const denied = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(askClaude({ key: 'sk-ant-x', system: '', prompt: 'p', fetchImpl: denied }), /key was rejected/);
  await assert.rejects(askClaude({ key: null, system: '', prompt: 'p', fetchImpl: ok }), /API key/);
  await assert.rejects(askClaude({ key: 'k', system: '', prompt: 'p', image: { mediaType: 'text/html', data: 'x' }, fetchImpl: ok }), /cannot be sent/);
  const down = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(askClaude({ key: 'k', system: '', prompt: 'p', fetchImpl: down }), /Could not reach/);
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
  const fog = res.report.find((r) => r.text.startsWith('Fog'));
  assert.strictEqual(fog.ok, false, 'reports plainly when nothing matched');
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
  assert.ok(day.report.some((r) => /all day/.test(r.text)));
});

test('ai: validateSpec keeps valid adjustments and the sky picture flag', async () => {
  const ai = await aiP;
  const s = ai.validateSpec({ adjust: { stars: 'more', moon: 'explode', hack: 'none' }, skyImage: { allDay: 'yes' } });
  assert.deepStrictEqual(s.adjust, { stars: 'more' });
  assert.deepStrictEqual(s.skyImage, { allDay: false });
});

const { YtdFile } = require('../src/core/skytex');
const { describePack, editableTimecycles, mergeForPack, createPackWithTweaks } = require('../src/core/gfxpack');

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
  const out = createPackWithTweaks(m, 'AI Test', { [rel]: edited }, { water: true, trees: true }, { extra: { 'platform/textures/skydome.ytd': Buffer.from('sky') } });
  assert.ok(out.id);
  assert.deepStrictEqual(out.applied, ['water']);
  assert.strictEqual(out.skipped[0].id, 'trees');
  assert.match(out.skipped[0].reason, /Load the files/);
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
