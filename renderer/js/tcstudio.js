// Graphics page: the Pack AI (a request, a picture and/or a pack folder become a
// graphics pack) and the advanced timecycle editor (live preview, every value editable).

import { notify } from './notify.js';
import { icon } from './icons.js';
import { busy, syncSeg, fillRange } from './fx.js';
import * as TC from './timecycle.js';
import * as AI from './gfxai.js';
import { drawScene } from './scene3d.js';
import { encode as encodeTex, decode as decodeTex } from './dxt.js';
import { cleanError } from './keys.js';
import { createLab } from './cloudlab.js';

const graphicsOn = () => document.querySelector('.page[data-page="graphics"]').classList.contains('active');
const NO_PACK = 'Link your citizen folder on the Dashboard first.';
const cloudLab = createLab({
  P: 'cl', kind: 'clouds', mount: '#lab-clouds', icon: 'cloud', active: () => pane === 'clouds' && graphicsOn(),
  texts: { what: 'clouds', from: 'Clouds from', list: 'Cloud hats', emptyTitle: 'Looking for your clouds…', emptyText: 'Checking your pack, your mods folder, citizen and GTA V.', none: NO_PACK },
});
const bloodLab = createLab({
  P: 'bl', kind: 'blood', mode: 'files', mount: '#lab-blood', icon: 'droplet', active: () => pane === 'blood' && graphicsOn(),
  texts: { what: 'blood textures', from: 'Blood FX RPF', open: 'Choose blood FX RPF', list: 'Blood textures', emptyTitle: 'Choose your blood FX RPF', emptyText: 'Press "Choose blood FX RPF" and pick the .rpf your blood FX is in (for example from FiveM.app/mods). Paint it here, then Install puts it into your mods folder.', none: NO_PACK },
});

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const frame = () => new Promise((r) => requestAnimationFrame(r));

let ctx = { modal: null, go: null };
let pane = 'ai';

// =====================================================================
// Timecycle editor
// =====================================================================

const ed = {
  rel: null, name: '', model: null, sectionId: null, hour: 12, group: 'all', query: '', open: null,
  items: [], playing: null, drawQueued: false, external: null, aiDraft: null,
  src: 'game', pack: null, // which pack the File list comes from (your game, an installed pack, or one on disk)
  skyPic: null, skyToken: null, // the sky picture (skydome.ytd) the preview draws, from the pack or your game
};
const GRADE_GROUPS = ['sky', 'sun', 'cloud', 'light', 'ambient', 'fog'];

const section = () => ed.model && ed.model.sections.find((s) => s.id === ed.sectionId);
const usable = () => (ed.model ? ed.model.sections.filter((s) => s.params.length) : []);
const hexOf = (rgb) => TC.rgbToHex(rgb);
const nice = (w) => TC.WEATHER_NAMES[w.toUpperCase()] || w.charAt(0) + w.slice(1).toLowerCase();

function queueDraw() {
  if (ed.drawQueued) return;
  ed.drawQueued = true;
  requestAnimationFrame(() => {
    ed.drawQueued = false;
    const sec = section();
    if (sec && pane === 'editor') { drawScene($('#tce-canvas'), sec, ed.hour, skyOpts()); skyHint(); }
  });
}

// ---------- the sky picture ----------
// GTA draws skydome.ytd on top of the sky colours, scaled by "Stars brightness". In the
// stock game that is the starfield at night; picture-sky packs put a whole sky in it,
// set the sky colours to black and turn the stars up, so the colours read black here
// while the game shows the picture. The preview draws it the same way.

const skyOpts = () => (ed.skyPic && ed.skyPic.canvas ? { image: ed.skyPic.canvas, additive: true } : null);

function skyCanvas(t) {
  try {
    const px = decodeTex(t.format, new Uint8Array(t.data), t.width, t.height);
    for (let k = 3; k < px.length; k += 4) px[k] = 255;
    const c = document.createElement('canvas');
    c.width = t.width; c.height = t.height;
    c.getContext('2d').putImageData(new ImageData(px, t.width, t.height), 0, 0);
    return c;
  } catch (e) { return null; }
}

async function loadSkyPicture() {
  const key = ed.pack ? 'pack:' + ed.pack.name : 'game';
  if (ed.skyPic && ed.skyPic.key === key && Date.now() - ed.skyPic.at < 60000) return;
  const token = (ed.skyToken = {});
  let r = null;
  try {
    r = await api.call('sky:picture', ed.pack ? 'pack' : 'game');
    // a pack without its own sky uses the one your game has
    if (!r && ed.pack) r = await api.call('sky:picture', 'game');
  } catch (e) { r = null; }
  if (ed.skyToken !== token) return;
  ed.skyPic = { key, at: Date.now(), canvas: r ? skyCanvas(r) : null, label: r ? r.label : '' };
  queueDraw();
}

function skyHint() {
  const el = $('#tce-skyhint');
  const sec = section();
  const stars = sec && sec.scalars.find((p) => /stars_iten/.test(p.name));
  const on = !!(sec && ed.skyPic && ed.skyPic.canvas && stars && TC.sample(stars.values, ed.hour) > 0.05);
  const c = on ? TC.sceneColours(sec, ed.hour) : null;
  const dark = c && Math.max(...c.zenith, ...c.horizon) < 0.08;
  el.classList.toggle('hidden', !dark);
  if (dark) el.innerHTML = `<b>Sky is a picture</b><span>This pack paints its sky with <code>skydome.ytd</code>${ed.skyPic.label ? ' (' + esc(ed.skyPic.label) + ')' : ''}, so its sky colours are black on purpose. Its brightness is <i>Stars brightness</i>.</span>`;
}

function setDirtyTag() {
  // a colour counts once, not once per r/g/b
  const n = ed.model ? ed.model.sections.reduce((sum, sec) => sum
    + sec.colours.filter((c) => [c.r, c.g, c.b].some((p) => p.values.some((v, i) => v !== p.orig[i]))).length
    + sec.scalars.filter((p) => p.values.some((v, i) => v !== p.orig[i])).length, 0) : 0;
  const tag = $('#tce-dirty');
  tag.textContent = n ? n + ' setting' + (n === 1 ? '' : 's') + ' changed' : 'No changes';
  tag.classList.toggle('solid', n > 0);
  $('#tce-save-hint').textContent = n ? 'Not saved' : '';
  const inPack = ed.rel && ed.rel.startsWith('pk:');
  $('#tce-save').innerHTML = icon('save') + (inPack ? 'Save to pack' : 'Save to game');
  for (const id of ['tce-export', 'tce-pack', 'tce-save']) $('#' + id).disabled = !ed.model;
  $('#tce-revert').disabled = !n;
  // FiveM only reads w_*.xml weather files; offer to hook up anything else.
  const citizenFile = ed.model && ed.rel && !ed.rel.startsWith('__');
  $('#tce-weather').classList.toggle('hidden', !(citizenFile && !/^w_/i.test(ed.name)));
}

async function populateSources() {
  const packs = await api.call('editor:packs').catch(() => []);
  const sel = $('#tce-src');
  let html = '<option value="game">Your game</option>' + packs.map((p) => `<option value="pack:${esc(p.id)}">${esc(p.name)}${p.enabled ? '' : ' (off)'}</option>`).join('');
  if (ed.src === 'file' && ed.pack) html += `<option value="file">${esc(ed.pack.name)}</option>`;
  html += '<option value="__open__">Open a pack…</option>';
  sel.innerHTML = html;
  sel.value = [...sel.options].some((o) => o.value === ed.src) ? ed.src : 'game';
}

async function chooseSource(value) {
  const sel = $('#tce-src');
  if (ed.model && TC.isDirty(ed.model) && !(await ctx.modal({ title: 'Throw away your changes?', text: 'You changed ' + ed.name + ' but did not save it.', confirm: 'Throw away', danger: true }))) { sel.value = ed.src; return; }
  try {
    if (value === 'game') { ed.src = 'game'; ed.pack = null; }
    else {
      const r = await api.call('editor:openPack', value === '__open__' ? {} : { id: value.slice(5) });
      if (!r) { sel.value = ed.src; return; }
      ed.src = value === '__open__' ? 'file' : value;
      ed.pack = r;
    }
  } catch (e) { notify.error('Could not open pack', e.message); sel.value = ed.src; return; }
  await populateSources();
  const items = await populateFiles();
  const first = ed.pack ? (ed.pack.files.find((f) => /extrasunny/i.test(f.name)) || ed.pack.files[0]) : (items.find((i) => /extrasunny/i.test(i.name)) || items[0]);
  if (first) { const rel = ed.pack ? 'pk:' + first.rel : first.rel; $('#tce-file').value = rel; await openRel(rel, { force: true }); }
  else { ed.model = null; paintEditor(); }
  loadSkyPicture();
}

async function populateFiles(selectRel) {
  const sel = $('#tce-file');
  if (ed.pack) {
    sel.innerHTML = ed.pack.files.map((f) => `<option value="pk:${esc(f.rel)}">${esc(f.name)}</option>`).join('');
    const want = selectRel || ed.rel;
    if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
    return ed.pack.files;
  }
  let items = [];
  try { items = (await api.call('colour:scan')).items || []; } catch (e) { /* citizen not linked */ }
  ed.items = items;
  let html = items.length ? '' : '<option value="">No timecycle files in your game yet</option>';
  html += items.map((it) => `<option value="${esc(it.rel)}">${esc(it.name)}</option>`).join('');
  if (ed.external) html += `<option value="__ext__">${esc(ed.external.name)} (from your computer)</option>`;
  if (ed.aiDraft) html += `<option value="__ai__">${esc(ed.aiDraft.name)} (AI version, not saved)</option>`;
  sel.innerHTML = html;
  const want = selectRel || ed.rel;
  if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  return items;
}

async function openRel(rel, { force = false } = {}) {
  if (!force && ed.model && TC.isDirty(ed.model)) {
    const ok = await ctx.modal({ title: 'Throw away your changes?', text: 'You changed ' + ed.name + ' but did not save it.', confirm: 'Throw away', danger: true });
    if (!ok) { $('#tce-file').value = ed.rel || ''; return; }
  }
  try {
    if (rel === '__ext__') {
      ed.rel = '__ext__'; ed.name = ed.external.name;
      ed.model = TC.parse(ed.external.xml);
    } else if (rel === '__ai__') {
      ed.rel = '__ai__'; ed.name = ed.aiDraft.name;
      ed.model = TC.parse(ed.aiDraft.xml);
    } else if (rel.startsWith('pk:')) {
      const xml = await api.call('editor:readPack', rel.slice(3));
      ed.rel = rel; ed.name = rel.split('/').pop();
      ed.model = TC.parse(xml);
    } else {
      const xml = await api.call('timecycle:read', rel);
      ed.rel = rel; ed.name = rel.split('/').pop();
      ed.model = TC.parse(xml);
    }
  } catch (e) { notify.error('Could not open timecycle', e.message); return; }
  if (!ed.model.params.length) notify.warning('Nothing to edit', ed.name + ' has no timecycle values in it.');
  pickDefaultSection();
  ed.group = 'all'; ed.query = ''; ed.open = null; $('#tce-search').value = '';
  paintEditor();
}

function pickDefaultSection() {
  const secs = usable();
  const s = secs.find((x) => /extrasunny|clear/i.test(x.label) && /global/i.test(x.label)) || secs.find((x) => /extrasunny|clear/i.test(x.label)) || secs[0];
  ed.sectionId = s ? s.id : null;
}

function paintEditor() {
  const has = !!(ed.model && section());
  $('#tce-empty').classList.toggle('hidden', has);
  $('#tce-canvas').classList.toggle('hidden', !has);
  // weather + area pickers
  const secs = usable();
  const weathers = [...new Set(secs.map((x) => TC.splitSection(x.label).weather))];
  const cur = section() ? TC.splitSection(section().label) : { weather: null, area: null };
  $('#tce-cycle').innerHTML = weathers.map((w) => `<option value="${esc(w)}">${esc(nice(w))}</option>`).join('');
  if (cur.weather) $('#tce-cycle').value = cur.weather;
  $('#tce-cycle').disabled = weathers.length < 2;
  const areas = secs.filter((x) => TC.splitSection(x.label).weather === cur.weather);
  $('#tce-area-wrap').classList.toggle('hidden', areas.length < 2);
  $('#tce-area').innerHTML = areas.map((x) => {
    const a = TC.splitSection(x.label).area || 'All';
    return `<button data-id="${esc(x.id)}" class="${x.id === ed.sectionId ? 'on' : ''}">${esc(TC.AREA_NAMES[a.toUpperCase()] || a)}</button>`;
  }).join('') + '<i class="seg-thumb"></i>';
  $$('#tce-area button').forEach((b) => (b.onclick = () => { ed.sectionId = b.dataset.id; ed.open = null; paintEditor(); }));
  requestAnimationFrame(() => syncSeg($('#tce-area')));
  renderGroups();
  renderTicks();
  renderSettings();
  setDirtyTag();
  queueDraw();
}

function renderGroups() {
  const sec = section();
  if (!sec) { $('#tce-groups').innerHTML = ''; return; }
  const count = (g) => sec.colours.filter((c) => g === 'all' || c.group === g).length + sec.scalars.filter((p) => g === 'all' || p.group === g).length;
  const chips = [['all', 'All']].concat(TC.GROUPS.map((g) => [g.id, g.label])).map(([id, label]) => [id, label, count(id)]).filter((c) => c[2] > 0);
  $('#tce-groups').innerHTML = chips.map(([id, label, n]) => `<button class="chip ${ed.group === id ? 'on' : ''}" data-g="${id}">${esc(label)} <small>${n}</small></button>`).join('');
  $$('#tce-groups .chip').forEach((c) => (c.onclick = () => { ed.group = c.dataset.g; renderGroups(); renderSettings(); }));
}

function keyCount() {
  const sec = section();
  if (!sec || !sec.params.length) return 0;
  const tally = {};
  for (const p of sec.params) tally[p.values.length] = (tally[p.values.length] || 0) + 1;
  return +Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

function renderTicks() {
  const n = keyCount();
  const box = $('#tce-ticks');
  if (n < 2) { box.innerHTML = ''; return; }
  const near = TC.nearestKey(n, ed.hour);
  box.innerHTML = TC.keyHours(n).map((h, i) => `<button data-h="${h}" style="left:${(h / 24) * 100}%" class="${i === near ? 'on' : ''}" title="Jump to ${TC.hourLabel(h)}"></button>`).join('');
  $$('button', box).forEach((b) => (b.onclick = () => { stopPlay(); setHour(+b.dataset.h); }));
}

// Settings are keyed by position ("c3" = 4th colour), never by name, so two
// settings that share a tag name can never edit each other.
function entries() {
  const sec = section();
  if (!sec) return [];
  const q = ed.query.trim().toLowerCase();
  const ok = (name, group) => (ed.group === 'all' || ed.group === group) && (!q || name.toLowerCase().includes(q) || TC.labelOf(name).toLowerCase().includes(q));
  return [
    ...sec.colours.map((c, i) => ({ key: 'c' + i, col: c, name: c.name, group: c.group })),
    ...sec.scalars.map((p, i) => ({ key: 's' + i, par: p, name: p.name, group: p.group })),
  ].filter((e) => ok(e.name, e.group));
}

const isDirtyEntry = (e) => (e.col ? [e.col.r, e.col.g, e.col.b] : [e.par]).some((p) => p.values.some((v, i) => v !== p.orig[i]));

function headHtml(e) {
  const n = e.col ? e.col.r.values.length : e.par.values.length;
  const k = TC.nearestKey(n, ed.hour);
  const lead = e.col ? `<span class="set-sw" style="background:${hexOf(TC.colourAt(e.col, k))}"></span>` : `<span class="set-num">${esc(TC.fmt(e.par.values[k]))}</span>`;
  return `${lead}<span class="set-txt"><b>${esc(TC.labelOf(e.name))}</b><small>${esc(e.name)}</small></span>${icon('chevron-right')}`;
}

function bodyHtml(e) {
  const n = e.col ? e.col.r.values.length : e.par.values.length;
  const hrs = TC.keyHours(n);
  const k = TC.nearestKey(n, ed.hour);
  const boxes = hrs.map((h, i) => `<label class="tm ${i === k ? 'on' : ''}" data-i="${i}">
      ${e.col ? `<input type="color" value="${hexOf(TC.colourAt(e.col, i))}" />` : `<input type="number" step="any" value="${esc(TC.fmt(e.par.values[i]))}" />`}
      <small>${n === 1 ? 'All day' : TC.hourLabel(h)}</small></label>`).join('');
  const what = e.col ? 'colour' : 'value';
  return `<div class="set-body">
    <div class="set-times">${boxes}</div>
    <div class="set-actions">
      ${n > 1 ? `<button class="btn ghost sm" data-act="all">${icon('copy')}Use the ${TC.hourLabel(hrs[k])} ${what} all day</button>` : ''}
      <button class="btn ghost sm" data-act="reset" ${isDirtyEntry(e) ? '' : 'disabled'}>${icon('undo')}Undo this</button>
    </div></div>`;
}

function renderSettings() {
  const list = $('#tce-list');
  const items = entries();
  if (!section()) { list.innerHTML = ''; return; }
  list.innerHTML = items.length
    ? items.map((e) => `<li class="set ${ed.open === e.key ? 'open' : ''} ${isDirtyEntry(e) ? 'dirty' : ''}" data-key="${e.key}"><button class="set-head">${headHtml(e)}</button>${ed.open === e.key ? bodyHtml(e) : ''}</li>`).join('')
    : '<li class="empty">No settings match.</li>';
  for (const li of $$('li.set', list)) bindSetting(li, items.find((e) => e.key === li.dataset.key));
}

function refreshSetting(e) {
  const li = $(`#tce-list li[data-key="${e.key}"]`);
  if (!li) return;
  $('.set-head', li).innerHTML = headHtml(e);
  li.classList.toggle('dirty', isDirtyEntry(e));
  const reset = $('[data-act=reset]', li);
  if (reset) reset.disabled = !isDirtyEntry(e);
}

function bindSetting(li, e) {
  $('.set-head', li).onclick = () => { ed.open = ed.open === e.key ? null : e.key; renderSettings(); };
  if (ed.open !== e.key) return;
  const n = e.col ? e.col.r.values.length : e.par.values.length;
  $$('.tm', li).forEach((box) => {
    const i = +box.dataset.i;
    const input = $('input', box);
    // Picking a box jumps the preview to that time.
    box.addEventListener('pointerdown', () => { if (n > 1) { stopPlay(); setHour(TC.keyHours(n)[i], { keepOpen: true }); } });
    input.addEventListener('input', () => {
      if (e.col) TC.setColour(e.col, i, TC.hexToRgb(input.value));
      else { const v = parseFloat(input.value); if (!Number.isFinite(v)) return; e.par.values[i] = v; }
      refreshSetting(e); setDirtyTag(); queueDraw();
    });
  });
  const all = $('[data-act=all]', li);
  if (all) all.onclick = () => {
    const k = TC.nearestKey(n, ed.hour);
    if (e.col) TC.setColourAll(e.col, TC.colourAt(e.col, k));
    else e.par.values = e.par.values.map(() => e.par.values[k]);
    renderSettings(); setDirtyTag(); queueDraw();
  };
  $('[data-act=reset]', li).onclick = () => {
    for (const p of e.col ? [e.col.r, e.col.g, e.col.b] : [e.par]) p.values = p.orig.slice();
    renderSettings(); setDirtyTag(); queueDraw();
  };
}

function setHour(h, { keepOpen = false } = {}) {
  ed.hour = ((h % 24) + 24) % 24;
  $('#tce-hour').value = ed.hour; fillRange($('#tce-hour'));
  $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
  $('#tce-tag').textContent = TC.hourLabel(ed.hour);
  renderTicks();
  if (keepOpen) {
    // only move the highlight; re-rendering would close the colour picker
    for (const e of entries()) refreshSetting(e);
    const n = keyCount();
    $$('#tce-list .set.open .tm').forEach((b) => b.classList.toggle('on', +b.dataset.i === TC.nearestKey(n, ed.hour)));
  } else renderSettings();
  queueDraw();
}

function stopPlay() {
  if (ed.playing) { cancelAnimationFrame(ed.playing.raf); ed.playing = null; }
  $('#tce-play').innerHTML = icon('play');
}

function togglePlay() {
  if (ed.playing) return stopPlay();
  $('#tce-play').innerHTML = icon('pause');
  const t0 = performance.now();
  const from = ed.hour;
  let last = 0;
  const tick = (now) => {
    if (!ed.playing) return;
    ed.hour = (from + ((now - t0) / 1000) * 2) % 24;
    $('#tce-hour').value = ed.hour; fillRange($('#tce-hour'));
    $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
    $('#tce-tag').textContent = TC.hourLabel(ed.hour);
    if (now - last > 250) { last = now; renderTicks(); for (const e of entries()) refreshSetting(e); }
    drawScene($('#tce-canvas'), section(), ed.hour, skyOpts());
    ed.playing.raf = requestAnimationFrame(tick);
  };
  ed.playing = { raf: requestAnimationFrame(tick) };
}

function currentXml() { return TC.serialize(ed.model); }
function targetRel() {
  if (ed.rel === '__ai__') return ed.aiDraft.rel;
  return ed.rel && ed.rel !== '__ext__' && !ed.rel.startsWith('pk:') ? ed.rel : 'common/data/timecycle/' + ed.name;
}

async function saveToPack(btn) {
  busy(btn, true);
  try {
    const xml = currentXml();
    const where = await api.call('editor:savePack', ed.rel.slice(3), xml);
    const keep = ed.sectionId;
    ed.model = TC.parse(xml);
    ed.sectionId = keep;
    paintEditor();
    notify.success('Saved', ed.name + ' in ' + where);
  } catch (e) { notify.error('Could not save', e.message); }
  busy(btn, false);
}

async function saveToFiveM(btn) {
  if (!ed.model) return;
  if (ed.rel && ed.rel.startsWith('pk:')) return saveToPack(btn);
  busy(btn, true);
  try {
    const xml = currentXml();
    const rel = targetRel();
    await api.call('timecycle:write', rel, xml);
    if (ed.rel === '__ai__') ed.aiDraft = null;
    ed.rel = rel;
    const keep = ed.sectionId;
    ed.model = TC.parse(xml);
    ed.sectionId = keep;
    await populateFiles(rel);
    paintEditor();
    notify.success('Saved to your game', ed.name + ' is in your citizen folder. Restart FiveM to see it. Backups can undo it.');
  } catch (e) { notify.error('Could not save', e.message); }
  busy(btn, false);
}

async function saveAsPack(btn) {
  if (!ed.model) return;
  const name = await ctx.modal({ title: 'Save as graphics pack', confirm: 'Save pack', input: { label: 'Pack name', value: ed.name.replace(/\.xml$/i, '') + ' edit' } });
  if (!name) return;
  busy(btn, true);
  try {
    await api.call('pack:create', name, { [targetRel()]: currentXml() }, {}, { enable: false });
    notify.success('Pack saved', name + ' is on the Mods page, switched off.');
  } catch (e) { notify.error('Could not save pack', e.message); }
  busy(btn, false);
}

async function exportXml() {
  try {
    const p = await api.call('timecycle:export', ed.name, currentXml());
    if (p) notify.success('Exported', p);
  } catch (e) { notify.error('Export failed', e.message); }
}

async function openExternal(path) {
  try {
    const f = await api.call('timecycle:open', path || null);
    if (!f) return;
    ed.external = f;
    await populateFiles('__ext__');
    $('#tce-file').value = '__ext__';
    await openRel('__ext__');
  } catch (e) { notify.error('Could not open file', e.message); }
}

function quickApply() {
  const sec = section();
  if (!sec) return;
  const t = TC.hexToRgb($('#tce-tint').value).map((x) => Math.round(x * 255));
  const n = TC.gradeColours(ed.model, {
    r: t[0], g: t[1], b: t[2], strength: $('#tce-tint-amt').value / 100,
    brightness: $('#tce-bright').value / 100, saturation: $('#tce-sat').value / 100, groups: GRADE_GROUPS,
  }, sec.id);
  for (const id of ['tce-tint-amt', 'tce-bright']) $('#' + id).value = 0;
  $('#tce-sat').value = 100;
  paintQuick();
  renderSettings(); setDirtyTag(); queueDraw();
  notify.info('Colours changed', n + ' colours changed. Undo all puts them back.');
}

function paintQuick() {
  $('#tce-tint-val').textContent = $('#tce-tint-amt').value + '%';
  $('#tce-bright-val').textContent = ($('#tce-bright').value > 0 ? '+' : '') + $('#tce-bright').value;
  $('#tce-sat-val').textContent = $('#tce-sat').value + '%';
  $$('#tce-tint-amt, #tce-bright, #tce-sat').forEach(fillRange);
}

function initEditor() {
  $('#tce-file').onchange = (e) => openRel(e.target.value);
  $('#tce-src').onchange = (e) => chooseSource(e.target.value);
  $('#tce-cycle').onchange = (e) => {
    const area = section() ? TC.splitSection(section().label).area : null;
    const same = usable().filter((x) => TC.splitSection(x.label).weather === e.target.value);
    ed.sectionId = (same.find((x) => TC.splitSection(x.label).area === area) || same[0] || {}).id || null;
    ed.open = null;
    paintEditor();
  };
  $('#tce-open').onclick = () => openExternal();
  $('#tce-hour').addEventListener('input', (e) => { stopPlay(); setHour(+e.target.value); });
  $('#tce-play').onclick = togglePlay;
  $('#tce-search').addEventListener('input', (e) => { ed.query = e.target.value; renderSettings(); });
  $$('#tce-tint-amt, #tce-bright, #tce-sat').forEach((el) => el.addEventListener('input', paintQuick));
  $('#tce-quick-apply').onclick = quickApply;
  $('#tce-revert').onclick = async () => {
    if (!(await ctx.modal({ title: 'Undo all changes?', text: 'Every setting goes back to how it was when you opened ' + ed.name + '.', confirm: 'Undo all', danger: true }))) return;
    TC.revert(ed.model); renderSettings(); setDirtyTag(); queueDraw();
  };
  $('#tce-export').onclick = exportXml;
  $('#tce-weather').onclick = async () => {
    if (TC.isDirty(ed.model)) return notify.warning('Save first', 'Press Save to game, then use this file for sunny weather.');
    try {
      const r = await api.call('colour:activate', ed.rel);
      notify.success('Now used for sunny weather', r.source + ' was copied over w_extrasunny.xml and w_clear.xml. Backups can undo it.');
    } catch (e) { notify.error('Could not set weather', e.message); }
  };
  $('#tce-pack').onclick = (e) => saveAsPack(e.currentTarget);
  $('#tce-save').onclick = (e) => saveToFiveM(e.currentTarget);
  $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
  paintQuick();
  setDirtyTag();
  addEventListener('resize', () => { if (pane === 'editor') queueDraw(); if (pane === 'ai') drawAi(); });
}

async function enterEditor() {
  await populateSources();
  loadSkyPicture();
  const items = await populateFiles();
  if (!ed.model) {
    const first = items.find((i) => /extrasunny/i.test(i.name)) || items.find((i) => i.isWeather) || items[0];
    if (first) { $('#tce-file').value = first.rel; await openRel(first.rel, { force: true }); }
    else paintEditor();
  } else paintEditor();
  await frame();
  queueDraw();
}

// =====================================================================
// Pack AI
// =====================================================================

const aip = {
  spec: AI.emptySpec(), image: null, pack: null, result: null, log: [], installed: null,
  hour: 12, playing: null, preview: null, busy: false, sky: null, // sky: { label, rel, tex, forImage, error }
};

function bubble(who, html) {
  aip.log.push({ who, html });
  if (aip.log.length > 40) aip.log.shift();
  const box = $('#aip-log');
  box.innerHTML = aip.log.map((m) => `<div class="msg ${m.who}">${m.html}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function greet() {
  aip.log = [];
  bubble('ai', `What pack do you want? Add a picture ${icon('image')} for the sky or a pack ${icon('folder')} to build on.`);
}

async function refreshAiEngine() {
  const c = await api.call('ai:config').catch(() => null);
  aip.linked = !!(c && c.on);
  $('#aip-engine').textContent = aip.linked ? 'AI · ' + (c.provider || 'online') : 'Offline';
}

function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = url;
  });
}

async function attachImage(file) {
  const url = `data:${file.mediaType};base64,${file.data}`;
  const img = await loadImageEl(url);
  const small = document.createElement('canvas');
  const k = Math.min(1, 256 / Math.max(img.width, img.height));
  small.width = Math.max(1, Math.round(img.width * k)); small.height = Math.max(1, Math.round(img.height * k));
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const palette = AI.extractPalette(sctx.getImageData(0, 0, small.width, small.height));
  aip.image = { name: file.name, url, img, palette, id: file.name + ':' + img.width + 'x' + img.height + ':' + file.data.length };
  $('#aip-thumb').src = url;
  $('#aip-img-name').textContent = file.name;
  $('#aip-img-meta').textContent = img.width + '×' + img.height + ' · becomes your sky';
  $('#aip-attached').classList.remove('hidden');
  bubble('ai', `Got your picture <b>${esc(file.name)}</b>. Press <b>Create</b> to make it your sky, or say what else you want too.`);
}

function clearImage() {
  aip.image = null;
  $('#aip-attached').classList.add('hidden');
}

async function pickImage() {
  try {
    const f = await api.call('gfx:pickImage');
    if (f) await attachImage(f);
  } catch (e) { notify.error('Picture not added', e.message); }
}

async function loadPack(paths) {
  try {
    const info = await notify.promise(api.call('gfx:loadPack', paths), { loading: 'Reading pack…', success: 'Pack loaded', error: 'Could not read that pack' });
    aip.pack = info;
    aip.sky = null;
    aip.result = null;
    $('#aip-pack-name').textContent = info.name;
    const bits = [info.count + ' files'];
    bits.push(info.weather.length ? info.weather.length + ' weather files' : info.timecycles.length + ' timecycles');
    if (info.rpfs) bits.push(info.rpfs + ' RPF' + (info.rpfs === 1 ? '' : 's') + ' for mods');
    if (info.skydome) bits.push('has a sky texture');
    $('#aip-pack-meta').textContent = bits.join(' · ');
    $('#aip-pack').classList.remove('hidden');
    bubble('ai', `Loaded <b>${esc(info.name)}</b>: ${esc(bits.join(', '))}. I'll build on it and keep all of its files. ` +
      (info.timecycles.length ? 'What should I change?' : 'It has no timecycle files, so I can only switch world options and the sky picture.'));
  } catch (e) { /* toast shown */ }
}

async function pickPack() {
  const dir = await api.call('pick:files', { directory: true, title: 'Select a graphics pack folder' });
  if (dir) loadPack(dir);
}

async function clearPack() {
  await api.call('gfx:clearPack').catch(() => {});
  aip.pack = null; aip.sky = null; aip.result = null;
  $('#aip-pack').classList.add('hidden');
  bubble('ai', 'Pack removed. I\'ll build on the files in your game instead.');
}

async function baseFiles() {
  if (aip.pack) return (await api.call('gfx:packTimecycles')) || {};
  const scan = await api.call('colour:scan');
  const items = scan.items || [];
  const weather = items.filter((i) => i.isWeather);
  const files = {};
  for (const it of weather.length ? weather : items) {
    try { files[it.rel] = await api.call('timecycle:read', it.rel, { stock: true }); } catch (e) { /* skip unreadable */ }
  }
  return files;
}

// ---------- the picture as the actual sky ----------

/** Find the sky without asking: the dropped pack (loose or inside its RPFs), the RPFs in
 *  FiveM.app/mods, citizen, then the player's own GTA V (found through FiveM). */
const SKY_WAIT = {
  'pack-rpf': 'Looking for the sky inside your pack\'s RPFs…',
  mods: 'Looking for the sky in your mods folder…',
  game: 'Getting the sky from your GTA V… (first time can take about 10 seconds)',
};
async function openSky() {
  const { sources } = await api.call('sky:status');
  let lastError = null;
  for (const src of sources) {
    const h = SKY_WAIT[src] ? notify({ type: 'loading', title: SKY_WAIT[src], message: 'Your files are only read, never changed.' }) : null;
    try {
      const r = await api.call('sky:open', src);
      if (h) h.close();
      return r;
    } catch (e) {
      if (h) h.close();
      lastError = cleanError(e.message);
    }
  }
  return { error: sources.length ? lastError : 'not-found' };
}

function encodeLevels(img, t) {
  const parts = [];
  let src = img;
  let sw = img.width; let sh = img.height;
  for (let i = 0; i < t.levels; i++) {
    const w = Math.max(1, t.width >> i); const h = Math.max(1, t.height >> i);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    if (i === 0) {
      // cover: fill the texture, crop what does not fit
      const k = Math.max(w / sw, h / sh);
      g.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    } else g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    for (let k = 3; k < px.length; k += 4) px[k] = 255;
    parts.push(encodeTex(t.format, px, w, h));
    src = c; sw = w; sh = h;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function applySkyPicture(opened = null) {
  if (!opened && aip.sky && aip.sky.forImage === aip.image.id && !aip.sky.error) return aip.sky;
  opened = opened || (await openSky());
  if (!opened || opened.error) {
    aip.sky = { error: opened && opened.error !== 'not-found'
      ? 'I couldn\'t open GTA V\'s sky file (' + opened.error + '), so I matched the sky colours to your picture instead.'
      : 'I couldn\'t find a sky file (no sky RPF in your pack or mods folder, and no GTA V found), so I matched the sky colours to your picture instead.', canPick: true };
    return aip.sky;
  }
  const tex = opened.textures[opened.skyIndex];
  if (!tex.editable) {
    aip.sky = { error: `The sky texture in ${opened.label} uses ${tex.format} compression, which I can't write yet, so I matched the sky colours to your picture instead.` };
    return aip.sky;
  }
  await frame(); await frame();
  try {
    await api.call('sky:apply', tex.index, encodeLevels(aip.image.img, tex));
  } catch (e) {
    aip.sky = { error: 'I couldn\'t write the sky texture (' + e.message + '), so I matched the sky colours to your picture instead.' };
    return aip.sky;
  }
  aip.sky = { label: opened.label, rel: opened.rel, tex, forImage: aip.image.id };
  return aip.sky;
}

/** The "choose it yourself" link in a chat message, for when the sky file was not found. */
async function pickSkyFile() {
  if (!aip.image) return notify.info('Add a picture first', 'Then I can put it in the sky.');
  try {
    const opened = await api.call('sky:open', 'pick');
    if (!opened) return;
    const sk = await applySkyPicture(opened);
    if (sk.error) return bubble('ai', esc(sk.error));
    if (aip.result) { aip.result.skyOk = true; showResult(); await installAi(); }
    bubble('ai', `Got it: your picture is now the sky (${esc(sk.tex.width + '×' + sk.tex.height)}). Installing it now…`);
  } catch (e) { notify.error('Could not use that file', e.message); }
}

// ---------- create ----------


async function generate() {
  if (aip.busy) return;
  const input = $('#aip-text');
  const text = input.value.trim();
  if (!text && !aip.image) return notify.info('Say what you want', 'Describe your pack, or add a picture for the sky.');
  aip.busy = true;
  $('#aip-examples').classList.add('hidden');
  const btn = $('#aip-send');
  busy(btn, true);
  bubble('user', (aip.image ? `<span class="att">${icon('image')}${esc(aip.image.name)}</span>` : '') + esc(text || 'Make this picture my sky.'));
  input.value = '';
  try {
    // through the AI link when one is set, else the built-in reader
    let patch = null;
    if (aip.linked) {
      try {
        const r = await api.call('ai:ask', { text, spec: aip.spec, hasImage: !!aip.image, hasPack: !!aip.pack });
        patch = AI.fromModel(r.patch);
        if (r.reply) bubble('ai', esc(r.reply));
      } catch (e) { bubble('ai', 'The AI did not answer (' + esc(e.message) + '), so I read it myself.'); }
    }
    if (!patch) patch = AI.parsePrompt(text);
    if (aip.image) {
      patch.sky = { ...pick(aip.image.palette), strength: 0.85 };
      patch.skyImage = patch.imageUse === 'colours' ? null : { allDay: !!patch.imageAllDay };
    }
    aip.spec = AI.mergeSpec(aip.spec, patch);
    if (!aip.image) aip.spec.skyImage = null;
    if (AI.isEmptySpec(aip.spec)) {
      bubble('ai', "I didn't catch anything to change. Try <i>add stars</i>, <i>sunset sky</i>, <i>no water</i>, <i>no trees</i>, <i>FPS boost</i>, or add a picture.");
      return;
    }

    const files = await baseFiles();
    let skyOk = false;
    let sk = null;
    if (aip.spec.skyImage && aip.image) {
      sk = await applySkyPicture();
      skyOk = !sk.error;
    }
    // Without the sky texture, darkening the day sky would just leave it black:
    // build with the picture's colours instead.
    const res = AI.buildPack(skyOk || !aip.spec.skyImage ? aip.spec : { ...aip.spec, skyImage: null }, files);
    const lines = res.report.map((r) => `${r.ok ? '✓' : '!'} ${esc(r.text)}`);
    if (sk) {
      lines.unshift(skyOk ? `✓ Your picture is now the sky (${esc(sk.tex.width + '×' + sk.tex.height)}) in ${esc(sk.label)}${/^@mods\//.test(sk.rel) ? ', and also as citizen/platform/textures/skydome.ytd' : ''}. ${aip.spec.skyImage.allDay ? '' : ' It shows at night.'}` : '! ' + esc(sk.error) + (sk.canPick ? ' <button class="link-btn" data-act="pick-sky">Have a sky RPF or skydome.ytd? Choose it</button>' : ''));
    }

    const tw = await api.call('tweaks:list');
    const world = {};
    for (const [id, on] of Object.entries(res.tweaks)) {
      const t = tw.find((x) => x.id === id);
      const label = AI.WORLD_LABEL[id];
      // black mountains and snow edit visualsettings.dat / weather.xml (World page), not pack files
      if (id === 'mountains' || id === 'snow') {
        world[id] = on;
        delete res.tweaks[id];
        lines.push(`✓ ${esc(label)}: ${id === 'snow' ? (on ? 'on' : 'off') : on ? 'removed' : 'visible'}`);
        continue;
      }
      if (t && !t.hasFiles) {
        // Nothing to switch: the player's packs do not come with removal files for this.
        delete res.tweaks[id];
        lines.push(on ? `! ${esc(label)}: your packs don't include files that remove ${esc(label.toLowerCase())}, so I can't take them out. If you get those files, add them on the World page.` : `✓ ${esc(label)}: stay as they are`);
      } else if (t && t.enabled === on) {
        delete res.tweaks[id];
        lines.push(`✓ ${esc(label)}: already ${on ? 'removed' : 'in the game'}`);
      } else lines.push(`✓ ${esc(label)}: ${on ? 'removed' : 'back in the game'}`);
    }
    if (!Object.keys(files).length && (aip.spec.sky || aip.spec.grade || aip.spec.fps || Object.keys(aip.spec.adjust || {}).length)) {
      lines.push('! I found no timecycle files ' + (aip.pack ? 'in this pack' : 'in your game (link your citizen folder or add a pack)') + ', so colours, stars and FPS could not be changed.');
    }
    aip.result = { ...res, world, name: AI.packName(aip.spec), base: files, skyOk };
    showResult();
    bubble('ai', `Made <b>${esc(aip.result.name)}</b>:<br>${lines.join('<br>')}`);
    // The manager does the work: install straight away (Undo puts it all back).
    if (Object.keys(res.files).length || Object.keys(res.tweaks).length || Object.keys(world).length || skyOk || aip.pack) await installAi();
  } catch (e) {
    bubble('ai', 'Something went wrong: ' + esc(e.message));
  } finally {
    aip.busy = false;
    busy(btn, false);
  }
}

const pick = (p) => ({ zenith: p.zenith, horizon: p.horizon, sun: p.sun, cloud: p.cloud, fog: p.fog });

function showResult() {
  const r = aip.result;
  $('#aip-spec').innerHTML = AI.describeSpec(aip.spec).filter((c) => r.skyOk || !/^Picture sky/.test(c)).map((c) => `<span class="tag">${esc(c)}</span>`).join('');
  $('#aip-report').innerHTML = r.report.map((x) => `<li class="${x.ok ? 'ok' : 'warn'}">${esc(x.text)}</li>`).join('');
  const hasWork = Object.keys(r.files).length || Object.keys(r.tweaks).length || Object.keys(r.world || {}).length || r.skyOk || aip.pack;
  $('#aip-install').disabled = !hasWork;
  $('#aip-edit').disabled = !Object.keys(r.files).length;
  $('#aip-status').textContent = r.name;
  const rel = Object.keys(r.files)[0] || Object.keys(r.base)[0];
  aip.preview = null;
  if (rel) {
    const m = TC.parse(r.files[rel] || r.base[rel]);
    const secs = m.sections.filter((s) => s.colours.length);
    aip.preview = secs.find((s) => /extrasunny|clear/i.test(s.label)) || secs[0] || null;
  }
  drawAi();
}

function drawAi() {
  if (pane !== 'ai') return;
  const cv = $('#aip-canvas');
  // the picture shows whenever it is meant to be the sky (if the game's sky file was not found, the chat says so)
  const showImg = aip.result && aip.image && (aip.result.skyOk || (aip.spec.skyImage && aip.spec.imageUse !== 'colours'));
  const has = !!(aip.preview || showImg);
  $('#aip-empty').classList.toggle('hidden', has);
  if (has) {
    // "always night/day" packs look the same at every hour, so there is no clock to scrub
    const lock = aip.spec.timeLock;
    drawScene(cv, aip.preview || { colours: [], scalars: [], params: [] }, lock === 'night' ? 0 : lock === 'day' ? 12 : aip.hour, showImg ? { image: aip.image.img, allDay: !!(aip.spec.skyImage && aip.spec.skyImage.allDay) } : null);
  } else { const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); }
  const lock = aip.spec.timeLock;
  $('#aip-time-row').classList.toggle('hidden', !!lock);
  $('#aip-tag').textContent = lock ? 'Always ' + lock : TC.hourLabel(aip.hour);
  $('#aip-hour-label').textContent = TC.hourLabel(aip.hour);
}

function toggleAiPlay() {
  const btn = $('#aip-play');
  if (aip.playing) { cancelAnimationFrame(aip.playing.raf); aip.playing = null; btn.innerHTML = icon('play'); return; }
  btn.innerHTML = icon('pause');
  const t0 = performance.now(); const from = aip.hour;
  const tick = (now) => {
    if (!aip.playing) return;
    aip.hour = (from + ((now - t0) / 1000) * 2) % 24;
    $('#aip-hour').value = aip.hour; fillRange($('#aip-hour'));
    drawAi();
    aip.playing.raf = requestAnimationFrame(tick);
  };
  aip.playing = { raf: requestAnimationFrame(tick) };
}

const where = (rel) => (rel.startsWith('@mods/') ? 'mods/' + rel.slice(6) : 'citizen/' + rel);

/** Install the current result. Runs by itself after Create; the button is only for retrying. */
async function installAi() {
  const r = aip.result;
  if (!r) return;
  const btn = $('#aip-install');
  busy(btn, true);
  try {
    await undoInstall({ quiet: true });
    const out = await api.call('pack:create', r.name, r.files, r.tweaks, { includePack: !!aip.pack, includeSky: !!r.skyOk });
    aip.installed = { id: out.id, tweaks: Object.fromEntries(out.applied.map((t) => [t, r.tweaks[t]])), world: {} };
    const lines = [];
    // black mountains / snow: remember how they were so Undo can put them back
    if ('mountains' in (r.world || {})) {
      try {
        aip.installed.world.mountains = await api.call('world:mountains');
        await api.call('world:setMountains', { removed: r.world.mountains });
        lines.push('✓ Black mountains ' + (r.world.mountains ? 'removed' : 'visible') + ' (visualsettings.dat)');
      } catch (e) { lines.push('! Black mountains: ' + esc(e.message)); }
    }
    if ('snow' in (r.world || {})) {
      try {
        aip.installed.world.snow = await api.call('world:snow');
        await api.call('world:setSnow', r.world.snow ? 1 : 0);
        lines.push('✓ Snow ' + (r.world.snow ? 'on' : 'off') + ' (weather.xml)');
      } catch (e) { lines.push('! Snow: ' + esc(e.message)); }
    }
    if (out.verified.length) lines.push(`✓ Checked on disk: your picture is in ${out.verified.map((x) => `<b>${esc(where(x))}</b>`).join(' and ')}`);
    if (out.failed.length) lines.push(`! I couldn't write ${out.failed.map((x) => esc(where(x))).join(', ')}. If FiveM is open, close it fully and press <b>Install again</b>.`);
    if (out.applied.length) lines.push('✓ ' + out.applied.map((t) => AI.WORLD_LABEL[t] + (r.tweaks[t] ? ' removed' : ' back')).join(', '));
    for (const sk of out.skipped) lines.push(`! ${esc(AI.WORLD_LABEL[sk.id] || sk.id)}: ${esc(sk.reason)}`);
    bubble('ai', `<b>Installed${out.failed.length ? ' (with a problem)' : ''}.</b> Restart FiveM to see it.${lines.length ? '<br>' + lines.join('<br>') : ''}<br><small>Not happy? Press <b>Undo</b> and everything goes back.</small>`);
    notify[out.failed.length ? 'warning' : 'success'](out.failed.length ? 'Installed, but a file could not be written' : 'Pack installed', out.failed.length ? 'Close FiveM and press Install again.' : 'Restart FiveM to see it.');
    paintInstallState();
  } catch (e) {
    bubble('ai', `! I couldn't install it: ${esc(e.message)}. If FiveM is open, close it and press <b>Install again</b>.`);
    notify.error('Could not install pack', e.message);
  }
  busy(btn, false);
}

/** Take the last AI pack out again and put any world switches back. */
async function undoInstall({ quiet = false } = {}) {
  const inst = aip.installed;
  if (!inst) return;
  aip.installed = null;
  try {
    if (inst.id) await api.call('tweaks:removeCustom', inst.id);
    for (const [t, on] of Object.entries(inst.tweaks)) await api.call('tweaks:set', t, !on).catch(() => {});
    const w = inst.world || {};
    if (w.mountains) await api.call('world:setMountains', w.mountains.removed ? { removed: true, distance: w.mountains.value } : { removed: false }).catch(() => {});
    if (w.snow) await api.call('world:setSnow', w.snow.on ? w.snow.amount : 0).catch(() => {});
    if (!quiet) { bubble('ai', 'Undone: the pack is out of your game and everything is back how it was.'); notify.success('Undone', 'Your game is back how it was.'); }
  } catch (e) { if (!quiet) notify.error('Undo failed', e.message); }
  paintInstallState();
}

function paintInstallState() {
  const on = !!aip.installed;
  $('#aip-undo').classList.toggle('hidden', !on);
  $('#aip-install').innerHTML = icon('zap') + (on ? 'Install again' : 'Install');
}

async function editAiResult() {
  const r = aip.result;
  const rel = r && Object.keys(r.files)[0];
  if (!rel) return;
  ed.aiDraft = { name: rel.split('/').pop(), rel, xml: r.files[rel] };
  ed.rel = '__ai__'; ed.name = ed.aiDraft.name;
  ed.model = TC.parse(r.files[rel]);
  ed.open = null;
  pickDefaultSection();
  setPane('editor');
  notify.info('Opened in the editor', 'This is the AI version of ' + ed.name + '. Save it to the game or as a pack when you are done.');
}

function initAi() {
  $('#aip-examples').innerHTML = AI.EXAMPLES.map((e) => `<button class="chip" data-t="${esc(e)}">${esc(e)}</button>`).join('');
  $$('#aip-examples .chip').forEach((c) => (c.onclick = () => { $('#aip-text').value = c.dataset.t; $('#aip-text').focus(); }));
  $('#aip-send').onclick = generate;
  $('#aip-log').addEventListener('click', (e) => { if (e.target.closest('[data-act=pick-sky]')) pickSkyFile(); });
  $('#aip-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } });
  $('#aip-attach').onclick = pickImage;
  $('#aip-folder').onclick = pickPack;
  $('#aip-img-clear').onclick = clearImage;
  $('#aip-pack-clear').onclick = clearPack;
  $('#aip-reset').onclick = async () => {
    aip.spec = AI.emptySpec(); aip.result = null; aip.preview = null; aip.installed = null; aip.sky = null; paintInstallState();
    clearImage(); if (aip.pack) { await api.call('gfx:clearPack').catch(() => {}); aip.pack = null; $('#aip-pack').classList.add('hidden'); }
    greet(); $('#aip-examples').classList.remove('hidden');
    $('#aip-spec').innerHTML = ''; $('#aip-report').innerHTML = ''; $('#aip-status').textContent = 'Nothing made yet';
    $('#aip-install').disabled = true; $('#aip-edit').disabled = true; drawAi();
  };
  $('#aip-hour').addEventListener('input', (e) => { if (aip.playing) toggleAiPlay(); aip.hour = +e.target.value; drawAi(); });
  $('#aip-play').onclick = toggleAiPlay;
  $('#aip-install').onclick = () => installAi();
  $('#aip-undo').onclick = () => undoInstall();
  $('#aip-edit').onclick = editAiResult;
  greet();
}

// =====================================================================
// Tabs
// =====================================================================


function setPane(name) {
  if (name !== 'editor') stopPlay();
  if (name !== 'ai' && aip.playing) toggleAiPlay();
  pane = name;
  $$('#gfx-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  syncSeg($('#gfx-tabs'));
  $$('.gfx-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  requestAnimationFrame(() => $$('.gfx-pane:not(.hidden) .seg').forEach(syncSeg));
  if (name === 'editor') enterEditor();
  if (name === 'clouds') cloudLab.enter();
  if (name === 'blood') bloodLab.enter();
  if (name === 'ai') { refreshAiEngine(); requestAnimationFrame(drawAi); }
}

export function initStudio(c) {
  ctx = { ...ctx, ...c };
  $$('#gfx-tabs button').forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
  initEditor();
  initAi();
  cloudLab.init({ modal: ctx.modal });
  bloodLab.init({ modal: ctx.modal });
  refreshAiEngine();
}

/** Called each time the Graphics page opens. */
export function refreshStudio() {
  requestAnimationFrame(() => syncSeg($('#gfx-tabs')));
  if (pane === 'editor') enterEditor();
  if (pane === 'clouds') cloudLab.enter();
  if (pane === 'blood') bloodLab.enter();
  if (pane === 'ai') { refreshAiEngine(); drawAi(); }
}

/** Files dropped on the Graphics page. Returns true when the studio took them. */
export async function handleDrop(paths) {
  const isImg = (p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p);
  if (paths.every(isImg)) {
    if (pane !== 'ai') setPane('ai');
    try { await attachImage(await api.call('gfx:readImage', paths[0])); } catch (e) { notify.error('Picture not added', e.message); }
    return true;
  }
  if (pane === 'editor' && paths.length === 1 && /\.xml$/i.test(paths[0])) { await openExternal(paths[0]); return true; }
  if (pane === 'ai') { await loadPack(paths); return true; }
  if (pane === 'blood' && paths.length === 1 && /\.rpf$/i.test(paths[0])) { await bloodLab.openPaths(paths); return true; }
  return false;
}
