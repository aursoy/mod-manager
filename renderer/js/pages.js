// Mods folder, cache cleaner, and the profile card / Discord link.
import { notify } from './notify.js';
import { icon } from './icons.js';
import { countUp, stagger, busy } from './fx.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (b) => { const m = b / 1048576; return m >= 1024 ? (m / 1024).toFixed(2) + ' GB' : (m < 10 ? m.toFixed(1) : Math.round(m)) + ' MB'; };
let modal = null;

// ---------- mods ----------
let mods = [];
export async function refreshMods() {
  try {
    const r = await api.call('mods:list');
    mods = r.mods;
  } catch (e) {
    mods = [];
    $('#mods-list').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    return;
  }
  countUp($('#mods-count'), mods.length);
  countUp($('#mods-on'), mods.filter((m) => m.enabled).length);
  countUp($('#mods-size'), mods.reduce((s, m) => s + m.bytes, 0), mb);
  renderMods();
}

function renderMods() {
  const q = $('#mods-search').value.trim().toLowerCase();
  const list = mods.filter((m) => !q || m.name.toLowerCase().includes(q));
  $('#mods-list').innerHTML = list.length
    ? list.map((m) => `<li class="${m.enabled ? 'on' : 'off'}" data-name="${esc(m.name)}">
        <span class="mod-ic">${icon('package')}</span>
        <div class="grow"><b>${esc(m.name)}</b><small>${mb(m.bytes)} · ${new Date(m.mtime).toLocaleDateString()}</small></div>
        <span class="tag ${m.enabled ? 'solid' : ''}">${m.enabled ? 'Loaded' : 'Disabled'}</span>
        <button class="switch ${m.enabled ? 'on' : ''}" data-act="toggle"><i></i></button>
        <button class="icon-btn" data-act="trash" title="Move to Recycle Bin">${icon('trash')}</button></li>`).join('')
    : `<li class="empty">${mods.length ? 'No mods match.' : 'No .rpf mods yet. Drop some here or click Add mods.'}</li>`;
  $$('#mods-list li[data-name]').forEach((li) => {
    const m = mods.find((x) => x.name === li.dataset.name);
    $('[data-act=toggle]', li).onclick = async () => {
      try {
        mods = await api.call('mods:set', m.name, !m.enabled);
        notify.success(m.name + (m.enabled ? ' disabled' : ' enabled'), m.enabled ? 'Renamed to .rpf.off. FiveM will skip it.' : 'FiveM will load it next launch.');
        refreshMods();
      } catch (e) { notify.error('Could not change mod', e.message); }
    };
    $('[data-act=trash]', li).onclick = async () => {
      if (!(await modal({ title: 'Remove ' + m.name + '?', text: 'It goes to the Recycle Bin, so you can still get it back.', confirm: 'Remove', danger: true }))) return;
      try { await api.call('mods:trash', m.file); notify.success('Mod removed', m.name + ' moved to the Recycle Bin.'); refreshMods(); }
      catch (e) { notify.error('Could not remove', e.message); }
    };
  });
}

export async function addModFiles(paths) {
  const rpfs = paths.filter((p) => /\.rpf$/i.test(p));
  if (!rpfs.length) return notify.info('Only .rpf files', 'Drop .rpf mods onto this page.');
  try {
    const r = await api.call('mods:add', rpfs);
    notify.success(r.added.length + ' mod(s) added', r.added.join(', '));
    refreshMods();
  } catch (e) { notify.error('Could not add mods', e.message); }
}

// ---------- cache ----------
let cache = [];
const selectedCache = new Set(['cache', 'server', 'serverpriv']);
export async function refreshCache() {
  if (!cache.length) {
    $('#cache-grid').innerHTML = Array.from({ length: 6 }, () => `<div class="card cache-item loading"><div class="row-between"><b>Scanning…</b><span class="check"></span></div><span class="size">— MB</span><div class="bar"><i class="scan"></i></div><p>Counting files</p></div>`).join('');
  }
  try { cache = await api.call('cache:info'); }
  catch (e) { $('#cache-grid').innerHTML = `<div class="card empty-card">${icon('broom')}<h3>${esc(e.message)}</h3></div>`; return; }
  const max = Math.max(1, ...cache.map((c) => c.bytes));
  $('#cache-grid').innerHTML = cache.map((c) => `<div class="card cache-item ${selectedCache.has(c.id) ? 'on' : ''}" data-id="${c.id}">
      <div class="row-between"><b>${esc(c.name)}</b><span class="check">${icon('check')}</span></div>
      <span class="size">${mb(c.bytes)}</span>
      <div class="bar"><i style="width:${(c.bytes / max) * 100}%"></i></div>
      <p>${esc(c.desc)} · ${c.files.toLocaleString()} files</p></div>`).join('');
  stagger($('#cache-grid'));
  $$('.cache-item').forEach((el) => (el.onclick = () => {
    const id = el.dataset.id;
    if (selectedCache.has(id)) selectedCache.delete(id); else selectedCache.add(id);
    el.classList.toggle('on', selectedCache.has(id));
    paintCacheTotal();
  }));
  paintCacheTotal();
}

function paintCacheTotal() {
  const total = cache.reduce((s, c) => s + c.bytes, 0) || 1;
  const sel = cache.filter((c) => selectedCache.has(c.id)).reduce((s, c) => s + c.bytes, 0);
  countUp($('#cache-total'), sel, mb);
  const k = sel / total;
  $('#cache-arc').style.strokeDashoffset = String(326.7 * (1 - k));
  $('#cache-pct').textContent = Math.round(k * 100) + '%';
}

async function cleanCache(btn) {
  const ids = [...selectedCache];
  if (!ids.length) return notify.info('Nothing selected', 'Tap the cache types you want to clean.');
  const size = cache.filter((c) => selectedCache.has(c.id)).reduce((s, c) => s + c.bytes, 0);
  if (!(await modal({ title: 'Clean ' + mb(size) + '?', text: 'Make sure FiveM is closed. The selected cache folders are emptied and rebuild on next launch.', confirm: 'Clean', danger: true }))) return;
  busy(btn, true);
  try {
    await notify.promise(api.call('cache:clear', ids), { loading: 'Cleaning cache…', success: (f) => ({ title: 'Cache cleaned', message: mb(f) + ' freed.' }), error: 'Clean failed' });
  } catch (e) { /* toast shown */ }
  busy(btn, false);
  refreshCache();
}

// ---------- profile ----------
let profile = null;
function initials(name) { return (name || 'KT').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(); }
function avatarOf(p) { return (p.discord && p.discord.avatar) || p.avatar || ''; }
function nameOf(p) { return p.name || (p.discord && p.discord.globalName) || ''; }

function paintAvatar(el, p) {
  const url = avatarOf(p);
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.toggle('img', !!url);
  const span = $('span', el);
  if (span) span.textContent = initials(nameOf(p));
}

export async function refreshProfile() {
  profile = await api.call('profile:get');
  paintAvatar($('#pf-avatar'), profile);
  $('#pf-name').textContent = nameOf(profile) || 'Set up profile';
  $('#pf-sub').textContent = profile.discord ? '@' + profile.discord.username : 'Discord not open';
  $('#pf-dot').classList.toggle('live', !!profile.discordLive);
}

async function openProfile() {
  await refreshProfile();
  const p = { ...profile };
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal profile">
    <div class="pm-banner"></div>
    <div class="pm-body">
      <div class="pm-row">
        <div class="pf-avatar pm-avatar" id="pm-avatar" title="Change avatar"><span></span></div>
        <button class="btn ghost sm" id="pm-avatar-clear">${icon('x')}Reset avatar</button>
      </div>
      <label class="field"><span>Display name</span><input type="text" id="pm-name" maxlength="32" placeholder="${esc((p.discord && p.discord.globalName) || 'Your name')}" value="${esc(p.name || '')}" /></label>
      <div class="pm-sec">
        <h4>${icon('discord')}Discord</h4>
        <div id="pm-discord"></div>
      </div>
      <div class="row-end"><button class="btn ghost" data-r="0">Close</button><button class="btn primary" data-r="1">${icon('check')}Save</button></div>
    </div></div>`;
  $('#modal-root').appendChild(back);
  const close = () => { back.classList.add('out'); setTimeout(() => back.remove(), 300); };

  const paint = () => {
    paintAvatar($('#pm-avatar', back), { ...p, name: $('#pm-name', back).value || p.name });
    const d = $('#pm-discord', back);
    d.innerHTML = p.discord
      ? `<div class="pm-user"><img src="${esc(p.discord.avatar)}" alt="" /><div><b>${esc(p.discord.globalName)}</b><small>@${esc(p.discord.username)}</small></div><button class="btn ghost sm" id="pm-unlink" style="margin-left:auto">${icon('x')}Unlink</button></div>`
      : p.discordBuiltIn
        ? `<div class="row-between"><small class="fine">Open Discord and it connects by itself.</small><button class="btn primary sm" id="pm-connect">${icon('link')}Connect now</button></div>`
        : `<label class="field"><span>Application ID</span><input type="text" id="pm-cid" placeholder="e.g. 1234567890123456789" value="${esc(p.discordClientId || '')}" /></label>
           <div class="row-between" style="margin-top:12px"><button class="link-btn" id="pm-dev">Get one</button><button class="btn primary sm" id="pm-connect">${icon('link')}Connect</button></div>`;
    const un = $('#pm-unlink', back);
    if (un) un.onclick = async () => { await api.call('discord:disconnect'); p.discord = null; paint(); refreshProfile(); };
    const con = $('#pm-connect', back);
    if (con) con.onclick = async () => {
      busy(con, true);
      try {
        const cid = $('#pm-cid', back) ? $('#pm-cid', back).value.trim() : '';
        p.discord = await api.call('discord:connect', cid);
        if (cid) p.discordClientId = cid;
        notify.success('Discord connected', 'Signed in as @' + p.discord.username);
        paint();
        refreshProfile();
      } catch (e) { notify.error('Discord connection failed', e.message); }
      busy(con, false);
    };
  };
  paint();
  $('#pm-name', back).addEventListener('input', paint);
  $('#pm-avatar', back).onclick = async () => {
    try { const url = await api.call('profile:pickAvatar'); if (url) { p.avatar = url; if (p.discord) notify.info('Custom avatar saved', 'Your Discord avatar shows while Discord is linked.'); paint(); } }
    catch (e) { notify.error('Avatar not set', e.message); }
  };
  $('#pm-avatar-clear', back).onclick = () => { p.avatar = ''; paint(); };
  back.addEventListener('click', (e) => { if (e.target.id === 'pm-dev') api.call('shell:external', 'https://discord.com/developers/applications'); });
  back.onclick = (e) => { if (e.target === back) close(); };
  $('[data-r="0"]', back).onclick = close;
  $('[data-r="1"]', back).onclick = async () => {
    await api.call('profile:set', { name: $('#pm-name', back).value.trim(), avatar: p.avatar || '' });
    await refreshProfile();
    notify.success('Profile saved', nameOf(profile) ? 'Looking good, ' + nameOf(profile) + '.' : '');
    close();
  };
}

export function initPages(ctx) {
  modal = ctx.modal;
  $('#mods-search').addEventListener('input', renderMods);
  $('#mods-add').onclick = async () => { const f = await api.call('pick:files', { title: 'Add .rpf mods', filters: [{ name: 'RPF', extensions: ['rpf'] }] }); if (f) addModFiles(f); };
  $('#mods-open').onclick = () => api.call('mods:open').catch((e) => notify.error('Cannot open', e.message));
  $('#cache-refresh').onclick = refreshCache;
  $('#cache-clean').onclick = (e) => cleanCache(e.currentTarget);
  $('#profile-card').onclick = openProfile;
  if (api.onProfile) api.onProfile(() => refreshProfile().catch(() => {}));
}
