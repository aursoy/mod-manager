'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { CitizenManager } = require('./src/core/citizen');
const { GunPack } = require('./src/core/gunpack');
const { SoundPack } = require('./src/core/soundpack');
const { DiscordRpc } = require('./src/core/discord');
const extras = require('./src/core/extras');
const { Appearance } = require('./src/core/appearance');
const rpf = require('./src/core/rpf');
const { describePack, editableTimecycles, createPackWithTweaks } = require('./src/core/gfxpack');
const { findGtaDirs, DEFAULT_REL: SKY_REL } = require('./src/core/skytex');
const { openSkySource, skySources } = require('./src/core/skysource');
const { listSources, openSource, openFiles } = require('./src/core/texsource');
const { WorldFiles } = require('./src/core/worldfiles');
const { getLastUsage, credits, askPackAi, askJson, findGateway, listModels, provider: aiProvider } = require('./src/core/packai');
const { EditorPack, modsPacks } = require('./src/core/editorpack');
const { MOD_SCHEMA, MOD_SYSTEM, modContext, userMessage, buildMod, modRpf } = require('./src/core/modmaker');
const { readFileFrom, findInFile } = require('./src/core/rpfscan');
const { GtaKeys, findAesKey, findGtaExes } = require('./src/core/ngcrypto');

app.setName('Kt Mod Manager');
if (process.env.KT_USERDATA) app.setPath('userData', process.env.KT_USERDATA);

let win;
let mgr;
let gun = null;
let gfxPack = null; // pack dropped into the Pack AI: { info, staged }
let sky = null;     // sky texture being replaced: { ytd, rel, label, out }
const sounds = new SoundPack();
const discord = new DiscordRpc();
const startedAt = Date.now();
// The app's own Discord application (discord.com/developers), set once by whoever builds
// the app. With it, everyone's Discord profile shows up by itself; players never enter anything.
const DISCORD_APP_ID = String(process.env.KT_DISCORD_APP_ID || require('./package.json').discordAppId || '');

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    title: 'Kt Mod Manager',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required', // UI sounds play from the first click
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.env.KT_SHOT) runShots(process.env.KT_SHOT);
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
}

// Dev-only: KT_SHOT=<dir> walks the pages and saves screenshots.
function runShots(dir) {
  win.webContents.setBackgroundThrottling(false);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  };
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code).catch((e) => console.log('[js error]', e.message));
    const nav = (p) => js(`document.querySelector('#nav a[data-page="${p}"]').click()`);
    if (process.env.KT_CITIZEN) await js(`window.api.call('citizen:set', ${JSON.stringify(process.env.KT_CITIZEN)})`);
    await wait(800); await shot('0-splash');
    await wait(3200); await shot('1-home');
    for (const p of (process.env.KT_PAGES || 'graphics,world,mods,cache,backups,settings').split(',')) {
      await nav(p); await wait(1100); await shot('2-' + p);
    }
    await js(`document.getElementById('profile-card').click()`);
    await wait(900); await shot('3-profile');
    await js(`document.querySelector('.modal-back')?.click()`);
    await wait(500);
    if (process.env.KT_GUN) {
      await nav('gun'); await wait(700);
      await js(`import('./js/gunlab.js').then(m => m.openGunFile(${JSON.stringify(process.env.KT_GUN)}))`);
      await wait(Number(process.env.KT_GUN_WAIT || 3000)); await shot('4-gun');
      await js(`(() => { document.querySelector('#gun-swatches .sw[data-hex="#9b5cff"]').click();
        document.querySelector('#inspector-tabs .tab[data-tab=text]').click();
        document.getElementById('text-add').click(); })()`);
      await wait(1200); await shot('5-gun-edit');
      await js(`document.querySelector('.vt[data-view="2d"]').click()`);
      await wait(700);
      const perf = await js(`import('./js/gunlab.js').then(m => m.perfProbe())`);
      console.log('[perf]', JSON.stringify(perf));
      await shot('6-gun-2d');
    }
    if (process.env.KT_SOUND) {
      await nav('sound'); await wait(700);
      js(`import('./js/soundlab.js').then(m => m.openSoundFiles([${JSON.stringify(process.env.KT_SOUND)}]))`);
      await wait(1500);
      if (process.env.KT_UNLOCK) {
        await shot('7a-unlock-prompt');
        await js(`document.querySelector('.modal-back [data-r="1"]')?.click()`);
        await wait(3500); await shot('7b-unlocking');
        await wait(9000);
      }
      await js(`document.querySelector('#bank-list li[data-id]')?.click()`);
      await wait(900);
      await js(`document.querySelector('#stream-list li[data-id]')?.click()`);
      await wait(900); await shot('7-sound');
    }
    app.quit();
  });
}

// Wrap handlers so the renderer always gets { ok, data | error }.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { ok: false, error: (err && err.code === rpf.NEED_KEYS ? '[NEED_KEYS] ' : '') + msg };
    }
  });
}

function appPath() {
  const info = mgr.info();
  if (!info.citizenPath) throw new Error('Select your citizen folder first.');
  return path.dirname(info.citizenPath);
}

app.whenReady().then(() => {
  mgr = new CitizenManager(path.join(app.getPath('userData'), 'data'));

  // ----- encrypted RPF keys (read from the user's own GTA5.exe, cached) -----
  const keyFile = path.join(app.getPath('userData'), 'data', 'gta-keys.json');
  try {
    const cached = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    rpf.setKeys(new GtaKeys(Buffer.from(cached.aes, 'hex')));
  } catch (e) { /* not unlocked yet */ }
  handle('keys:status', () => ({ ready: !!rpf.getKeys(), exes: findGtaExes() }));
  handle('keys:pickExe', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select GTA5.exe', properties: ['openFile'], filters: [{ name: 'GTA V', extensions: ['exe'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  const unlockKeys = async (exe) => {
    const aes = await findAesKey(exe, (p) => win.webContents.send('keys:progress', p));
    rpf.setKeys(new GtaKeys(aes));
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({ aes: aes.toString('hex'), exe }));
    mgr.log('success', 'Unlocked encrypted RPFs using ' + path.basename(exe));
    mgr.save();
    return true;
  };
  const cachedExe = () => { try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')).exe || null; } catch (e) { return null; } };
  handle('keys:unlock', (exe) => unlockKeys(exe));

  handle('win:minimize', () => win.minimize());
  handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());

  // ----- citizen -----
  handle('citizen:info', () => mgr.info());
  handle('citizen:autodetect', () => CitizenManager.autodetect());
  handle('citizen:set', (dir) => mgr.setCitizen(dir));
  handle('citizen:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select your citizen folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('citizen:open', () => shell.openPath(mgr.requireCitizen()));
  handle('citizen:launch', () => {
    const info = mgr.info();
    if (!info.fiveMExe) throw new Error('FiveM.exe not found next to FiveM.app.');
    return shell.openPath(info.fiveMExe);
  });
  handle('citizen:history', () => mgr.state.history);

  // ----- tweaks / packs -----
  handle('tweaks:list', () => mgr.listTweaks());
  handle('tweaks:set', (id, on) => mgr.setTweak(id, on));
  handle('tweaks:import', (id, sources) => mgr.importFiles(id, sources));
  handle('tweaks:addCustom', (name, sources, kind) => mgr.addCustom(name, sources, kind));
  handle('tweaks:removeCustom', (id) => mgr.removeCustom(id));
  handle('pick:files', async (opts = {}) => {
    const props = opts.directory ? ['openDirectory'] : ['openFile', 'multiSelections'];
    const r = await dialog.showOpenDialog(win, { title: opts.title || 'Select files', properties: props, filters: opts.filters });
    return r.canceled ? null : r.filePaths;
  });

  handle('colour:scan', () => mgr.scanTimecycle());
  handle('colour:apply', (opts) => mgr.applyColour(opts));
  handle('colour:reset', () => mgr.resetColour());
  handle('colour:state', () => mgr.state.colour);
  handle('colour:activate', (rel) => mgr.activateTimecycle(rel));
  handle('colour:base', (rel) => mgr.tintBase(rel));

  // ----- timecycle editor / graphics AI -----
  handle('timecycle:read', (rel, opts) => mgr.readTimecycle(rel, opts));
  handle('timecycle:write', (rel, xml) => mgr.writeTimecycle(rel, xml));
  handle('timecycle:open', async (given) => {
    let f = given;
    if (!f) {
      const r = await dialog.showOpenDialog(win, { title: 'Open a timecycle XML', properties: ['openFile'], filters: [{ name: 'Timecycle XML', extensions: ['xml'] }] });
      if (r.canceled) return null;
      f = r.filePaths[0];
    }
    if (!/\.xml$/i.test(f)) throw new Error('Pick an .xml file.');
    if (fs.statSync(f).size > 16 * 1048576) throw new Error('That file is too big to be a timecycle.');
    return { name: path.basename(f), xml: fs.readFileSync(f, 'utf8') };
  });
  handle('timecycle:export', async (name, xml) => {
    const r = await dialog.showSaveDialog(win, { title: 'Export timecycle', defaultPath: name, filters: [{ name: 'XML', extensions: ['xml'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, xml);
    return r.filePath;
  });
  // ----- Advanced editor: timecycles from any pack, installed or not -----
  let edPack = null;
  const editorModsDir = () => (mgr.state.citizenPath ? path.join(path.dirname(mgr.state.citizenPath), 'mods') : null);
  handle('editor:packs', () => [
    ...mgr.listTweaks().filter((t) => t.kind === 'pack').map((t) => ({ id: t.id, name: t.name, enabled: t.enabled })),
    // graphics packs dropped straight into FiveM.app/mods
    ...(editorModsDir() ? modsPacks(editorModsDir(), findInFile) : []).map((x) => ({ id: 'mods:' + x.name, name: 'mods / ' + x.name, enabled: true })),
  ]);
  handle('editor:openPack', async (src) => {
    if (src && src.id && src.id.startsWith('mods:')) {
      const file = path.join(editorModsDir() || '', path.basename(src.id.slice(5)));
      try { edPack = EditorPack.fromRpf(file); } catch (e) {
        if (e.code !== rpf.NEED_KEYS) throw e;
        await skyCtx().unlock();
        edPack = EditorPack.fromRpf(file);
      }
    } else if (src && src.id) edPack = EditorPack.installed(mgr, src.id);
    else {
      let p = src && src.path;
      if (!p) {
        const r = await dialog.showOpenDialog(win, { title: 'Open a graphics pack (folder, .zip or .rpf)', properties: ['openFile', 'openDirectory'], filters: [{ name: 'Graphics pack', extensions: ['zip', 'rpf', 'xml'] }] });
        if (r.canceled) return null;
        p = r.filePaths[0];
      }
      edPack = EditorPack.open(p);
    }
    if (!edPack.files.length) { const n = edPack.name; edPack = null; throw new Error(n + ' has no timecycle files.'); }
    return { name: edPack.name, files: edPack.list() };
  });
  handle('editor:readPack', (rel) => { if (!edPack) throw new Error('Open a pack first.'); return edPack.read(rel); });
  handle('editor:savePack', (rel, xml) => { if (!edPack) throw new Error('Open a pack first.'); return edPack.save(rel, xml); });

  // ----- Pack AI: a dropped pack to build on, and the sky texture -----
  const gtaDirs = () => findGtaDirs({ citizenPath: mgr.state.citizenPath, knownExe: cachedExe(), exes: findGtaExes() });
  handle('gfx:loadPack', (sources) => {
    const staged = mgr.stageSources(sources);
    const name = path.basename(sources[0]).replace(/\.zip$/i, '');
    gfxPack = { staged, info: describePack(name, staged) };
    sky = null;
    return gfxPack.info;
  });
  handle('gfx:clearPack', () => { gfxPack = null; sky = null; return true; });
  handle('gfx:packTimecycles', () => (gfxPack ? editableTimecycles(gfxPack.staged, gfxPack.info) : null));
  const skyCtx = () => ({
    pack: gfxPack, mgr, gtaDirs,
    // An encrypted archive is unlocked once with the player's own GTA V (read-only, cached).
    unlock: async () => {
      const dir = gtaDirs()[0];
      const exe = dir && ['GTA5.exe', 'GTA5_Enhanced.exe'].map((x) => path.join(dir, x)).find((x) => fs.existsSync(x));
      if (!exe) throw new Error('This archive is encrypted and GTA V was not found to unlock it.');
      await unlockKeys(exe);
    },
  });
  handle('sky:status', () => ({ sources: skySources(skyCtx()), loaded: sky ? { label: sky.label, rel: sky.rel, applied: !!sky.out } : null }));
  // source: 'pack' | 'pack-rpf' | 'mods' | 'citizen' | 'game' | 'pick'
  handle('sky:open', async (source) => {
    if (source === 'pick') {
      const r = await dialog.showOpenDialog(win, { title: 'Choose your sky file', properties: ['openFile'], filters: [{ name: 'Sky (skydome.ytd or a sky .rpf)', extensions: ['ytd', 'rpf'] }] });
      if (r.canceled) return null;
      source = { file: r.filePaths[0] };
    }
    const got = await openSkySource(source, skyCtx());
    if (!got) throw new Error('No sky found there.');
    sky = { obj: got.obj, rel: got.rel, label: got.label, out: null };
    return { label: got.label, rel: got.rel, textures: got.obj.describe(), skyIndex: got.obj.skyIndex() };
  });
  // The sky picture the editor preview draws: the open pack's own skydome.ytd, or the one
  // your game uses (mods folder, then citizen, then GTA V). GTA adds it to the sky scaled
  // by the timecycle's stars intensity, which is how picture-sky packs paint their sky.
  const skyPics = new Map();
  handle('sky:picture', async (where) => {
    const key = where === 'pack' ? 'pack:' + (edPack ? edPack.where : '') : 'game';
    const hit = skyPics.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    let got = null;
    if (where === 'pack') {
      if (!edPack) return null;
      try { got = edPack.sky(); } catch (e) {
        if (e.code !== rpf.NEED_KEYS) throw e;
        await skyCtx().unlock(); edPack._sky = undefined; got = edPack.sky();
      }
    } else {
      const ctx = { ...skyCtx(), pack: null };
      for (const src of skySources(ctx)) {
        try { got = await openSkySource(src, ctx); } catch (e) { got = null; }
        if (got) break;
      }
    }
    let value = null;
    if (got) {
      const i = got.obj.skyIndex();
      const t = got.obj.describe(true)[i];
      if (t) value = { label: got.label, name: t.name, width: t.width, height: t.height, format: t.format, data: t.data };
    }
    skyPics.set(key, { at: Date.now(), value });
    return value;
  });
  handle('sky:apply', (index, data) => {
    if (!sky) throw new Error('Open a sky texture first.');
    skyPics.clear();
    sky.out = sky.obj.replace(index, Buffer.from(data));
    // FiveM loads the sky from citizen/platform/textures/skydome.ytd. When the sky came
    // from an RPF, write that too, so the picture shows whichever one the game uses.
    sky.outputs = { [sky.rel]: sky.out };
    if (sky.rel !== SKY_REL) sky.outputs[SKY_REL] = sky.obj.ytdBytes();
    return { bytes: sky.out.length, rel: sky.rel, outputs: Object.keys(sky.outputs) };
  });
  // ----- world: black mountains, snow, visual settings -----
  const world = new WorldFiles(mgr, path.join(app.getPath('userData'), 'data'), (arc, inner) => {
    const dir = gtaDirs()[0];
    const file = dir && path.join(dir, ...arc.split('/'));
    return file && fs.existsSync(file) ? readFileFrom(file, inner) : null;
  }, { gtaDir: () => gtaDirs()[0] || null });
  // GTA V's archives are encrypted: unlock once (read-only, cached) and try again.
  const worldCall = async (fn) => {
    world.needKeys = false;
    let r;
    try { r = fn(); } catch (e) {
      if (e.code !== rpf.NEED_KEYS || rpf.getKeys()) throw e;
      await skyCtx().unlock();
      return fn();
    }
    if (world.needKeys && !rpf.getKeys()) { await skyCtx().unlock(); world.needKeys = false; r = fn(); }
    return r;
  };
  handle('world:mountains', () => worldCall(() => world.mountains()));
  handle('world:setMountains', (opts) => worldCall(() => world.setMountains(opts)));
  handle('world:pedLod', () => worldCall(() => world.pedLod()));
  handle('world:setPedLod', (on) => worldCall(() => world.setPedLod(on)));
  // ----- AI Mod Maker -----
  let madeMod = null; // { name, files, done, skipped }
  let modCtx = null;
  handle('mod:ask', async (text, current) => {
    const read = (rel) => world.current(rel);
    if (!modCtx || !modCtx.visualsettings.length) modCtx = await worldCall(() => modContext(read));
    const plan = await aiRun(() => askJson(aiCfg(), { system: MOD_SYSTEM, schema: MOD_SCHEMA, user: userMessage(text, modCtx, current) }));
    if (!plan || typeof plan.reply !== 'string') throw new Error('The AI answer was missing parts.');
    madeMod = await worldCall(() => buildMod(plan, read));
    return { reply: plan.reply, plan, mod: { name: madeMod.name, done: madeMod.done, skipped: madeMod.skipped, files: Object.keys(madeMod.files) } };
  });
  handle('mod:install', () => {
    if (!madeMod || !Object.keys(madeMod.files).length) throw new Error('Make a mod first.');
    const id = mgr.createPack(madeMod.name, madeMod.files);
    const r = mgr.setTweak(id, true);
    mgr.log('success', 'Installed AI mod "' + madeMod.name + '"');
    mgr.save();
    return { id, name: madeMod.name, conflicts: r.conflicts || [] };
  });
  handle('mod:saveRpf', async () => {
    if (!madeMod || !Object.keys(madeMod.files).length) throw new Error('Make a mod first.');
    const r = await dialog.showSaveDialog(win, { title: 'Save mod as .rpf', defaultPath: madeMod.name.replace(/\s+/g, '_') + '.rpf', filters: [{ name: 'RPF', extensions: ['rpf'] }] });
    if (r.canceled) return null;
    const bytes = modRpf(madeMod.files, { name: madeMod.name, description: madeMod.done.join('\n') });
    fs.writeFileSync(r.filePath, bytes);
    return { path: r.filePath, bytes: bytes.length };
  });
  // the same .rpf straight into your own FiveM.app/mods, to try it the way your mates will
  handle('mod:toMods', () => {
    if (!madeMod || !Object.keys(madeMod.files).length) throw new Error('Make a mod first.');
    const dir = path.join(appPath(), 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'kt_' + madeMod.name.replace(/[^\w-]+/g, '_').toLowerCase() + '.rpf');
    if (fs.existsSync(out)) fs.copyFileSync(out, out + '.bak');
    fs.writeFileSync(out, modRpf(madeMod.files, { name: madeMod.name, description: madeMod.done.join('\n') }));
    mgr.log('success', 'Put AI mod "' + madeMod.name + '" in FiveM.app/mods');
    mgr.save();
    return { path: out };
  });
  handle('world:stars', () => worldCall(() => world.stars()));
  handle('world:setStars', (mode) => worldCall(() => world.setStars(mode)));
  handle('world:lightning', () => worldCall(() => world.lightning()));
  handle('world:setLightning', (off) => worldCall(() => world.setLightning(off)));
  handle('world:thunder', () => worldCall(() => world.thunder()));
  handle('world:setThunder', (off) => worldCall(() => world.setThunder(off)));
  handle('world:clouds', () => worldCall(() => world.stillClouds()));
  handle('world:setClouds', (on) => worldCall(() => world.setStillClouds(on)));
  handle('world:snow', () => worldCall(() => world.snow()));
  handle('world:setSnow', (amount) => worldCall(() => world.setSnow(amount)));
  handle('world:visual', () => worldCall(() => world.visualSettings()));
  handle('world:saveVisual', (changes) => worldCall(() => world.saveVisualSettings(changes)));
  handle('world:resetVisual', () => world.resetVisualSettings());

  // ----- texture labs: clouds, blood FX -----
  const labs = {};
  const PACK_NAMES = { clouds: 'Custom clouds', blood: 'Custom blood FX' };
  const labInfo = (kind) => ({
    label: labs[kind].label,
    items: labs[kind].items.map((x) => {
      const all = x.ytd.describe(true);
      return { key: x.key, name: x.name, file: x.file, path: x.path, textures: x.order ? x.order.map((i) => all[i]) : all };
    }),
  });
  handle('tex:list', (kind) => listSources(kind, skyCtx()));
  handle('tex:open', async (kind, id) => { labs[kind] = await openSource(kind, id, skyCtx()); return labInfo(kind); });
  handle('tex:openFiles', async (kind, given) => {
    let paths = given;
    if (!paths) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose your blood FX .rpf', properties: ['openFile'], filters: [{ name: 'Blood FX RPF', extensions: ['rpf'] }] });
      if (r.canceled) return null;
      paths = r.filePaths;
    }
    labs[kind] = await openFiles(kind, paths, skyCtx());
    return labInfo(kind);
  });
  const applyEdits = (kind, edits) => {
    const lab = labs[kind];
    if (!lab) throw new Error('Open something first.');
    for (const e of edits) lab.replace(e.key, e.texIndex, Buffer.from(e.data));
    return lab;
  };
  handle('tex:install', (kind, edits) => {
    const outputs = applyEdits(kind, edits).outputs();
    if (!Object.keys(outputs).length) throw new Error('Change something first.');
    return createPackWithTweaks(mgr, PACK_NAMES[kind] || 'Custom textures', {}, {}, { extra: outputs }, (rel) => fs.readFileSync(mgr.absFor(rel)));
  });
  // "Save to folder": the edited .ytd files as they are (for a server's stream folder)
  handle('tex:saveFolder', async (kind, edits) => {
    const lab = applyEdits(kind, edits);
    if (!lab.files) throw new Error('These textures go back into their own archive; use Install.');
    const files = lab.files();
    if (!files.length) throw new Error('Change something first.');
    const r = await dialog.showOpenDialog(win, { title: 'Save the edited textures to…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    for (const f of files) fs.writeFileSync(path.join(r.filePaths[0], f.name), f.bytes);
    return { dir: r.filePaths[0], count: files.length };
  });

  handle('sky:export', async () => {
    if (!sky || !sky.out) throw new Error('Nothing to export yet.');
    const r = await dialog.showSaveDialog(win, { title: 'Export sky texture', defaultPath: path.basename(sky.rel), filters: [{ name: 'Sky file', extensions: [path.extname(sky.rel).slice(1)] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, sky.out);
    return r.filePath;
  });

  // Files become a new pack (switched on), then each world switch is flipped if its files exist.
  // opts.includePack: start from every file of the pack dropped into the chat. opts.includeSky: add the new sky texture.
  handle('pack:create', (name, edits, tweaks = {}, opts = {}) => createPackWithTweaks(mgr, name, edits, tweaks, {
    ...opts,
    staged: opts.includePack && gfxPack ? gfxPack.staged : [],
    extra: opts.includeSky && sky && sky.outputs ? sky.outputs : {},
  }, (rel) => fs.readFileSync(mgr.absFor(rel))));
  const IMG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
  const readImage = (f) => {
    const type = IMG_TYPES[path.extname(f).toLowerCase()];
    if (!type) throw new Error('Pick a PNG, JPG, WebP, GIF or BMP image.');
    if (fs.statSync(f).size > 20 * 1048576) throw new Error('Pick an image under 20 MB.');
    return { name: path.basename(f), mediaType: type, data: fs.readFileSync(f).toString('base64') };
  };
  handle('gfx:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    return r.canceled ? null : readImage(r.filePaths[0]);
  });
  handle('gfx:readImage', (f) => readImage(f));

  handle('backups:list', () => mgr.listBackups());
  handle('backups:restoreAll', () => { const r = mgr.restoreAll(); try { world.syncMods(); } catch (e) { mgr.log('warn', 'Could not put back packs in mods: ' + e.message); } return r; });

  // ----- mods folder -----
  const modsPath = () => path.join(appPath(), 'mods');
  handle('mods:list', () => ({ path: modsPath(), mods: extras.listMods(modsPath()) }));
  handle('mods:set', (name, on) => { extras.setModEnabled(modsPath(), name, on); return extras.listMods(modsPath()); });
  handle('mods:add', (files) => { const added = extras.addMods(modsPath(), files); return { added, mods: extras.listMods(modsPath()) }; });
  handle('mods:trash', async (file) => { await shell.trashItem(path.join(modsPath(), file)); return extras.listMods(modsPath()); });
  handle('mods:open', () => { fs.mkdirSync(modsPath(), { recursive: true }); return shell.openPath(modsPath()); });

  // ----- cache -----
  handle('cache:info', () => extras.cacheInfo(appPath()));
  handle('cache:clear', async (ids) => { const freed = await extras.clearCache(appPath(), ids); mgr.log('success', 'Cleared ' + (freed / 1048576).toFixed(0) + ' MB of FiveM cache'); mgr.save(); return freed; });

  // ----- presets -----
  const enabledMods = () => { try { return extras.listMods(modsPath()).filter((m) => m.enabled).map((m) => m.name); } catch (e) { return null; } };
  handle('presets:list', () => mgr.listPresets());
  handle('presets:save', (name) => mgr.savePreset(name, enabledMods()));
  handle('presets:delete', (id) => { mgr.deletePreset(id); return mgr.listPresets(); });
  handle('presets:apply', (id) => {
    const p = mgr.applyPreset(id);
    if (p.mods) {
      for (const m of extras.listMods(modsPath())) extras.setModEnabled(modsPath(), m.name, p.mods.includes(m.name));
    }
    return p;
  });

  // ----- custom background -----
  const look = new Appearance(mgr, path.join(app.getPath('userData'), 'data'));
  handle('look:get', () => look.load());
  handle('look:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a background', properties: ['openFile'], filters: [{ name: 'Pictures and videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm'] }] });
    if (r.canceled) return null;
    look.setFile(r.filePaths[0]);
    return look.load();
  });
  handle('look:file', (file) => { look.setFile(file); return look.load(); });
  handle('look:set', (patch) => look.set(patch));
  handle('look:clear', () => look.clear());

  // ----- AI (the Graphics AI chat): any provider's API key -----
  // The key is stored encrypted with the OS keychain when Electron can.
  const aiCfg = () => {
    const a = mgr.state.ai || {};
    let key = '';
    try { key = a.key ? (a.enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(a.key, 'base64')) : a.key) : ''; } catch (e) { key = ''; }
    return { url: a.url || '', model: a.model || '', key };
  };
  const aiPublic = () => {
    const c = aiCfg();
    const p = (c.key || c.url) ? aiProvider(c) : null;
    return { url: c.url, model: c.model, hasKey: !!c.key, on: !!(c.key || c.url), provider: p ? p.name : (c.key ? 'Unknown' : '') };
  };
  handle('ai:config', () => aiPublic());
  handle('ai:setConfig', (patch) => {
    const cur = aiCfg();
    const next = { url: String(patch.url ?? cur.url).trim(), model: String(patch.model ?? cur.model).trim(), key: patch.key != null ? String(patch.key).trim() : cur.key };
    if (next.url && !/^https?:\/\//i.test(next.url)) throw new Error('The link must start with http:// or https://');
    const enc = !!next.key && safeStorage.isEncryptionAvailable();
    mgr.state.ai = { url: next.url, model: next.model, key: next.key ? (enc ? safeStorage.encryptString(next.key).toString('base64') : next.key) : '', enc };
    mgr.save();
    return aiPublic();
  });
  handle('ai:models', async () => {
    const c = aiCfg();
    try { return await listModels(c); } catch (e) {
      // no link given: find where the key works (any provider, or an AI router on this PC)
      if (c.url) throw e;
      const g = await findGateway(c.key);
      if (!g) throw new Error('No AI service accepted this key. Check it was copied whole. For an AI router (OmniRoute, LiteLLM...) press "API link" and paste its address, e.g. http://localhost:20128/v1');
      mgr.state.ai = { ...mgr.state.ai, url: g.url, model: '' };
      mgr.save();
      return listModels(aiCfg());
    }
  });
  // usage: requests and tokens today (counted here), plus what the provider says is left
  const countAi = () => {
    const day = new Date().toISOString().slice(0, 10);
    const u = mgr.state.aiCount && mgr.state.aiCount.day === day ? mgr.state.aiCount : { day, requests: 0, tokens: 0 };
    const last = getLastUsage();
    u.requests++; u.tokens += last ? last.tokensUsed || 0 : 0;
    mgr.state.aiCount = u;
    mgr.save();
  };
  const aiRun = async (fn) => { try { return await fn(); } finally { countAi(); } };
  handle('ai:ask', (input) => aiRun(() => askPackAi(aiCfg(), input)));
  handle('ai:usage', async () => {
    const c = aiCfg();
    const day = new Date().toISOString().slice(0, 10);
    const today = mgr.state.aiCount && mgr.state.aiCount.day === day ? mgr.state.aiCount : { day, requests: 0, tokens: 0 };
    const p = (c.key || c.url) ? aiProvider(c) : null;
    return { provider: p ? p.name : null, today, last: getLastUsage(), credits: await credits(c) };
  });
  handle('ai:test', async () => (await askPackAi(aiCfg(), { text: 'pvp pack, no fog', spec: null })).reply);

  // ----- profile / discord -----
  handle('profile:get', () => ({ ...mgr.getProfile(), discordLive: !!discord.sock, discordBuiltIn: !!DISCORD_APP_ID }));
  handle('profile:set', (patch) => mgr.setProfile(patch));
  handle('profile:pickAvatar', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose avatar', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0];
    if (fs.statSync(f).size > 4 * 1048576) throw new Error('Pick an image under 4 MB.');
    const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return 'data:image/' + ext + ';base64,' + fs.readFileSync(f).toString('base64');
  });
  handle('discord:connect', async (clientId) => {
    const id = String(DISCORD_APP_ID || mgr.getProfile().discordClientId || '');
    if (!id) throw new Error('Discord is not set up in this build of the app.');
    const user = await discord.connect(id);
    mgr.setProfile({ discord: user, discordOff: false });
    discord.setActivity('Modding FiveM', 'Kt Mod Manager', startedAt);
    return user;
  });
  handle('discord:disconnect', () => { discord.disconnect(); return mgr.setProfile({ discord: null, discordOff: true }); });
  // Connects by itself: at start, and again every 30 s while Discord is closed.
  const autoDiscord = async () => {
    const p = mgr.getProfile();
    const id = DISCORD_APP_ID || p.discordClientId;
    if (discord.sock || discord.busy || !id || p.discordOff) return;
    discord.busy = true;
    try {
      const user = await discord.connect(id);
      mgr.setProfile({ discord: user });
      discord.setActivity('Modding FiveM', 'Kt Mod Manager', startedAt);
    } catch (e) { /* Discord not open yet */ }
    discord.busy = false;
    if (win && !win.isDestroyed()) win.webContents.send('profile:changed');
  };
  setTimeout(autoDiscord, 1500).unref();
  setInterval(autoDiscord, 30000).unref();
  handle('discord:activity', (details, state) => discord.setActivity(details, state, startedAt));

  // ----- gun lab -----
  handle('gun:open', (file) => {
    gun = new GunPack(file);
    return gun.describe();
  });
  handle('gun:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open gun archive',
      properties: ['openFile'],
      filters: [{ name: 'GTA files', extensions: ['rpf', 'ytd', 'ydr'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // Fonts for 3D text: the real font file when Windows has it, else a font that ships with three.js.
  const FONT_FILES = { 'Impact': ['impact.ttf'], 'Arial Black': ['ariblk.ttf'], 'Bahnschrift': ['bahnschrift.ttf'], 'Georgia': ['georgiab.ttf', 'georgia.ttf'], 'Segoe Script': ['segoescb.ttf', 'segoesc.ttf'] };
  const TYPEFACES = { 'Helvetiker': 'helvetiker_bold', 'Optimer': 'optimer_bold', 'Gentilis': 'gentilis_bold', 'Georgia': 'droid/droid_serif_bold', 'JetBrains Mono': 'droid/droid_sans_mono_regular' };
  const fontDirs = () => [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'),
  ].filter(Boolean);
  handle('gun:font', (name) => {
    for (const f of FONT_FILES[name] || []) {
      for (const d of fontDirs()) {
        const file = path.join(d, f);
        if (fs.existsSync(file)) return { type: 'ttf', data: fs.readFileSync(file) };
      }
    }
    const tf = TYPEFACES[name] || 'helvetiker_bold';
    return { type: 'json', text: fs.readFileSync(path.join(__dirname, 'node_modules', 'three', 'examples', 'fonts', ...(tf + '.typeface.json').split('/')), 'utf8') };
  });
  handle('gun:pickFont', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a font', properties: ['openFile'], defaultPath: fontDirs()[0], filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }] });
    if (r.canceled) return null;
    const file = r.filePaths[0];
    if (fs.statSync(file).size > 30 * 1048576) throw new Error('That font file is too big.');
    return { name: path.basename(file).replace(/\.(ttf|otf)$/i, ''), data: fs.readFileSync(file) };
  });
  handle('gun:export', async (edits, opts = {}, geometry = []) => {
    if (!gun) throw new Error('Open a gun file first.');
    gun.applyEdits(edits.map((e) => ({ ...e, data: Buffer.from(e.data) })), geometry, { shine: opts.shine });
    let out = opts.path;
    if (opts.toMods) out = path.join(appPath(), 'mods', path.basename(gun.filePath));
    if (!out) {
      const ext = gun.kind.slice(1);
      const r = await dialog.showSaveDialog(win, {
        title: 'Export gun',
        defaultPath: path.join(path.dirname(gun.filePath), path.basename(gun.filePath, gun.kind) + '_custom' + gun.kind),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (r.canceled) return null;
      out = r.filePath;
    }
    if (path.resolve(out) === path.resolve(gun.filePath)) fs.copyFileSync(gun.filePath, gun.filePath + '.bak');
    const bytes = gun.write(out);
    mgr.log('success', 'Exported gun to ' + out);
    mgr.save();
    return { path: out, bytes };
  });

  // ----- sound lab -----
  handle('sound:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open sound RPFs (WEAPONS_PLAYER, RESIDENT...)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio archives', extensions: ['rpf'] }] });
    return r.canceled ? null : r.filePaths;
  });
  handle('sound:pickAudio', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a sound', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0];
    return { name: path.basename(f), data: new Uint8Array(fs.readFileSync(f)) };
  });
  handle('sound:readAudio', (file) => ({ name: path.basename(file), data: new Uint8Array(fs.readFileSync(file)) }));
  handle('sound:open', (files) => { let d; for (const f of files) d = sounds.open(f); return d; });
  handle('sound:close', (id) => sounds.close(id));
  handle('sound:state', () => sounds.describe());
  handle('sound:streams', (bankId) => sounds.streams(bankId));
  handle('sound:pcm', (bankId, streamId, original) => sounds.pcm(bankId, streamId, original));
  handle('sound:replace', (bankId, streamId, pcm, rate) => sounds.replace(bankId, streamId, pcm, rate));
  handle('sound:revert', (bankId, streamId) => sounds.revert(bankId, streamId));
  handle('sound:export', async (archiveId, opts = {}) => {
    const a = sounds.archives.find((x) => x.id === archiveId);
    if (!a) throw new Error('Unknown archive');
    const bytes = sounds.build(archiveId);
    let out;
    if (opts.toCitizen) {
      // Journaled like every other citizen write, so Backups can undo it.
      const rel = 'platform/audio/sfx/' + a.name;
      mgr.writeFile(rel, bytes, 'sounds');
      mgr.log('success', 'Installed sound pack ' + a.name);
      mgr.save();
      out = path.join(mgr.requireCitizen(), ...rel.split('/'));
    } else {
      const r = await dialog.showSaveDialog(win, { title: 'Export sound pack', defaultPath: a.file.replace(/\.rpf$/i, '_kt.rpf'), filters: [{ name: 'RPF', extensions: ['rpf'] }] });
      if (r.canceled) return null;
      out = r.filePath;
      fs.writeFileSync(out, bytes);
    }
    return { path: out, bytes: bytes.length };
  });

  // PNGs from the texture labs: one file asks where to save it, several go in a chosen folder
  handle('images:save', async (files, opts = {}) => {
    const clean = (n) => String(n || 'image.png').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!Array.isArray(files) || !files.length) return null;
    if (files.length === 1) {
      const r = await dialog.showSaveDialog(win, { title: opts.title || 'Save image', defaultPath: clean(files[0].name), filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (r.canceled) return null;
      fs.writeFileSync(r.filePath, Buffer.from(files[0].data));
      return { count: 1, where: r.filePath };
    }
    const r = await dialog.showOpenDialog(win, { title: opts.title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const used = new Set();
    for (const f of files) {
      let name = clean(f.name);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = clean(f.name).replace(/(\.png)?$/i, '_' + i + '.png');
      used.add(name.toLowerCase());
      fs.writeFileSync(path.join(r.filePaths[0], name), Buffer.from(f.data));
    }
    return { count: files.length, where: r.filePaths[0] };
  });

  handle('shell:reveal', (p) => shell.showItemInFolder(p));
  handle('shell:external', (url) => {
    if (!/^https:\/\/(discord\.com|discord\.dev)\//.test(url)) throw new Error('Blocked URL');
    return shell.openExternal(url);
  });

  createWindow();
});

app.on('window-all-closed', () => { discord.disconnect(); app.quit(); });
