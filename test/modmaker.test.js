'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rpf = require('../src/core/rpf');
const { buildMod, modRpf, modContext, userMessage, MOD_SCHEMA } = require('../src/core/modmaker');
const { buildTimecycle } = require('./tc-fixture');

const VS = '# misc\ncar.lod.distance.high\t40.00\ncar.lod.distance.low\t180.00\ndistantlights.size\t0.8\n';
const WX = '<CWeatherTypes><Item><Name>EXTRASUNNY</Name><Rain value="0.000000"/><Lightning value="0.100000"/></Item><Item><Name>THUNDER</Name><Rain value="0.800000"/><Lightning value="1.000000"/></Item></CWeatherTypes>';
const GAME = {
  'common/data/visualsettings.dat': VS,
  'common/data/levels/gta5/weather.xml': WX,
  'common/data/timecycle/w_extrasunny.xml': buildTimecycle(['EXTRASUNNY']),
  'common/data/timecycle/w_thunder.xml': buildTimecycle(['THUNDER']),
};
const read = (rel) => (rel in GAME ? GAME[rel] : null);

test('mod maker: the AI\'s plan becomes real files built from the game\'s own, made-up keys are skipped', () => {
  const plan = {
    reply: 'ok', name: 'FPS Boost!!',
    visualsettings: [{ key: 'car.lod.distance.high', value: 25 }, { key: 'made.up.key', value: 1 }],
    weather: [{ weather: 'ALL', field: 'Lightning', value: 0 }, { weather: 'THUNDER', field: 'Rain', value: 0 }],
    timecycle: [{ param: 'sky_stars_iten', op: 'multiply', value: 2, weathers: 'ALL' }, { param: 'no_such_param', op: 'set', value: 1, weathers: 'ALL' }],
    stillClouds: null, snow: null,
    unsupported: ['Making everyone wear black needs their texture files.'],
  };
  const m = buildMod(plan, read);
  assert.strictEqual(m.name, 'FPS Boost');
  assert.ok(m.files['common/data/visualsettings.dat'].includes('car.lod.distance.high\t25\n'));
  assert.ok(m.files['common/data/visualsettings.dat'].includes('car.lod.distance.low\t180.00'), 'other lines kept');
  const wx = m.files['common/data/levels/gta5/weather.xml'];
  assert.strictEqual((wx.match(/<Lightning value="0.000000"\/>/g) || []).length, 2);
  assert.ok(wx.includes('<Name>EXTRASUNNY</Name><Rain value="0.000000"/>') && /THUNDER<\/Name><Rain value="0.000000"/.test(wx));
  const before = /<sky_stars_iten>([^<]*)</.exec(GAME['common/data/timecycle/w_extrasunny.xml'])[1].trim().split(/\s+/).map(Number);
  const after = /<sky_stars_iten>([^<]*)</.exec(m.files['common/data/timecycle/w_extrasunny.xml'])[1].trim().split(/\s+/).map(Number);
  assert.deepStrictEqual(after, before.map((v) => Number((v * 2).toFixed(4))));
  assert.ok(m.files['common/data/timecycle/w_thunder.xml'], 'every weather that exists');
  assert.ok(m.skipped.some((x) => /made\.up\.key/.test(x)) && m.skipped.some((x) => /no_such_param/.test(x)) && m.skipped.some((x) => /black/.test(x)));
  assert.ok(m.done.length >= 4);
  // the .rpf has the files at their game paths
  const tree = rpf.readRpf(modRpf(m.files), 'mod.rpf');
  const paths = [];
  rpf.walk(tree, (e, p) => { if (e.type === 'bin') paths.push(p); });
  assert.deepStrictEqual(paths.sort(), [...Object.keys(m.files), 'assembly.xml'].sort());
  let asm = null;
  rpf.walk(tree, (e) => { if (e.name === 'assembly.xml') asm = rpf.getBinaryData(e).toString('utf8'); });
  assert.ok(asm.includes('<archive path="update\\update.rpf"') && asm.includes('<add source="common\\data\\visualsettings.dat">common\\data\\visualsettings.dat</add>'), 'assembly.xml maps each file into update.rpf');
  let vs = null;
  rpf.walk(tree, (e) => { if (e.name === 'visualsettings.dat') vs = rpf.getBinaryData(e).toString('utf8'); });
  assert.strictEqual(vs, m.files['common/data/visualsettings.dat']);
});

test('mod maker: the AI gets the game\'s real settings to choose from', () => {
  const ctx = modContext(read);
  assert.ok(ctx.visualsettings.includes('car.lod.distance.high 40'));
  assert.ok(ctx.timecycleParams.includes('sky_stars_iten') && ctx.timecycleParams.includes('sky_zenith_col_r'));
  const msg = userMessage('fps please', ctx, null);
  assert.ok(msg.includes('Player: fps please') && msg.includes('distantlights.size'));
  assert.deepStrictEqual(MOD_SCHEMA.required.sort(), Object.keys(MOD_SCHEMA.properties).sort(), 'every field required (strict JSON output)');
});
