// Graphics page: the timecycle editor (live preview, every value editable) and
// the Pack AI (turns a request, and optionally an image, into a graphics pack).

import { notify } from './notify.js';
import { icon } from './icons.js';
import { busy, syncSeg, fillRange } from './fx.js';
import * as TC from './timecycle.js';
import * as AI from './gfxai.js';
import { drawScene } from './tcpreview.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const frame = () => new Promise((r) => requestAnimationFrame(r));

let ctx = { modal: null, go: null, refreshGraphics: null };
let pane = 'grade';

// =====================================================================
// Timecycle editor
// =====================================================================

const ed = {
  rel: null, name: '', model: null, sectionId: null, hour: 12, mode: 'key', group: 'all', query: '',
  items: [], rows: [], playing: null, drawQueued: false, external: null,
};
const GRADE_GROUPS = ['sky', 'sun', 'cloud', 'light', 'ambient', 'fog'];

const section = () => ed.model && ed.model.sections.find((s) => s.id === ed.sectionId);
const keyOf = (n) => TC.nearestKey(n, ed.hour);
const hexOf = (rgb) => TC.rgbToHex(rgb);
const stepFor = (v) => (Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 0.1 : 0.01);

function queueDraw() {
  if (ed.drawQueued) return;
  ed.drawQueued = true;
  requestAnimationFrame(() => {
    ed.drawQueued = false;
    const sec = section();
    if (sec && pane === 'editor') drawScene($('#tce-canvas'), sec, ed.hour);
  });
}

function setDirtyTag() {
  const n = ed.model ? TC.dirtyCount(ed.model) : 0;
  const tag = $('#tce-dirty');
  tag.textContent = n ? n + ' value' + (n === 1 ? '' : 's') + ' edited' : 'Unchanged';
  tag.classList.toggle('solid', n > 0);
  for (const id of ['tce-revert', 'tce-export', 'tce-pack', 'tce-save']) $('#' + id).disabled = !ed.model;
  $('#tce-revert').disabled = !n;
}

async function populateFiles(selectRel) {
  let items = [];
  try { items = (await api.call('colour:scan')).items || []; } catch (e) { /* citizen not linked */ }
  ed.items = items;
  const sel = $('#tce-file');
  let html = items.length ? '' : '<option value="">No timecycle files found</option>';
  html += items.map((it) => `<option value="${esc(it.rel)}">${esc(it.name)}${it.cycles.length ? ' [' + esc(it.cycles[0]) + ']' : ''}</option>`).join('');
  if (ed.external) html += `<option value="__ext__">${esc(ed.external.name)} (opened file)</option>`;
  sel.innerHTML = html;
  const want = selectRel || (ed.external && ed.rel === '__ext__' ? '__ext__' : ed.rel);
  if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  return items;
}

async function openRel(rel, { force = false } = {}) {
  if (!force && ed.model && TC.isDirty(ed.model)) {
    const ok = await ctx.modal({ title: 'Discard your edits?', text: 'You have unsaved changes in ' + ed.name + '.', confirm: 'Discard', danger: true });
    if (!ok) { $('#tce-file').value = ed.rel || ''; return; }
  }
  try {
    if (rel === '__ext__') {
      ed.rel = '__ext__'; ed.name = ed.external.name;
      ed.model = TC.parse(ed.external.xml);
    } else {
      const xml = await api.call('timecycle:read', rel);
      ed.rel = rel; ed.name = rel.split('/').pop();
      ed.model = TC.parse(xml);
    }
  } catch (e) { notify.error('Could not open timecycle', e.message); return; }
  if (!ed.model.params.length) notify.warning('Nothing to edit', ed.name + ' has no numeric timecycle values.');
  const secs = ed.model.sections.filter((s) => s.params.length);
  ed.sectionId = (secs.find((s) => /extrasunny|clear/i.test(s.label)) || secs[0] || {}).id || null;
  ed.group = 'all'; ed.query = ''; $('#tce-search').value = '';
  paintEditor();
}

function paintEditor() {
  const has = !!(ed.model && section());
  $('#tce-empty').classList.toggle('hidden', has);
  $('#tce-canvas').classList.toggle('hidden', !has);
  const secSel = $('#tce-section');
  if (ed.model) {
    secSel.innerHTML = ed.model.sections.filter((s) => s.params.length).map((s) => `<option value="${esc(s.id)}">${esc(s.label)} (${s.colours.length} colours)</option>`).join('');
    if (ed.sectionId) secSel.value = ed.sectionId;
  } else secSel.innerHTML = '';
  secSel.style.display = ed.model && ed.model.sections.filter((s) => s.params.length).length > 1 ? '' : 'none';
  renderGroups();
  renderParams();
  renderKeys();
  setDirtyTag();
  queueDraw();
}

function renderGroups() {
  const sec = section();
  const counts = {};
  if (sec) for (const p of sec.params) counts[p.group] = (counts[p.group] || 0) + 1;
  const total = sec ? sec.colours.length + sec.scalars.length : 0;
  const chips = [['all', 'All', total]].concat(TC.GROUPS.filter((g) => counts[g.id]).map((g) => {
    const n = sec.colours.filter((c) => c.group === g.id).length + sec.scalars.filter((p) => p.group === g.id).length;
    return [g.id, g.label, n];
  })).filter((c) => c[2] > 0);
  $('#tce-groups').innerHTML = chips.map(([id, label, n]) => `<button class="chip ${ed.group === id ? 'on' : ''}" data-g="${id}">${esc(label)} <small>${n}</small></button>`).join('');
  $$('#tce-groups .chip').forEach((c) => (c.onclick = () => { ed.group = c.dataset.g; renderGroups(); renderParams(); }));
}

function dominantKeyCount() {
  const sec = section();
  if (!sec) return 9;
  const tally = {};
  for (const p of sec.params) tally[p.values.length] = (tally[p.values.length] || 0) + 1;
  return +Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

function renderKeys() {
  const n = dominantKeyCount();
  const hrs = TC.keyHours(n);
  const box = $('#tce-keys');
  if (!section() || n < 2) { box.innerHTML = ''; return; }
  box.innerHTML = hrs.map((h, i) => `<button data-h="${h}" class="${i === TC.nearestKey(n, ed.hour) ? 'on' : ''}">${TC.hourLabel(h)}</button>`).join('');
  $$('button', box).forEach((b) => (b.onclick = () => setHour(+b.dataset.h)));
}

function renderParams() {
  const sec = section();
  const list = $('#tce-list');
  ed.rows = [];
  if (!sec) { list.innerHTML = ''; $('#tce-note').textContent = ''; return; }
  const q = ed.ui_query = ed.query.trim().toLowerCase();
  const match = (name, group) => (ed.group === 'all' || ed.group === group) && (!q || name.toLowerCase().includes(q));
  const cols = sec.colours.filter((c) => match(c.name, c.group));
  const scal = sec.scalars.filter((p) => match(p.name, p.group));
  const frag = [];
  for (const c of cols) {
    frag.push(`<li class="pr col" data-kind="c" data-name="${esc(c.name)}"><div class="pr-name" title="${esc(c.name)}">${esc(c.name.replace(/_col$/, ''))}</div>
      <div class="kcells">${c.r.values.map((_, i) => `<button class="kc" data-k="${i}" title="${TC.hourLabel(TC.keyHours(c.r.values.length)[i])}"></button>`).join('')}</div>
      <input type="color" class="cin" /></li>`);
  }
  for (const p of scal) {
    frag.push(`<li class="pr sc" data-kind="s" data-name="${esc(p.name)}"><div class="pr-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="kbars">${p.values.map((_, i) => `<button class="kb" data-k="${i}"><i></i></button>`).join('')}</div>
      <input type="number" class="nin" step="any" /></li>`);
  }
  list.innerHTML = frag.length ? frag.join('') : '<li class="empty">Nothing matches.</li>';
  $('#tce-note').textContent = `${cols.length} colour${cols.length === 1 ? '' : 's'} · ${scal.length} value${scal.length === 1 ? '' : 's'}`;

  $$('li.pr', list).forEach((li) => {
    const col = li.dataset.kind === 'c' ? cols.find((c) => c.name === li.dataset.name) : null;
    const par = li.dataset.kind === 's' ? scal.find((p) => p.name === li.dataset.name) : null;
    const row = { li, col, par };
    ed.rows.push(row);
    $$('.kc, .kb', li).forEach((b) => (b.onclick = () => {
      const n = (col || par).r ? col.r.values.length : par.values.length;
      setHour(TC.keyHours(n)[+b.dataset.k]);
    }));
    if (col) {
      $('.cin', li).addEventListener('input', (e) => { editColour(col, TC.hexToRgb(e.target.value)); syncRow(row); afterEdit(); });
    } else {
      $('.nin', li).addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        editScalar(par, v); syncRow(row); afterEdit();
      });
    }
    syncRow(row);
  });
}

function syncRow(row) {
  if (row.col) {
    const c = row.col;
    const k = keyOf(c.r.values.length);
    $$('.kc', row.li).forEach((b, i) => {
      b.style.background = hexOf(TC.colourAt(c, i));
      b.classList.toggle('on', i === k);
    });
    $('.cin', row.li).value = hexOf(TC.colourAt(c, k));
    row.li.classList.toggle('dirty', [c.r, c.g, c.b].some((p) => p.values.some((v, i) => v !== p.orig[i])));
  } else {
    const p = row.par;
    const k = keyOf(p.values.length);
    const min = Math.min(...p.values); const max = Math.max(...p.values);
    $$('.kb', row.li).forEach((b, i) => {
      b.classList.toggle('on', i === k);
      $('i', b).style.height = (max === min ? 55 : 14 + ((p.values[i] - min) / (max - min)) * 86) + '%';
    });
    const inp = $('.nin', row.li);
    if (document.activeElement !== inp) inp.value = TC.fmt(p.values[k]);
    row.li.classList.toggle('dirty', p.values.some((v, i) => v !== p.orig[i]));
  }
}

function syncAllRows() { ed.rows.forEach(syncRow); }

function editColour(col, rgb) {
  const n = col.r.values.length;
  const k = keyOf(n);
  if (ed.mode === 'key') { TC.setColour(col, k, rgb); return; }
  // "All day": move the whole curve so the current time matches, keeping its shape.
  const cur = TC.colourAt(col, k);
  [col.r, col.g, col.b].forEach((p, ch) => {
    const f = cur[ch] > 1e-4 ? rgb[ch] / cur[ch] : null;
    p.values = p.values.map((v) => Math.max(0, f != null ? v * f : v + (rgb[ch] - cur[ch])));
  });
}

function editScalar(p, v) {
  const k = keyOf(p.values.length);
  if (ed.mode === 'key') { p.values[k] = v; return; }
  const cur = p.values[k];
  p.values = p.values.map((x) => (Math.abs(cur) > 1e-6 ? x * (v / cur) : v));
}

function afterEdit() { setDirtyTag(); queueDraw(); if (ed.mode === 'all') syncAllRows(); }

function setHour(h) {
  ed.hour = ((h % 24) + 24) % 24;
  $('#tce-hour').value = ed.hour; fillRange($('#tce-hour'));
  $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
  $('#tce-tag').textContent = TC.hourLabel(ed.hour);
  renderKeys();
  syncAllRows();
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
  const tick = (now) => {
    if (!ed.playing) return;
    ed.hour = (from + ((now - t0) / 1000) * 2) % 24;
    $('#tce-hour').value = ed.hour; fillRange($('#tce-hour'));
    $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
    $('#tce-tag').textContent = TC.hourLabel(ed.hour);
    syncAllRows();
    drawScene($('#tce-canvas'), section(), ed.hour);
    ed.playing.raf = requestAnimationFrame(tick);
  };
  ed.playing = { raf: requestAnimationFrame(tick) };
}

function currentXml() { return TC.serialize(ed.model); }
function targetRel() { return ed.rel && ed.rel !== '__ext__' ? ed.rel : 'common/data/timecycle/' + ed.name; }

async function saveToFiveM(btn) {
  if (!ed.model) return;
  busy(btn, true);
  try {
    const xml = currentXml();
    const rel = targetRel();
    await api.call('timecycle:write', rel, xml);
    ed.rel = rel;
    const keep = ed.sectionId;
    ed.model = TC.parse(xml);
    ed.sectionId = keep;
    await populateFiles(rel);
    paintEditor();
    notify.success('Saved to FiveM', ed.name + ' is written to citizen. Restart FiveM to see it. "Backups" can undo it.');
    ctx.refreshGraphics && ctx.refreshGraphics();
  } catch (e) { notify.error('Could not save', e.message); }
  busy(btn, false);
}

async function saveAsPack(btn) {
  if (!ed.model) return;
  const name = await ctx.modal({ title: 'Save as graphics pack', text: 'Saves this timecycle into your pack list so you can switch it on and off. Nothing in FiveM changes until you switch it on.', confirm: 'Save pack', input: { label: 'Pack name', value: ed.name.replace(/\.xml$/i, '') + ' edit' } });
  if (!name) return;
  busy(btn, true);
  try {
    await api.call('pack:create', name, { [targetRel()]: currentXml() }, {}, { enable: false });
    notify.success('Pack saved', name + ' is in Colour grade → Graphics packs.');
    ctx.refreshGraphics && ctx.refreshGraphics();
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
  syncAllRows(); setDirtyTag(); queueDraw();
  notify.info('Colours updated', n + ' colour tracks changed in ' + sec.label + '. Revert undoes it.');
}

function paintQuick() {
  $('#tce-tint-val').textContent = $('#tce-tint-amt').value + '%';
  $('#tce-bright-val').textContent = ($('#tce-bright').value > 0 ? '+' : '') + $('#tce-bright').value;
  $('#tce-sat-val').textContent = $('#tce-sat').value + '%';
  $$('#tce-tint-amt, #tce-bright, #tce-sat').forEach(fillRange);
}

function initEditor() {
  $('#tce-file').onchange = (e) => openRel(e.target.value);
  $('#tce-section').onchange = (e) => { ed.sectionId = e.target.value; ed.group = 'all'; paintEditor(); };
  $('#tce-open').onclick = () => openExternal();
  $('#tce-hour').addEventListener('input', (e) => { stopPlay(); setHour(+e.target.value); });
  $('#tce-play').onclick = togglePlay;
  $('#tce-search').addEventListener('input', (e) => { ed.query = e.target.value; renderParams(); });
  $$('#tce-mode button').forEach((b) => (b.onclick = () => {
    ed.mode = b.dataset.v;
    $$('#tce-mode button').forEach((x) => x.classList.toggle('on', x === b));
    syncSeg($('#tce-mode'));
  }));
  $$('#tce-tint-amt, #tce-bright, #tce-sat').forEach((el) => el.addEventListener('input', paintQuick));
  $('#tce-quick-apply').onclick = quickApply;
  $('#tce-revert').onclick = () => { TC.revert(ed.model); syncAllRows(); setDirtyTag(); queueDraw(); };
  $('#tce-export').onclick = exportXml;
  $('#tce-pack').onclick = (e) => saveAsPack(e.currentTarget);
  $('#tce-save').onclick = (e) => saveToFiveM(e.currentTarget);
  $('#tce-hour-label').textContent = TC.hourLabel(ed.hour);
  paintQuick();
  setDirtyTag();
  addEventListener('resize', () => { if (pane === 'editor') queueDraw(); if (pane === 'ai') drawAi(); });
}

async function enterEditor() {
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

const aip = { spec: AI.emptySpec(), image: null, result: null, log: [], hasKey: false, installedId: null, hour: 12, playing: null, preview: null, busy: false };

function bubble(who, html) {
  aip.log.push({ who, html });
  if (aip.log.length > 40) aip.log.shift();
  const box = $('#aip-log');
  box.innerHTML = aip.log.map((m) => `<div class="msg ${m.who}">${m.html}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function greet() {
  aip.log = [];
  bubble('ai', `<b>Tell me what pack you want.</b> Attach an image to use as the sky, and mention anything you like: <i>no water, no black mountains, no props, have trees, no bushes</i>, or an <i>FPS boost</i>. You can keep chatting to change it ("now make it darker").`);
}

async function refreshAiEngine() {
  try { aip.hasKey = (await api.call('ai:status')).hasKey; } catch (e) { aip.hasKey = false; }
  $('#aip-engine').textContent = aip.hasKey ? 'Claude · reads images and long requests' : 'Built-in · works offline (add a key in Settings for Claude)';
  const st = $('#ai-key-state');
  if (st) st.textContent = aip.hasKey ? 'A key is saved on this PC. Claude writes your pack specs.' : 'Optional. Lets Claude read your requests and images.';
  const btn = $('#ai-key-btn');
  if (btn) btn.textContent = aip.hasKey ? 'Remove key' : 'Add key';
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
  // A smaller JPEG is all Claude needs to read the sky.
  const big = document.createElement('canvas');
  const k2 = Math.min(1, 1024 / Math.max(img.width, img.height));
  big.width = Math.max(1, Math.round(img.width * k2)); big.height = Math.max(1, Math.round(img.height * k2));
  big.getContext('2d').drawImage(img, 0, 0, big.width, big.height);
  const llm = { mediaType: 'image/jpeg', data: big.toDataURL('image/jpeg', 0.85).split(',')[1] };
  aip.image = { name: file.name, url, palette, llm };
  $('#aip-thumb').src = url;
  $('#aip-img-name').textContent = file.name;
  $('#aip-attached').classList.remove('hidden');
  const sw = Object.entries(palette).filter(([k3]) => ['zenith', 'horizon', 'sun', 'cloud', 'fog'].includes(k3)).map(([k3, v]) => `<span class="pal" style="background:${v}" title="${k3} ${v}"></span>`).join('');
  bubble('ai', `Got <b>${esc(file.name)}</b>. Sky colours I read from it: <span class="pals">${sw}</span> (top to horizon, sun, cloud, fog).`);
}

function clearImage() {
  aip.image = null;
  $('#aip-attached').classList.add('hidden');
}

async function pickImage() {
  try {
    const f = await api.call('gfx:pickImage');
    if (f) await attachImage(f);
  } catch (e) { notify.error('Image not added', e.message); }
}

async function weatherFiles() {
  const scan = await api.call('colour:scan');
  const items = scan.items || [];
  const weather = items.filter((i) => i.isWeather);
  const pick = weather.length ? weather : items;
  const files = {};
  for (const it of pick) {
    try { files[it.rel] = await api.call('timecycle:read', it.rel, { stock: true }); } catch (e) { /* skip unreadable */ }
  }
  return files;
}

async function askClaude(text) {
  const state = JSON.stringify({ ...aip.spec, sky: aip.spec.sky, grade: aip.spec.grade });
  const prompt = (aip.image ? 'An image is attached. The player wants it as the sky unless they say otherwise.\n' : '')
    + 'Current pack spec (update it, do not start over unless asked): ' + state + '\n\nPlayer request: ' + (text || '(only an image, use it as the sky)');
  const reply = await api.call('ai:ask', { system: AI.LLM_SYSTEM, prompt, image: aip.image ? aip.image.llm : null });
  return AI.validateSpec(AI.extractJson(reply));
}

async function generate() {
  if (aip.busy) return;
  const input = $('#aip-text');
  const text = input.value.trim();
  if (!text && !aip.image) return notify.info('Say what you want', 'Describe the pack, or attach an image to use as the sky.');
  aip.busy = true;
  $('#aip-examples').classList.add('hidden');
  const btn = $('#aip-send');
  busy(btn, true);
  bubble('user', (aip.image ? `<span class="att">${icon('image')}${esc(aip.image.name)}</span>` : '') + esc(text || 'Use this image as the sky.'));
  input.value = '';
  try {
    let spec = null;
    let engine = 'built-in';
    if (aip.hasKey) {
      try { spec = await askClaude(text); engine = 'Claude'; } catch (e) {
        bubble('ai', `Claude could not answer (${esc(e.message)}), so I used the built-in reader.`);
      }
    }
    if (spec) {
      if (aip.image && !spec.sky) spec.sky = { ...aip.image.palette, strength: 0.85 };
      aip.spec = spec;
    } else {
      const patch = AI.parsePrompt(text);
      if (aip.image) patch.sky = { ...pick(aip.image.palette), strength: 0.85 };
      aip.spec = AI.mergeSpec(aip.spec, patch);
    }
    if (AI.isEmptySpec(aip.spec)) {
      bubble('ai', "I couldn't find anything to change in that. Try things like <i>sunset sky</i>, <i>no water</i>, <i>no trees</i>, <i>FPS boost</i>, or attach an image.");
      return;
    }
    const files = await weatherFiles();
    const res = AI.buildPack(aip.spec, files);
    const tw = await api.call('tweaks:list');
    aip.result = { ...res, name: AI.packName(aip.spec), base: files, tweakInfo: tw };
    showResult();
    const lines = res.report.map((r) => `${r.ok ? '✓' : '!'} ${esc(r.text)}`);
    for (const [id, on] of Object.entries(res.tweaks)) {
      const t = tw.find((x) => x.id === id);
      const missing = t && on && !t.hasFiles;
      lines.push(missing ? `! ${esc(AI.WORLD_LABEL[id])}: needs its removal files loaded first (World page), so I can't switch it yet` : `✓ ${esc(AI.WORLD_LABEL[id])} → ${on ? 'removed' : 'visible'}`);
    }
    if (!Object.keys(files).length && (aip.spec.sky || aip.spec.grade || aip.spec.fps)) lines.push('! No timecycle files found in your citizen folder, so sky, grade and FPS changes could not be built. Link your citizen folder first.');
    bubble('ai', `Pack ready <small>(${engine})</small>: <b>${esc(aip.result.name)}</b><br>${lines.join('<br>')}<br><small>Preview on the right. Install it when you're happy.</small>`);
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
  $('#aip-spec').innerHTML = AI.describeSpec(aip.spec).map((c) => `<span class="tag">${esc(c)}</span>`).join('');
  $('#aip-report').innerHTML = r.report.map((x) => `<li class="${x.ok ? 'ok' : 'warn'}">${esc(x.text)}</li>`).join('');
  const hasWork = Object.keys(r.files).length || Object.keys(r.tweaks).length;
  $('#aip-install').disabled = !hasWork;
  $('#aip-edit').disabled = !Object.keys(r.files).length;
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
  const cv = $('#aip-canvas');
  if (pane !== 'ai') return;
  if (aip.preview) drawScene(cv, aip.preview, aip.hour);
  else { const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); }
  $('#aip-tag').textContent = TC.hourLabel(aip.hour);
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

async function installAi(btn) {
  const r = aip.result;
  if (!r) return;
  busy(btn, true);
  try {
    if (aip.installedId) { try { await api.call('tweaks:removeCustom', aip.installedId); } catch (e) { /* already gone */ } aip.installedId = null; }
    const out = await api.call('pack:create', r.name, r.files, r.tweaks);
    aip.installedId = out.id;
    const bits = [];
    if (out.id) bits.push(Object.keys(r.files).length + ' file(s) installed');
    if (out.applied.length) bits.push(out.applied.map((i) => AI.WORLD_LABEL[i]).join(', ') + ' switched');
    notify.success('Pack installed', (bits.join(' · ') || 'Done') + '. Restart FiveM to see it.');
    if (out.skipped.length) {
      bubble('ai', 'Installed, but I couldn\'t switch: ' + out.skipped.map((s) => `<b>${esc(AI.WORLD_LABEL[s.id] || s.id)}</b> (${esc(s.reason)})`).join('; ') + '. Load those files on the World page, then ask me again.');
      notify.warning('Some options were skipped', out.skipped.map((s) => AI.WORLD_LABEL[s.id] || s.id).join(', ') + ' need files first.');
    } else bubble('ai', `Installed <b>${esc(r.name)}</b>. It is in Graphics packs and every file is backed up, so you can switch it off any time.`);
    ctx.refreshGraphics && ctx.refreshGraphics();
  } catch (e) { notify.error('Could not install pack', e.message); }
  busy(btn, false);
}

async function editAiResult() {
  const r = aip.result;
  const rel = r && Object.keys(r.files)[0];
  if (!rel) return;
  ed.rel = rel; ed.name = rel.split('/').pop();
  ed.model = TC.parse(r.files[rel]);
  const secs = ed.model.sections.filter((s) => s.params.length);
  ed.sectionId = (secs.find((s) => /extrasunny|clear/i.test(s.label)) || secs[0] || {}).id || null;
  setPane('editor');
  notify.info('Opened in the editor', 'This is the AI version of ' + ed.name + '. Save it to FiveM or as a pack when you are done.');
}

function initAi() {
  $('#aip-examples').innerHTML = AI.EXAMPLES.map((e) => `<button class="chip" data-t="${esc(e)}">${esc(e)}</button>`).join('');
  $$('#aip-examples .chip').forEach((c) => (c.onclick = () => { $('#aip-text').value = c.dataset.t; $('#aip-text').focus(); }));
  $('#aip-send').onclick = generate;
  $('#aip-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } });
  $('#aip-attach').onclick = pickImage;
  $('#aip-img-clear').onclick = clearImage;
  $('#aip-reset').onclick = () => {
    aip.spec = AI.emptySpec(); aip.result = null; aip.preview = null; aip.installedId = null;
    clearImage(); greet(); $('#aip-examples').classList.remove('hidden'); $('#aip-spec').innerHTML = ''; $('#aip-report').innerHTML = '';
    $('#aip-install').disabled = true; $('#aip-edit').disabled = true; drawAi();
  };
  $('#aip-hour').addEventListener('input', (e) => { if (aip.playing) toggleAiPlay(); aip.hour = +e.target.value; drawAi(); });
  $('#aip-play').onclick = toggleAiPlay;
  $('#aip-install').onclick = (e) => installAi(e.currentTarget);
  $('#aip-edit').onclick = editAiResult;
  greet();
}

// ---------- settings: API key ----------
function initKey() {
  const btn = $('#ai-key-btn');
  if (!btn) return;
  btn.onclick = async () => {
    try {
      if (aip.hasKey) {
        if (!(await ctx.modal({ title: 'Remove the saved key?', text: 'Pack AI goes back to the built-in reader.', confirm: 'Remove', danger: true }))) return;
        await api.call('ai:setKey', '');
        notify.success('Key removed', 'Pack AI is using the built-in reader.');
      } else {
        const key = await ctx.modal({ title: 'Anthropic API key', text: 'Paste a key from console.anthropic.com. It is stored only on this PC and used only when you press Generate. Requests go straight to Anthropic.', confirm: 'Save key', input: { label: 'API key (sk-ant-…)', value: '' } });
        if (!key) return;
        await api.call('ai:setKey', key);
        notify.success('Key saved', 'Pack AI will use Claude from now on.');
      }
    } catch (e) { notify.error('Key not saved', e.message); }
    refreshAiEngine();
  };
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
  if (name === 'ai') { refreshAiEngine(); requestAnimationFrame(drawAi); }
  if (name === 'grade') ctx.refreshGraphics && ctx.refreshGraphics();
}

export function initStudio(c) {
  ctx = { ...ctx, ...c };
  $$('#gfx-tabs button').forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
  initEditor();
  initAi();
  initKey();
  refreshAiEngine();
}

/** Called each time the Graphics page opens. */
export function refreshStudio() {
  requestAnimationFrame(() => syncSeg($('#gfx-tabs')));
  if (pane === 'editor') enterEditor();
  if (pane === 'ai') { refreshAiEngine(); drawAi(); }
}

/** Files dropped on the Graphics page. Returns true when the studio took them. */
export async function handleDrop(paths) {
  const isImg = (p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p);
  if (paths.every(isImg)) {
    if (pane !== 'ai') setPane('ai');
    try { await attachImage(await api.call('gfx:readImage', paths[0])); } catch (e) { notify.error('Image not added', e.message); }
    return true;
  }
  if (pane === 'editor' && paths.length === 1 && /\.xml$/i.test(paths[0])) { await openExternal(paths[0]); return true; }
  return false;
}
