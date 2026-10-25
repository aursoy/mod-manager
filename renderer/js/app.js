import { hydrateIcons, icon } from './icons.js';
import { notify, initDrawer, settings as notifySettings, navSound } from './notify.js';
import { initBackground, initInteractions, initTilt, syncSeg, countUp, stagger, busy, fillRange, fxState } from './fx.js';
import { initKeys } from './keys.js';
import { initStudio, refreshStudio, handleDrop as studioDrop } from './tcstudio.js';
import { initLook, setBackgroundFile } from './look.js';
import { startTour, tourSeen } from './tour.js';
import { initDropdowns } from './dropdown.js';
import { refreshWorld, initWorldPage } from './world.js';
import { initMaker, refreshMaker } from './maker.js';

import { initPages, refreshMods, refreshCache, refreshProfile, addModFiles } from './pages.js';

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
  navSound();
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
  fxState.kick && fxState.kick();
  api.call('discord:activity', 'In ' + label, 'Kt Mod Manager').catch(() => {});
  refreshPage(page);
}

function movePill() {
  const a = $('#nav a.active');
  $('.nav-pill').style.transform = `translateY(${a.offsetTop}px)`;
  $('.nav-pill').style.height = a.offsetHeight + 'px';
  // the new page's icon gives a little hop
  a.classList.remove('pop');
  void a.offsetWidth;
  a.classList.add('pop');
}

// Menu motion: items slide in at start, and a soft highlight glides to whatever you hover.
function initNavMotion() {
  const nav = $('#nav');
  [...nav.children].filter((el) => el.matches('a, .nav-sec')).forEach((el, i) => el.style.setProperty('--n', i));
  nav.classList.add('intro');
  setTimeout(() => nav.classList.remove('intro'), 1400);
  const hover = $('.nav-hover');
  $$('#nav a').forEach((a) => a.addEventListener('pointerenter', () => {
    hover.style.transform = `translateY(${a.offsetTop}px)`;
    hover.style.height = a.offsetHeight + 'px';
    hover.classList.toggle('on', !a.classList.contains('active'));
  }));
  nav.addEventListener('pointerleave', () => hover.classList.remove('on'));
  nav.addEventListener('click', () => hover.classList.remove('on'));
}

function refreshPage(page) {
  // placeholders in lists that have never been filled, so a page never opens blank
  $$(`.page[data-page="${page}"] ul.list`).forEach((ul) => { if (!ul.children.length) ul.innerHTML = '<li class="skel"></li>'.repeat(3); });
  if (page === 'home') refreshHome();
  if (page === 'graphics') refreshStudio();
  if (page === 'world') refreshWorld();
  if (page === 'maker') refreshMaker();
  if (page === 'backups') refreshBackups();
  if (page === 'mods') { refreshMods(); refreshPacks(); }
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

// ---------- graphics packs (listed on the Mods page) ----------
async function refreshPacks() {
  const tweaks = await api.call('tweaks:list').catch(() => []);
  const packs = tweaks.filter((t) => t.kind === 'pack');
  $('#pack-list').innerHTML = packs.length
    ? packs.map((p) => `<li data-id="${p.id}"><span class="mod-ic">${icon('palette')}</span><div class="grow"><b>${esc(p.name)}</b><small>${p.files.length} file${p.files.length === 1 ? '' : 's'}</small></div>
        <span class="tag ${p.enabled ? 'solid' : ''}">${p.enabled ? 'On' : 'Off'}</span>
        <button class="switch ${p.enabled ? 'on' : ''}" data-act="toggle"><i></i></button><button class="icon-btn" data-act="remove" title="Delete pack">${icon('trash')}</button></li>`).join('')
    : '<li class="empty">No graphics packs yet.</li>';
  $$('#pack-list li[data-id]').forEach((li) => {
    const id = li.dataset.id;
    const p = packs.find((x) => x.id === id);
    $('[data-act=toggle]', li).onclick = () => toggleTweak(p, !p.enabled).then(refreshPacks);
    $('[data-act=remove]', li).onclick = async () => {
      if (!(await modal({ title: 'Delete "' + p.name + '"?', text: 'Its files come out of your game.', confirm: 'Delete', danger: true }))) return;
      try { await api.call('tweaks:removeCustom', id); notify.success('Pack deleted', p.name); refreshPacks(); }
      catch (e) { notify.error('Could not delete pack', e.message); }
    };
  });
}

async function installPack(sources) {
  const guess = sources[0].split(/[\\/]/).pop().replace(/\.zip$/i, '');
  const name = await modal({ title: 'Add graphics pack', confirm: 'Add pack', input: { label: 'Pack name', value: guess } });
  if (!name) return;
  try {
    const id = await notify.promise(api.call('tweaks:addCustom', name, sources, 'pack'), {
      loading: 'Adding ' + name + '…', success: 'Pack added', error: 'Could not add pack',
    });
    const t = (await api.call('tweaks:list')).find((x) => x.id === id);
    await toggleTweak(t, true);
    refreshPacks();
  } catch (e) { /* toast shown */ }
}

function initPacks() {
  $('#pack-add').onclick = async () => {
    const dir = await api.call('pick:files', { directory: true, title: 'Select a graphics pack folder' });
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

async function loadTweakFiles(t, paths) {
  try {
    const n = await api.call('tweaks:import', t.id, paths);
    notify.success('Files loaded', `${n} file(s) ready for ${t.name}.${t.enabled ? ' Toggle it off and on to reapply.' : ''}`);
    refreshWorld();
  } catch (e) { notify.error('Could not load files', e.message); }
}

function initWorld() {
  initWorldPage({ toggleTweak, modal, loadTweakFiles });
  initMaker({ go });
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
const prefs = { sound: true, reduceMotion: false, bg: true, tilt: true };
function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('kt.prefs') || '{}')); } catch (e) { /* ignore */ }
  applyPrefs();
}
function applyPrefs() {
  notifySettings.sound = prefs.sound;
  fxState.bg = prefs.bg;
  fxState.kick && fxState.kick();
  document.body.classList.toggle('reduce-motion', prefs.reduceMotion);
  document.body.classList.toggle('tilt', !!prefs.tilt);
  requestAnimationFrame(() => { movePill(); $$('.seg').forEach(syncSeg); });
  $$('[data-setting]').forEach((s) => s.classList.toggle('on', !!prefs[s.dataset.setting]));
}
async function refreshAiLink() {
  const c = await api.call('ai:config').catch(() => null);
  if (!c) return;
  $('#ai-url').value = c.url;
  if (c.url) $('#ai-url-wrap').classList.remove('hidden');
  $('#ai-key').placeholder = c.hasKey ? '•••••••• saved (paste to replace)' : 'Paste your API key';
  const sel = $('#ai-model');
  if (c.model && ![...sel.options].some((o) => o.value === c.model)) sel.add(new Option(c.model, c.model));
  sel.value = c.model || '';
  $('#ai-state').textContent = c.on ? 'On for Graphics AI and Mod Maker' + (c.provider ? ' · ' + c.provider : '') + (c.model ? ' · ' + c.model : '') : 'Powers Graphics AI and Mod Maker. Paste an API key from any AI, or an AI router like OmniRoute.';
  $('#ai-tag').textContent = c.on ? 'On' : 'Off';
  $('#ai-tag').classList.toggle('solid', c.on);
}

async function fillAiModels() {
  const sel = $('#ai-model');
  const keep = sel.value;
  const list = await api.call('ai:models');
  sel.innerHTML = '<option value="">Auto</option>' + list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.value = list.includes(keep) ? keep : '';
  sel.dispatchEvent(new Event('kt:refresh'));
}

function initSettings() {
  $('#tour-replay').onclick = () => startTour({ go });
  refreshAiLink().then(() => api.call('ai:config')).then((c) => { if (c && c.on) fillAiModels().then(refreshAiLink).catch(() => {}); }).catch(() => {});
  $('#ai-more').onclick = () => { $('#ai-url-wrap').classList.toggle('hidden'); if (!$('#ai-url-wrap').classList.contains('hidden')) $('#ai-url').focus(); };
  $('#ai-model').addEventListener('change', () => api.call('ai:setConfig', { model: $('#ai-model').value }).then(refreshAiLink).catch(() => {}));
  $('#ai-save').onclick = async (e) => {
    const btn = e.currentTarget;
    busy(btn, true);
    try {
      const key = $('#ai-key').value.trim();
      await api.call('ai:setConfig', { url: $('#ai-url').value, model: $('#ai-model').value, ...(key ? { key } : {}) });
      $('#ai-key').value = '';
      await fillAiModels();
      const reply = await api.call('ai:test');
      await refreshAiLink();
      notify.success('AI is on', reply);
    } catch (err) { notify.error('AI not working', err.message); refreshAiLink(); }
    busy(btn, false);
  };
  $('#ai-off').onclick = async () => {
    await api.call('ai:setConfig', { url: '', key: '', model: '' }).catch(() => {});
    $('#ai-model').innerHTML = '<option value="">Auto</option>';
    refreshAiLink();
    notify.info('AI off', 'The AI chat works offline again.');
  };
  $$('[data-setting]').forEach((s) => (s.onclick = () => {
    prefs[s.dataset.setting] = !prefs[s.dataset.setting];
    try { localStorage.setItem('kt.prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    applyPrefs();
  }));

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
    else if (currentPage === 'mods') { if (paths.some((p) => /\.rpf$/i.test(p))) addModFiles(paths); else installPack(paths); }
    else if (currentPage === 'settings' && /\.(png|jpe?g|webp|gif|bmp|mp4|webm)$/i.test(paths[0])) setBackgroundFile(paths[0]);
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
  safe('initPacks', initPacks);
  safe('initStudio', () => initStudio({ modal, go }));
  safe('initWorld', initWorld);
  safe('initBackups', initBackups);
  safe('initSettings', initSettings);
  safe('initLook', initLook);
  safe('initDrop', initDrop);
  safe('initKeys', initKeys);
  safe('initPages', () => initPages({ modal, go }));
  safe('refreshProfile', () => { try { refreshProfile(); } catch (e) { console.error(e); } });
  safe('dropdowns', () => initDropdowns());
  safe('tilt', initTilt);
  safe('navMotion', initNavMotion);
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
  if (!tourSeen()) setTimeout(() => startTour({ go }), 900);

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
