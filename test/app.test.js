'use strict';
// End to end: every main-process feature through the app's real IPC handlers (main.js
// with a stand-in for electron), on a fake FiveM.app and GTA V install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const rpf = require(ROOT + '/src/core/rpf');
const { buildTimecycle, buildYtd } = require(ROOT + '/test/tc-fixture');
const { buildYdr } = require(ROOT + '/test/ydr-fixture');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-full-'));
const app = path.join(tmp, 'FiveM.app'), cit = path.join(app, 'citizen'), mods = path.join(app, 'mods');
fs.mkdirSync(path.join(cit, 'common', 'data', 'timecycle'), { recursive: true });
fs.mkdirSync(mods, { recursive: true });
fs.writeFileSync(path.join(cit, 'common', 'data', 'timecycle', 'w_extrasunny.xml'), buildTimecycle(['EXTRASUNNY']));
// GTA V install found through CitizenFX.ini, with visualsettings.dat and weather.xml in update.rpf
const gta = path.join(tmp, 'GTAV');
fs.mkdirSync(path.join(gta, 'update'), { recursive: true });
fs.writeFileSync(path.join(gta, 'x64a.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [] }));
const VS = '# misc\nmisc.Multiplier.farClipMultiplier\t1\n\n# peds\nped.lod.distance.high\t25.00\nped.lod.distance.medium\t50.00\nped.lod.distance.low\t80.00\npedincar.lod.distance.high\t7.00\npedincar.lod.distance.high.x64\t15.00\n';
const WX = '<CWeatherTypes><Item><Name>EXTRASUNNY</Name><Snow value="0.000000"/><SnowMist value="0.000000"/></Item></CWeatherTypes>';
const bin = (name, s) => ({ type: 'bin', name, stored: Buffer.from(s), compressed: false, size: Buffer.byteLength(s) });
fs.writeFileSync(path.join(gta, 'update', 'update.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'dir', name: 'common', children: [{ type: 'dir', name: 'data', children: [bin('visualsettings.dat', VS), { type: 'dir', name: 'levels', children: [{ type: 'dir', name: 'gta5', children: [bin('weather.xml', WX)] }] }] }] }] }));
fs.writeFileSync(path.join(app, 'CitizenFX.ini'), '[Game]\nIVPath=' + gta + '\n');
// cache folders
for (const d of ['data/cache', 'data/server-cache']) { fs.mkdirSync(path.join(app, d), { recursive: true }); fs.writeFileSync(path.join(app, d, 'blob.bin'), Buffer.alloc(4096, 1)); }

const handlers = {};
const sent = [];
const trashed = [];
const m = require('module'); const orig = m._load;
m._load = function (r, ...a) {
  if (r === 'electron') return {
    app: { setName() {}, setPath() {}, getPath: () => path.join(tmp, 'ud'), whenReady: () => Promise.resolve(), on() {} },
    BrowserWindow: class { constructor() { this.webContents = { send: (...x) => sent.push(x), on() {}, once() {} }; } loadFile() {} once() {} on() {} isDestroyed() { return false; } },
    ipcMain: { handle(ch, fn) { handlers[ch] = (...args) => fn({}, ...args); } },
    dialog: {}, shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p); }, openPath: async () => '' },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) },
  };
  return orig.call(this, r, ...a);
};
require(ROOT + '/main.js');
const call = async (ch, ...a) => { const r = await handlers[ch](...a); if (!r.ok) throw new Error(ch + ': ' + r.error); return r.data; };
const failed = [];
const check = (name, ok) => { if (!ok) failed.push(name); };
const read = (rel) => { const f = path.join(cit, ...rel.split('/')); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

test('the whole app: water, packs, mods, world, blood FX, Pack AI, editor, AI link, Gun Lab, cache, backups', async () => {
  await new Promise((r) => setTimeout(r, 50));
  await call('citizen:set', app);
  check('citizen linked', (await call('citizen:info')).citizenPath === cit);

  // ---- water ----
  await call('tweaks:set', 'water', true);
  const water = 'common/data/levels/gta5/water.xml';
  check('water removed: water.xml written', !!read(water));
  await call('tweaks:set', 'water', false);
  check('water back: water.xml gone again', read(water) === null);

  // ---- graphics packs: folder and zip, on / off / delete ----
  const packDir = path.join(tmp, 'Downloads', 'PvP Pack');
  fs.mkdirSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), buildTimecycle(['PVP']));
  fs.mkdirSync(path.join(packDir, 'mods'), { recursive: true });
  const st = buildYtd(['starfield'], 64, 64);
  fs.writeFileSync(path.join(packDir, 'mods', 'pvpsky.rpf'), rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'res', name: 'skydome.ytd', stored: st, sysFlags: st.readUInt32LE(8), gfxFlags: st.readUInt32LE(12) }] }));
  const id = await call('tweaks:addCustom', 'PvP Pack', [packDir], 'pack');
  await call('tweaks:set', id, true);
  check('pack on: its timecycle is in citizen', (read('common/data/timecycle/w_extrasunny.xml') || '').includes('PVP'));
  check('pack on: its RPF is in mods', fs.existsSync(path.join(mods, 'pvpsky.rpf')));
  await call('tweaks:set', id, false);
  check('pack off: original timecycle back', (read('common/data/timecycle/w_extrasunny.xml') || '').includes('EXTRASUNNY'));
  check('pack off: its RPF left mods', !fs.existsSync(path.join(mods, 'pvpsky.rpf')));
  await call('tweaks:set', id, true);
  await call('tweaks:removeCustom', id);
  check('pack deleted while on: game back to how it was', (read('common/data/timecycle/w_extrasunny.xml') || '').includes('EXTRASUNNY') && !fs.existsSync(path.join(mods, 'pvpsky.rpf')));
  check('pack deleted: gone from the list', !(await call('tweaks:list')).some((t) => t.id === id));
  const AdmZip = require('adm-zip');
  const z = new AdmZip(); z.addFile('Zip Pack/citizen/common/data/timecycle/w_clear.xml', Buffer.from(buildTimecycle(['ZIPCLEAR'])));
  const zf = path.join(tmp, 'Downloads', 'zip pack.zip'); z.writeZip(zf);
  const zid = await call('tweaks:addCustom', 'Zip Pack', [zf], 'pack');
  await call('tweaks:set', zid, true);
  check('zip pack on', (read('common/data/timecycle/w_clear.xml') || '').includes('ZIPCLEAR'));
  await call('tweaks:set', zid, false);
  check('zip pack off: file it added is removed', read('common/data/timecycle/w_clear.xml') === null);

  // ---- mods: add, off, on, remove ----
  const modFile = path.join(tmp, 'Downloads', 'guns.rpf');
  fs.writeFileSync(modFile, rpf.writeRpf({ type: 'dir', name: '', children: [] }));
  await call('mods:add', [modFile]);
  let ml = (await call('mods:list')).mods;
  check('mod added and on', ml.some((x) => x.name === 'guns.rpf' && x.enabled));
  await call('mods:set', 'guns.rpf', false);
  check('mod off: renamed to .rpf.off', fs.existsSync(path.join(mods, 'guns.rpf.off')) && !fs.existsSync(path.join(mods, 'guns.rpf')));
  ml = (await call('mods:list')).mods;
  check('mod off: listed as off', ml.some((x) => x.name === 'guns.rpf' && !x.enabled));
  await call('mods:set', 'guns.rpf', true);
  check('mod on again', fs.existsSync(path.join(mods, 'guns.rpf')) && !fs.existsSync(path.join(mods, 'guns.rpf.off')));
  await call('mods:trash', 'guns.rpf');
  check('mod removed (Recycle Bin)', trashed.length === 1 && !(await call('mods:list')).mods.some((x) => x.name === 'guns.rpf'));

  // ---- world: black mountains, player detail, snow (GTA V's own files) ----
  let mt = await call('world:mountains');
  check('black mountains found in GTA V', mt.available && mt.value === 1);
  mt = await call('world:setMountains', { removed: true });
  check('black mountains removed', mt.removed && (read('common/data/visualsettings.dat') || '').includes('farClipMultiplier\t0.5'));
  let pl = await call('world:pedLod');
  check('player detail: GTA default read', pl.available && pl.before === 25 && !pl.on);
  pl = await call('world:setPedLod', true);
  const vsNow = read('common/data/visualsettings.dat') || '';
  check('player detail fixed', pl.on && vsNow.includes('ped.lod.distance.high\t150') && vsNow.includes('pedincar.lod.distance.high.x64\t80'));
  check('both in the file together', vsNow.includes('farClipMultiplier\t0.5'));
  mt = await call('world:setMountains', { removed: false });
  check('black mountains back, player fix kept', !mt.removed && (read('common/data/visualsettings.dat') || '').includes('ped.lod.distance.high\t150') && (read('common/data/visualsettings.dat') || '').includes('farClipMultiplier\t1'));
  pl = await call('world:setPedLod', false);
  check('player detail default: game file used again', !pl.on && read('common/data/visualsettings.dat') === null);
  let sn = await call('world:snow');
  check('snow found in GTA V', sn.available && !sn.on);
  sn = await call('world:setSnow', 0.7);
  check('snow on', sn.on && (read('common/data/levels/gta5/weather.xml') || '').includes('<Snow value="0.700000"'));
  sn = await call('world:setSnow', 0);
  check('snow off', !sn.on && read('common/data/levels/gta5/weather.xml') === null);

  // ---- blood FX: an RPF with core.ypt ----
  const ypt = buildYtd(['blood_spray', 'fire'], 64, 64, { ypt: true });
  const bf = path.join(tmp, 'Downloads', 'Severance.rpf');
  fs.writeFileSync(bf, rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'res', name: 'core.ypt', stored: ypt, sysFlags: ypt.readUInt32LE(8), gfxFlags: ypt.readUInt32LE(12) }] }));
  const blood = await call('tex:openFiles', 'blood', [bf]);
  check('blood FX RPF opens', blood.items.length === 1 && blood.items[0].textures.map((t) => t.name).join() === 'blood_spray');
  const bt = blood.items[0].textures[0];
  const bres = await call('tex:install', 'blood', [{ key: 0, texIndex: bt.index, data: new Uint8Array(bt.data.length).fill(0x44) }]);
  check('blood FX installed into mods', bres.verified.includes('@mods/Severance.rpf') && fs.existsSync(path.join(mods, 'Severance.rpf')));

  // ---- Pack AI: build + install a pack ----
  const made = await call('pack:create', 'AI Pack', { 'common/data/timecycle/w_extrasunny.xml': buildTimecycle(['AIPACK']) }, { water: true }, {});
  check('AI pack installed', (read('common/data/timecycle/w_extrasunny.xml') || '').includes('AIPACK') && made.applied.includes('water'));
  await call('tweaks:removeCustom', made.id);
  await call('tweaks:set', 'water', false);
  check('AI pack undone', (read('common/data/timecycle/w_extrasunny.xml') || '').includes('EXTRASUNNY') && read(water) === null);

  // ---- Advanced editor on a pack in Downloads ----
  const op = await call('editor:openPack', { path: packDir });
  check('editor opens a pack from Downloads', op.files.length === 1);
  await call('editor:savePack', op.files[0].rel, '<x><cycle name="EDITED"/></x>');
  check('editor saves into that pack', fs.readFileSync(path.join(packDir, 'citizen', 'common', 'data', 'timecycle', 'w_extrasunny.xml'), 'utf8').includes('EDITED'));

  // ---- AI link settings (key stored encrypted) ----
  const cfg = await call('ai:setConfig', { url: 'https://api.anthropic.com', key: 'sk-ant-xyz', model: '' });
  check('AI link saved', cfg.on && cfg.hasKey && cfg.model === 'claude-opus-5-5');
  await call('ai:setConfig', { url: '', key: '' });
  check('AI link off', !(await call('ai:config')).on);

  // ---- Gun Lab: 3D text into a model ----
  const yd = buildYdr();
  const gf = path.join(tmp, 'Downloads', 'w_pi_test.rpf');
  fs.writeFileSync(gf, rpf.writeRpf({ type: 'dir', name: '', children: [{ type: 'res', name: 'w_pi_test.ydr', stored: yd, sysFlags: yd.readUInt32LE(8), gfxFlags: yd.readUInt32LE(12) }] }));
  await call('gun:open', gf);
  const part = { assetId: 0, lod: 0, model: 0, geometry: 0, template: 0, positions: [0.05, -0.01, 0.03, 0.08, -0.01, 0.03, 0.08, -0.01, 0.06], normals: [0, -1, 0, 0, -1, 0, 0, -1, 0], uvs: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9], indices: [0, 1, 2] };
  const outGun = path.join(tmp, 'out', 'w_pi_test.rpf');
  await call('gun:export', [], { path: outGun }, [part]);
  const { GunPack } = require(ROOT + '/src/core/gunpack');
  check('gun export has the 3D part', new GunPack(outGun).assets[0].meshes[0].positions.length / 3 === 7);

  // ---- cache ----
  const ci = await call('cache:info');
  check('cache sizes read', ci.find((x) => x.id === 'cache').bytes === 4096);
  await call('cache:clear', ['cache', 'server']);
  check('cache cleared', fs.readdirSync(path.join(app, 'data', 'cache')).length === 0 && fs.readdirSync(path.join(app, 'data', 'server-cache')).length === 0);

  // ---- backups: restore everything ----
  await call('world:setSnow', 1);
  await call('tweaks:set', 'water', true);
  check('backups list the changes', (await call('backups:list')).length >= 2);
  await call('backups:restoreAll');
  await call('world:setMountains', { removed: true });
  await call('world:setPedLod', true);
  await call('backups:restoreAll');
  check('restore everything: World options show off again', !(await call('world:mountains')).removed && !(await call('world:pedLod')).on && !(await call('world:snow')).on);
  check('restore everything: game back to stock', read(water) === null && read('common/data/levels/gta5/weather.xml') === null && (read('common/data/timecycle/w_extrasunny.xml') || '').includes('EXTRASUNNY'));

  assert.deepStrictEqual(failed, []);
});
