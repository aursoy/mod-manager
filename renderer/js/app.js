import { hydrateIcons, icon } from './icons.js';
import { notify, initDrawer, settings as notifySettings } from './notify.js';
import { initBackground, initInteractions, syncSeg, countUp, stagger, busy, fillRange, fxState } from './fx.js';
import { initKeys } from './keys.js';
import { initStudio, refreshStudio, handleDrop as studioDrop } from './tcstudio.js';
import { initPages, refreshMods, refreshPresets, refreshCache, refreshProfile, addModFiles } from './pages.js';

// Gun/Sound labs pull in three.js. Load them dynamically so a missing
// node_modules/three (or any import failure) cannot prevent the rest of the
// app — and the splash screen — from finishing.
let openGunFile = async () => { notify.warning('Gun Lab unavailable', 'Could not load the 3D module. Run npm install.'); };
let handleSoundDrop = () => {};
async function loadHeavyLabs() {
  try {
    const gun = await import('./gunlab.js');
    openGunFile = gun.openGunFile;
    gun.initGunLab();
  } catch (err) {
    console.error('[boot] Gun Lab failed to load:', err);
  }
  try {
    const snd = await import('./soundlab.js');
    handleSoundDrop = snd.handleSoundDrop;
    snd.initSoundLab();
  } catch (err) {
    console.error('[boot] Sound Lab failed to load:', err);
  }
}

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

let info = { citizenPath: null };
let currentPage = 'home';

// ---------- modal ----------
export function modal({ title, text, confirm = 'Confirm', cancel = 'Cancel', input = null, danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text || '')}</p>
      ${input !== null ? `<label class="field"><span>${esc(input.label || '')}</span><input type="text" value="${esc(input.value || '')}" /></label>` : ''}
      <div class="row-end"><button class="btn ghost" data-r="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(confirm)}</button></div></div>`;
    $('#modal-root').appendChild(back);
    const field = $('input', back);
    if (field) { field.focus(); field.select(); }
    const close = (ok) => {
      back.classList.add('out');
      setTimeout(() => back.remove(), 300);
      resolve(ok ? (field ? field.value.trim() || null : true) : (field ? null : false));
    };
    back.onclick = (e) => { if (e.target === back) close(false); };
    $$('[data-r]', back).forEach((b) => (b.onclick = () => close(b.dataset.r === '1')));
    back.onkeydown = (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); };
    back.tabIndex = -1;
    if (!field) back.focus();
  });
}

// ---------- navigation ----------
function go(page) {
  if (page === currentPage) return;
  const prev = $(`.page[data-page="${currentPage}"]`);
  const next = $(`.page[data-page="${page}"]`);
  prev.classList.add('leaving');
  prev.classList.remove('active');
  setTimeout(() => prev.classList.remove('leaving'), 500);
  stagger(next);
  next.classList.add('active');
  currentPage = page;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  movePill();
  const crumb = $('#crumb');
  crumb.style.opacity = 0;
  const label = $(`#nav a[data-page="${page}"] span`).textContent;
  setTimeout(() => { crumb.textContent = label; crumb.style.opacity = 1; }, 150);
  // 3D / audio pages drop the ambient background so they stay smooth.
  const heavy = page === 'gun' || page === 'sound';
  document.body.classList.toggle('heavy', heavy);
  fxState.paused = heavy;
  api.call('discord:activity', 'In ' + label, 'Kt Mod Manager').catch(() => {});
  refreshPage(page);
}

function movePill() {
  const a = $('#nav a.active');
  $('.nav-pill').style.transform = `translateY(${a.offsetTop}px)`;
  $('.nav-pill').style.height = a.offsetHeight + 'px';
}

function refreshPage(page) {
  if (page === 'home') refreshHome();
  if (page === 'graphics') { refreshGraphics(); refreshStudio(); }
  if (page === 'world') refreshWorld();
  if (page === 'backups') refreshBackups();
  if (page === 'mods') refreshMods();
  if (page === 'presets') refreshPresets();
  if (page === 'cache') refreshCache();
  requestAnimationFrame(() => $$('.seg').forEach(syncSeg));
}

// ---------- citizen ----------
async function refreshInfo() {
  info = await api.call('citizen:info');
  const chip = $('#status-chip');
  chip.classList.toggle('ok', !!info.citizenPath);
  $('#status-sub').textContent = info.citizenPath ? 'Citizen linked' : 'No citizen linked';
  $('#status-sub').title = info.citizenPath || '';
  return info;
}

async function setCitizen(dir) {
  try {
    await notify.promise(api.call('citizen:set', dir), {
      loading: 'Linking citizen folder…',
      success: () => ({ title: 'Citizen folder linked', message: 'Everything you change is backed up first.' }),
      error: 'Could not use that folder',
    });
    await refreshInfo();
    refreshHome();
  } catch (e) { /* toast shown */ }
}

async function refreshHome() {
  await refreshInfo();
  const drop = $('#citizen-drop');
  drop.classList.toggle('ok', !!info.citizenPath);
  $('#citizen-title').textContent = info.citizenPath ? 'Citizen folder linked' : 'Drop your citizen folder';
  $('#citizen-path').innerHTML = info.citizenPath ? `<code>${esc(info.citizenPath)}</code>` : 'Drag <code>FiveM.app/citizen</code> here, or browse. Every change is backed up automatically.';
  countUp($('#st-files'), info.fileCount || 0);
  countUp($('#st-size'), (info.bytes || 0) / 1048576, (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' MB');
  countUp($('#st-backups'), info.backups || 0);
  countUp($('#st-tc'), info.timecycle || 0);
  $('#launch').disabled = !info.fiveMExe;
  $('#open-folder').disabled = !info.citizenPath;
  const hist = await api.call('citizen:history');
  $('#activity').innerHTML = hist.length
    ? hist.slice(0, 30).map((h) => `<li class="${h.type}"><span class="pip"></span><span>${esc(h.text)}</span><time>${ago(h.t)}</time></li>`).join('')
    : '<li class="empty">Nothing yet. Link your citizen folder to begin.</li>';
}

function initHome() {
  $('#browse-citizen').onclick = async () => { const d = await api.call('citizen:pick'); if (d) setCitizen(d); };
  $('#autodetect').onclick = async (e) => {
    busy(e.currentTarget, true);
    const d = await api.call('citizen:autodetect').catch(() => null);
    busy(e.currentTarget, false);
    if (d) setCitizen(d);
    else notify.warning('FiveM not found', 'No citizen folder at %LOCALAPPDATA%\\FiveM\\FiveM.app. Browse to it manually.');
  };
  $('#open-folder').onclick = () => api.call('citizen:open');
  $('#launch').onclick = async () => {
    try { await api.call('citizen:launch'); notify.success('Launching FiveM', 'See you in the city.'); }
    catch (e) { notify.error('Could not launch', e.message); }
  };
  $$('[data-goto]').forEach((b) => (b.onclick = () => go(b.dataset.goto)));
}

// ---------- graphics ----------
const PRESETS = [
  ['Pure', '#ffffff'], ['Arctic', '#8fd3ff'], ['Cyan', '#00e5ff'], ['Violet', '#9b5cff'], ['Rose', '#ff5fa8'],
  ['Blood', '#ff2d2d'], ['Sunset', '#ff8a3d'], ['Gold', '#ffd24d'], ['Toxic', '#7dff3a'], ['Teal', '#22e3b2'],
];

function gradeOpts() {
  const hex = $('#grade-color').value;
  return {
    hex,
    r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
    strength: $('#grade-strength').value / 100,
    brightness: $('#grade-bright').value / 100,
    groups: $$('#grade-groups .chip.on').map((c) => c.dataset.group),
  };
}

function paintPreview() {
  const o = gradeOpts();
  const p = $('#grade-preview');
  p.style.setProperty('--t', o.hex);
  p.style.setProperty('--s', o.strength);
  p.style.filter = `brightness(${1 + o.brightness * 0.5})`;
  $('#grade-hex').textContent = o.hex.toUpperCase();
  $('#strength-val').textContent = Math.round(o.strength * 100) + '%';
  $('#bright-val').textContent = (o.brightness > 0 ? '+' : '') + Math.round(o.brightness * 100);
  $$('#swatches .sw').forEach((s) => s.classList.toggle('on', s.dataset.hex === o.hex));
}

let tcScanItems = [];
let tcCurrentIndex = 0;

function updateTcMeta() {
  const sel = $('#tc-select');
  if (!sel) return;
  const val = sel.value;
  if (val === '__all__') {
    $('#tc-meta').textContent = tcScanItems.length + ' file(s) loaded. Changes apply globally across all timecycles.';
    $('#tc-activate-btn').style.display = 'none';
    return;
  }
  const item = tcScanItems.find((x) => x.rel === val);
  if (item) {
    const cycleStr = item.cycles.length ? item.cycles.join(', ') : 'Custom';
    $('#tc-meta').textContent = 'Cycle: ' + cycleStr + ' • ' + (item.isWeather ? 'Weather Timecycle' : 'Modifier');
    $('#tc-activate-btn').style.display = 'inline-flex';
    $('#tc-activate-btn').textContent = item.name === 'w_extrasunny.xml' ? 'Active in FiveM' : 'Set as FiveM Weather';
  }
}

async function refreshGraphics() {
  const [scan, colour] = await Promise.all([api.call('colour:scan'), api.call('colour:state')]);
  tcScanItems = scan.items || [];
  $('#grade-files').textContent = scan.files.length + ' timecycle file' + (scan.files.length === 1 ? '' : 's');

  const sel = $('#tc-select');
  if (sel) {
    const currentVal = sel.value || '__all__';
    let optsHtml = '<option value="__all__">All timecycle files (' + scan.files.length + ')</option>';
    for (const it of tcScanItems) {
      const label = it.name + (it.cycles.length ? ' [' + it.cycles[0] + ']' : '');
      optsHtml += '<option value="' + it.rel + '">' + esc(label) + '</option>';
    }
    sel.innerHTML = optsHtml;
    if (tcScanItems.some((x) => x.rel === currentVal)) sel.value = currentVal;
    else if (tcScanItems.length > 0) sel.value = tcScanItems[0].rel;
    updateTcMeta();
  }
  if (colour && !refreshGraphics.loaded) {
    $('#grade-color').value = colour.hex || '#ffffff';
    $('#grade-strength').value = Math.round(colour.strength * 100);
    $('#grade-bright').value = Math.round((colour.brightness || 0) * 100);
    $$('#grade-groups .chip').forEach((c) => c.classList.toggle('on', (colour.groups || []).includes(c.dataset.group)));
    $$('#pages input[type=range]').forEach(fillRange);
  }
  refreshGraphics.loaded = true;
  paintPreview();
  const tweaks = await api.call('tweaks:list');
  const packs = tweaks.filter((t) => t.kind === 'pack');
  $('#pack-list').innerHTML = packs.length
    ? packs.map((p) => `<li data-id="${p.id}"><span class="tag ${p.enabled ? 'solid' : ''}">${p.enabled ? 'Live' : 'Off'}</span><div class="grow"><b>${esc(p.name)}</b><small>${p.files.length} files</small></div>
        <button class="switch ${p.enabled ? 'on' : ''}" data-act="toggle"><i></i></button><button class="icon-btn" data-act="remove" title="Remove">${icon('trash')}</button></li>`).join('')
    : '<li class="empty">No packs yet. Drop one above.</li>';
  $$('#pack-list li[data-id]').forEach((li) => {
    const id = li.dataset.id;
    const p = packs.find((x) => x.id === id);
    $('[data-act=toggle]', li).onclick = () => toggleTweak(p, !p.enabled).then(refreshGraphics);
    $('[data-act=remove]', li).onclick = async () => {
      if (!(await modal({ title: 'Remove "' + p.name + '"?', text: 'Its files are taken out of citizen and your originals are restored.', confirm: 'Remove', danger: true }))) return;
      try { await api.call('tweaks:removeCustom', id); notify.success('Pack removed', p.name); refreshGraphics(); }
      catch (e) { notify.error('Could not remove pack', e.message); }
    };
  });
}

async function installPack(sources) {
  const guess = sources[0].split(/[\\/]/).pop().replace(/\.zip$/i, '');
  const name = await modal({ title: 'Install graphics pack', text: 'Give it a name. Files that it overwrites are backed up first.', confirm: 'Install', input: { label: 'Pack name', value: guess } });
  if (!name) return;
  try {
    const id = await notify.promise(api.call('tweaks:addCustom', name, sources, 'pack'), {
      loading: 'Importing ' + name + '…', success: 'Pack imported', error: 'Import failed',
    });
    const t = (await api.call('tweaks:list')).find((x) => x.id === id);
    await toggleTweak(t, true);
    refreshGraphics();
  } catch (e) { /* toast shown */ }
}

function initGraphics() {
  $('#swatches').innerHTML = PRESETS.map(([n, h]) => `<button class="sw" data-hex="${h}" data-tip="${n}" style="background:${h}"></button>`).join('');
  $$('#swatches .sw').forEach((s) => (s.onclick = () => { $('#grade-color').value = s.dataset.hex; paintPreview(); }));
  ['#grade-color', '#grade-strength', '#grade-bright'].forEach((s) => $(s).addEventListener('input', paintPreview));
  $$('#grade-groups .chip').forEach((c) => (c.onclick = () => { c.classList.toggle('on'); }));

  $('#tc-select')?.addEventListener('change', () => {
    const sel = $('#tc-select');
    const idx = tcScanItems.findIndex((x) => x.rel === sel.value);
    if (idx >= 0) tcCurrentIndex = idx;
    updateTcMeta();
  });

  $('#tc-prev')?.addEventListener('click', () => {
    if (!tcScanItems.length) return;
    tcCurrentIndex = (tcCurrentIndex - 1 + tcScanItems.length) % tcScanItems.length;
    $('#tc-select').value = tcScanItems[tcCurrentIndex].rel;
    updateTcMeta();
  });

  $('#tc-next')?.addEventListener('click', () => {
    if (!tcScanItems.length) return;
    tcCurrentIndex = (tcCurrentIndex + 1) % tcScanItems.length;
    $('#tc-select').value = tcScanItems[tcCurrentIndex].rel;
    updateTcMeta();
  });

  $('#tc-activate-btn')?.addEventListener('click', async () => {
    const sel = $('#tc-select')?.value;
    if (!sel || sel === '__all__') return notify.warning('Select a file', 'Pick a specific timecycle file first.');
    try {
      const r = await api.call('colour:activate', sel);
      notify.success('FiveM Weather Activated', `${r.source} is now linked to w_extrasunny & w_clear!`);
      refreshGraphics();
    } catch (e) {
      notify.error('Activation failed', e.message);
    }
  });

  $('#grade-apply').onclick = async (e) => {
    const btn = e.currentTarget;
    const o = gradeOpts();
    if (!o.groups.length) return notify.warning('Pick at least one group', 'Choose which parts of the timecycle to tint.');
    o.target = $('#tc-select')?.value || '__all__';
    o.activateWeather = true; // Automatically sync changes to FiveM in-game weather
    busy(btn, true);
    try {
      await notify.promise(api.call('colour:apply', o), {
        loading: 'Grading timecycle...',
        success: (r) => ({
          title: 'Colour grade applied',
          message: `${r.tags} colour values updated across ${r.files} file(s)` + (r.activated ? ' & active in FiveM weather!' : '. Restart FiveM to see it.')
        }),
        error: 'Grade failed',
      });
      refreshGraphics();
    } catch (err) { /* toast shown */ }
    busy(btn, false);
  };
  $('#grade-reset').onclick = async () => {
    try { const n = await api.call('colour:reset'); notify.success('Colour reset', n + ' file(s) back to their pack colours.'); }
    catch (e) { notify.error('Reset failed', e.message); }
  };
  $('#pack-drop').onclick = async () => {
    const dir = await api.call('pick:files', { directory: true, title: 'Select graphics pack folder' });
    if (dir) installPack(dir);
  };
}

// ---------- world ----------
async function toggleTweak(t, on) {
  try {
    const r = await api.call('tweaks:set', t.id, on);
    notify.success(t.name + ' ' + (on ? t.onLabel : t.offLabel).toLowerCase(), on ? `${t.files.length} file(s) written. Restart FiveM to apply.` : 'Stock files restored.');
    if (r.conflicts && r.conflicts.length) notify.warning('Overlapping files', r.conflicts.length + ' file(s) were also used by another tweak. Newest wins.');
    return true;
  } catch (e) {
    notify.error('Could not change ' + t.name, e.message);
    return false;
  }
}

const TWEAK_ICON = { water: 'droplet', mountains: 'mountain', trees: 'tree', bushes: 'leaf', props: 'cube' };

async function refreshWorld() {
  const tweaks = (await api.call('tweaks:list')).filter((t) => t.kind !== 'pack');
  const grid = $('#world-grid');
  grid.innerHTML = tweaks.map((t) => `
    <div class="card tweak ${t.enabled ? 'on' : ''}" data-id="${t.id}">
      <div class="tweak-top">
        <div class="tweak-icon"><div class="wave"></div>${icon(TWEAK_ICON[t.id] || 'layers')}</div>
        <div><span class="big-state">${t.enabled ? t.onLabel : t.offLabel}</span><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p></div>
      </div>
      <div class="files">${t.hasFiles ? esc(t.files.slice(0, 3).join('  ·  ')) + (t.files.length > 3 ? '  +' + (t.files.length - 3) : '') : 'No files loaded yet'}</div>
      <div class="state">
        <div class="seg">
          <button data-v="off" class="${t.enabled ? '' : 'on'}">${esc(t.offLabel)}</button>
          <button data-v="on" class="${t.enabled ? 'on' : ''}">${esc(t.onLabel)}</button>
          <i class="seg-thumb"></i>
        </div>
        <div class="head-actions">
          <button class="btn ghost sm" data-act="load">${icon('upload')}${t.customFiles ? 'Replace files' : t.id === 'water' ? 'Custom water.xml' : 'Load files'}</button>
          ${t.builtin ? '' : `<button class="icon-btn" data-act="remove" title="Remove">${icon('trash')}</button>`}
        </div>
      </div>
    </div>`).join('');
  stagger(grid);
  $$('.tweak', grid).forEach((card) => {
    const t = tweaks.find((x) => x.id === card.dataset.id);
    const seg = $('.seg', card);
    requestAnimationFrame(() => syncSeg(seg));
    $$('.seg button', card).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.v === 'on';
      if (on === t.enabled) return;
      $$('.seg button', card).forEach((x) => x.classList.toggle('on', x === b));
      syncSeg(seg);
      card.classList.toggle('on', on);
      const ok = await toggleTweak(t, on);
      setTimeout(refreshWorld, ok ? 450 : 0);
    }));
    $('[data-act=load]', card).onclick = async () => {
      const files = await api.call('pick:files', { title: 'Select files for ' + t.name, filters: [{ name: 'Mod files', extensions: ['*'] }] });
      if (files) loadTweakFiles(t, files);
    };
    const rm = $('[data-act=remove]', card);
    if (rm) rm.onclick = async () => {
      if (!(await modal({ title: 'Remove "' + t.name + '"?', text: 'Its files are removed from citizen and originals restored.', confirm: 'Remove', danger: true }))) return;
      await api.call('tweaks:removeCustom', t.id).catch((e) => notify.error('Remove failed', e.message));
      refreshWorld();
    };
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderColor = '#fff'; });
    card.addEventListener('dragleave', () => { card.style.borderColor = ''; });
    card.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      card.style.borderColor = '';
      hideVeil();
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f));
      if (paths.length) loadTweakFiles(t, paths);
    });
  });
}

async function loadTweakFiles(t, paths) {
  try {
    const n = await api.call('tweaks:import', t.id, paths);
    notify.success('Files loaded', `${n} file(s) ready for ${t.name}.${t.enabled ? ' Toggle it off and on to reapply.' : ''}`);
    refreshWorld();
  } catch (e) { notify.error('Could not load files', e.message); }
}

function initWorld() {
  $('#add-tweak').onclick = async () => {
    const name = await modal({ title: 'New custom tweak', text: 'Next, pick a folder laid out like citizen/ (or containing common/ / platform/).', confirm: 'Choose folder', input: { label: 'Tweak name', value: 'My tweak' } });
    if (!name) return;
    const dir = await api.call('pick:files', { directory: true, title: 'Select tweak folder' });
    if (!dir) return;
    try {
      await api.call('tweaks:addCustom', name, dir, 'tweak');
      notify.success('Tweak added', name + ' is ready to toggle.');
      refreshWorld();
    } catch (e) { notify.error('Could not add tweak', e.message); }
  };
}

// ---------- backups ----------
async function refreshBackups() {
  const list = await api.call('backups:list');
  $('#backup-list').innerHTML = list.length
    ? list.map((b) => `<li><span class="tag ${b.existed ? '' : 'solid'}">${b.existed ? 'Original' : 'New'}</span><code>${esc(b.rel)}</code><small>${esc(b.owner || '')}</small><time class="tag">${ago(b.at)}</time></li>`).join('')
    : '<li class="empty">No changes yet. Your citizen folder is stock.</li>';
}

function initBackups() {
  $('#restore-all').onclick = async () => {
    if (!(await modal({ title: 'Restore everything?', text: 'Every file Kt Mod Manager changed goes back to how it was, and every tweak and pack is switched off.', confirm: 'Restore', danger: true }))) return;
    try {
      const n = await notify.promise(api.call('backups:restoreAll'), { loading: 'Restoring…', success: (n) => ({ title: 'Back to stock', message: n + ' file(s) restored.' }), error: 'Restore failed' });
      refreshBackups();
      return n;
    } catch (e) { /* toast shown */ }
  };
}

// ---------- settings ----------
const prefs = { sound: true, reduceMotion: false, bg: true };
function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('kt.prefs') || '{}')); } catch (e) { /* ignore */ }
  applyPrefs();
}
function applyPrefs() {
  notifySettings.sound = prefs.sound;
  fxState.bg = prefs.bg;
  document.body.classList.toggle('reduce-motion', prefs.reduceMotion);
  $$('[data-setting]').forEach((s) => s.classList.toggle('on', !!prefs[s.dataset.setting]));
}
function initSettings() {
  $$('[data-setting]').forEach((s) => (s.onclick = () => {
    prefs[s.dataset.setting] = !prefs[s.dataset.setting];
    try { localStorage.setItem('kt.prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    applyPrefs();
  }));
  $('#test-notify').onclick = () => {
    notify.success('Pack installed', 'Night Pack is live in citizen.');
    setTimeout(() => notify.info('Heads up', 'Restart FiveM to load new files.'), 350);
    setTimeout(() => notify.warning('Overlapping files', '2 files were shared with another tweak.'), 700);
    setTimeout(() => notify.error('Export failed', 'The archive is NG-encrypted.'), 1050);
    setTimeout(() => {
      notify.promise(new Promise((r) => setTimeout(r, 2200)), { loading: 'Encoding textures…', success: 'Gun exported', error: 'Failed' });
    }, 1400);
    setTimeout(() => notify({ type: 'info', title: 'Undo available', message: 'Water removed.', action: { label: 'Undo', fn: () => notify.success('Undone') } }), 1750);
  };
}

// ---------- drag & drop ----------
let dragDepth = 0;
function hideVeil() { dragDepth = 0; $('#drag-veil').classList.remove('show'); $$('.over').forEach((x) => x.classList.remove('over')); }
function initDrop() {
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drag-veil').classList.add('show'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) hideVeil(); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    hideVeil();
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;

    // If the dropped folder is a FiveM citizen/app folder, link it regardless of active tab
    const base = paths[0].split(/[\\/]/).pop().toLowerCase();
    if (paths.length === 1 && (base === 'citizen' || base === 'fivem.app' || base === 'fivem')) {
      const res = await api.call('citizen:set', paths[0]).catch(() => null);
      if (res) {
        await refreshHome();
        return notify.success('Citizen folder linked', res.citizenPath);
      }
    }

    if (currentPage === 'home') setCitizen(paths[0]);
    else if (currentPage === 'graphics') { if (!(await studioDrop(paths))) installPack(paths); }
    else if (currentPage === 'gun') openGunFile(paths[0]);
    else if (currentPage === 'sound') handleSoundDrop(paths);
    else if (currentPage === 'mods') addModFiles(paths);
    else notify.info('Drop on a card', 'Drag files onto the tweak you want them for.');
  });
}

// ---------- boot ----------
function splash() {
  const root = $('#splash');
  if (!root) return Promise.resolve();
  const word = $('.splash-word');
  if (word) {
    word.innerHTML = [...(word.dataset.text || 'KT')].map((ch, i) => `<span style="animation-delay:${0.2 + i * 0.07}s">${ch}</span>`).join('');
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const current = $('#splash');
      if (current) current.classList.add('out');
      setTimeout(() => {
        $('#splash')?.remove();
        resolve();
      }, 900);
    }, 2100);
  });
}

function killSplash() {
  const el = $('#splash');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 900);
}

async function boot() {
  // Absolute fail-safe: never leave the user on the splash longer than 3.5s,
  // even if every other path throws or hangs.
  const hardKill = setTimeout(killSplash, 3500);

  const safe = (label, fn) => {
    try { fn(); } catch (err) { console.error('[boot] ' + label + ' failed:', err); }
  };

  safe('hydrateIcons', hydrateIcons);
  safe('loadPrefs', loadPrefs);
  safe('initBackground', initBackground);
  safe('initInteractions', initInteractions);
  safe('initDrawer', initDrawer);
  safe('initHome', initHome);
  safe('initGraphics', initGraphics);
  safe('initStudio', () => initStudio({ modal, go, refreshGraphics }));
  safe('initWorld', initWorld);
  safe('initBackups', initBackups);
  safe('initSettings', initSettings);
  safe('initDrop', initDrop);
  safe('initKeys', initKeys);
  safe('initPages', () => initPages({ modal, go }));
  safe('refreshProfile', () => { try { refreshProfile(); } catch (e) { console.error(e); } });
  safe('nav', () => {
    $$('#nav a').forEach((a) => (a.onclick = () => go(a.dataset.page)));
    $$('[data-win]').forEach((b) => (b.onclick = () => api.call('win:' + b.dataset.win)));
    addEventListener('resize', () => { movePill(); $$('.seg').forEach(syncSeg); });
    movePill();
    const active = $('.page.active');
    if (active) stagger(active);
  });

  // Heavy labs (three.js) in the background — never block splash.
  loadHeavyLabs().catch((err) => console.error('[boot] heavy labs:', err));

  const splashDone = splash().catch((err) => {
    console.error('[boot] Splash error:', err);
    killSplash();
  });

  try {
    await refreshHome();
  } catch (err) {
    console.error('[boot] Dashboard refresh failed:', err);
    try {
      notify.error('Dashboard could not fully load', err?.message || 'You can still use the other pages.');
    } catch (e) { /* notify not ready */ }
  }

  await splashDone;
  clearTimeout(hardKill);
  killSplash();

  if (!info.citizenPath) {
    const found = await api.call('citizen:autodetect').catch(() => null);
    if (found) {
      try {
        await setCitizen(found);
        notify.success('FiveM connected', 'Linked to ' + found);
      } catch (err) {
        notify({
          type: 'info',
          title: 'FiveM found',
          message: found,
          duration: 9000,
          action: { label: 'Use this folder', fn: () => setCitizen(found) },
        });
      }
    } else {
      notify({
        type: 'info',
        title: 'Welcome to Kt Mod Manager',
        message: 'Drop your citizen folder on the dashboard to get started.',
        duration: 9000,
      });
    }
  } else {
    notify.success('Welcome back', 'Citizen folder linked and protected.');
  }
}

boot().catch((err) => {
  console.error('[boot] fatal:', err);
  killSplash();
});
