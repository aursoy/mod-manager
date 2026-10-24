// Sound Lab: browse .awc banks in audio RPFs, audition sounds, replace them
// with your own audio (volume / pitch / trim / fade), export or install.
import { notify } from './notify.js';
import { icon } from './icons.js';
import { fillRange, busy } from './fx.js';
import { needsKeys, ensureKeys, cleanError } from './keys.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CAT_LABEL = { guns: 'Gun', footsteps: 'Step', kill: 'Kill/HUD', other: 'Other' };
const DEFAULTS = { vol: 100, pitch: 100, trimStart: 0, maxLen: 10000, fade: 0 };
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i;

let state = { archives: [], banks: [] };
let cat = 'all';
let bankId = null;
let streams = [];
let streamId = null;
let current = null;   // { pcm:Int16Array, rate } currently stored for the stream
let original = null;  // original stream audio
let source = null;    // AudioBuffer from a user file
let sourceName = '';
let opts = { ...DEFAULTS };
let ac = null;
let playing = null;
const pcmCache = new Map();

// Listening volume: only affects playback here, never the exported sound.
let master = null;
let listenVol = (() => { try { const v = parseFloat(localStorage.getItem('kt.listenVol')); return Number.isFinite(v) ? v : 0.35; } catch (e) { return 0.35; } })();
const audio = () => {
  if (!ac) {
    ac = new AudioContext();
    master = ac.createGain();
    master.gain.value = listenVol * listenVol; // squared so the slider feels even
    master.connect(ac.destination);
  }
  return ac;
};

function setListenVol(v) {
  listenVol = v;
  if (master) master.gain.setTargetAtTime(v * v, ac.currentTime, 0.02);
  try { localStorage.setItem('kt.listenVol', String(v)); } catch (e) { /* ignore */ }
  $('#listen-pct').textContent = Math.round(v * 100) + '%';
  $('#listen-ic').innerHTML = icon(v === 0 ? 'mute' : 'volume');
}
const fmtTime = (s) => (s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(2) + ' s');

function toBuffer({ pcm, rate }) {
  const b = audio().createBuffer(1, Math.max(1, pcm.length), rate);
  const ch = b.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  return b;
}

function stop() {
  if (playing) { try { playing.src.stop(); } catch (e) { /* already stopped */ } }
  playing = null;
  $$('.pbtn.playing').forEach((b) => { b.classList.remove('playing'); b.innerHTML = icon('play'); });
  $('#playhead').classList.remove('on');
}

function play(buffer, btn, withHead) {
  stop();
  const ctx = audio();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(master);
  src.start();
  playing = { src, t0: ctx.currentTime, dur: buffer.duration };
  if (btn) { btn.classList.add('playing'); btn.innerHTML = icon('pause'); }
  src.onended = () => { if (playing && playing.src === src) stop(); };
  if (withHead) {
    const head = $('#playhead');
    head.classList.add('on');
    const tick = () => {
      if (!playing || playing.src !== src) return;
      const k = Math.min(1, (ctx.currentTime - playing.t0) / playing.dur);
      head.style.transform = `translateX(${k * $('#wave').clientWidth}px)`;
      requestAnimationFrame(tick);
    };
    tick();
  }
}

async function fetchPcm(bId, sId, orig = false) {
  const key = bId + ':' + sId + ':' + (orig ? 'o' : 'c');
  if (!pcmCache.has(key)) pcmCache.set(key, await api.call('sound:pcm', bId, sId, orig));
  return pcmCache.get(key);
}
const dropCache = (bId, sId) => pcmCache.delete(bId + ':' + sId + ':c');

// ---------- waveform ----------
function drawWave(data) {
  const c = $('#wave');
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const mid = c.height / 2;
  g.fillStyle = 'rgba(255,255,255,.08)';
  g.fillRect(0, mid, c.width, 1);
  if (!data || !data.length) return;
  const per = data.length / c.width;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.5, 'rgba(255,255,255,.85)'); grad.addColorStop(1, '#fff');
  g.fillStyle = grad;
  for (let x = 0; x < c.width; x++) {
    let mn = 1, mx = -1;
    const a = Math.floor(x * per), b = Math.min(data.length, Math.floor((x + 1) * per) + 1);
    for (let i = a; i < b; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn > mx) continue;
    g.fillRect(x, mid - mx * mid * 0.92, 1, Math.max(1, (mx - mn) * mid * 0.92));
  }
}

const asFloat = (pcm) => Float32Array.from(pcm, (v) => v / 32768);

// ---------- processing ----------
async function render() {
  const base = source || (original && toBuffer(original));
  if (!base) throw new Error('Pick a sound first.');
  const rate = original ? original.rate : base.sampleRate;
  const pitch = opts.pitch / 100;
  const start = Math.min(base.duration - 0.01, opts.trimStart / 1000);
  const len = Math.max(0.02, Math.min(opts.maxLen / 1000, (base.duration - start) / pitch));
  const off = new OfflineAudioContext(1, Math.ceil(len * rate), rate);
  const src = off.createBufferSource();
  src.buffer = base;
  src.playbackRate.value = pitch;
  const gain = off.createGain();
  const vol = opts.vol / 100;
  gain.gain.setValueAtTime(vol, 0);
  if (opts.fade > 0) {
    const f = Math.min(len, opts.fade / 1000);
    gain.gain.setValueAtTime(vol, len - f);
    gain.gain.linearRampToValueAtTime(0, len);
  }
  src.connect(gain).connect(off.destination);
  src.start(0, start);
  const out = await off.startRendering();
  const ch = out.getChannelData(0);
  const pcm = new Int16Array(ch.length);
  let clipped = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = Math.max(-1, Math.min(1, ch[i]));
    if (v !== ch[i]) clipped++;
    pcm[i] = Math.round(v * 32767);
  }
  return { pcm, rate, buffer: out, clipped };
}

const isDirty = () => !!source || Object.keys(DEFAULTS).some((k) => opts[k] !== DEFAULTS[k]);

// ---------- rendering lists ----------
function renderArchives() {
  $('#snd-archives').innerHTML = state.archives.map((a) => `
    <div class="arch">${icon('package')}<b title="${esc(a.file)}">${esc(a.name)}</b><small>${a.banks}</small><button data-close="${a.id}" title="Close">${icon('x')}</button></div>`).join('')
    + `<div class="arch add" id="snd-add">${icon('plus')}Add archive</div>`;
  $$('[data-close]').forEach((b) => (b.onclick = async () => {
    state = await api.call('sound:close', +b.dataset.close);
    if (!state.archives.length) return showEmpty();
    if (!state.banks.some((x) => x.id === bankId)) { bankId = null; streams = []; renderStreams(); }
    refreshAll();
  }));
  $('#snd-add').onclick = browse;
  renderExports();
}

function renderBanks() {
  const q = $('#bank-search').value.trim().toLowerCase();
  const list = state.banks.filter((b) => (cat === 'all' || b.category === cat) && (!q || b.name.toLowerCase().includes(q) || (b.gun || '').toLowerCase().includes(q) || b.path.toLowerCase().includes(q)))
    // guns first, sorted by gun name, so the same gun's banks sit together
    .sort((a, b) => (a.gun ? 0 : 1) - (b.gun ? 0 : 1) || (a.gun || a.name).localeCompare(b.gun || b.name));
  $('#bank-list').innerHTML = list.length
    ? list.slice(0, 600).map((b) => `<li data-id="${b.id}" class="${b.id === bankId ? 'on' : ''}" title="${esc(b.path)}"><span class="tag">${CAT_LABEL[b.category]}</span><b>${esc(b.gun || b.name)}${b.gun ? `<small class="bank-raw">${esc(b.name)}</small>` : ''}</b>${b.edits ? '<i class="ed"></i>' : ''}</li>`).join('')
      + (list.length > 600 ? `<li class="empty">${list.length - 600} more. Search to narrow.</li>` : '')
    : '<li class="empty">No banks match.</li>';
  $$('#bank-list li[data-id]').forEach((li) => (li.onclick = () => selectBank(+li.dataset.id)));
}

function renderStreams() {
  const b = state.banks.find((x) => x.id === bankId);
  $('#bank-title').textContent = b ? (b.gun ? b.gun + ' sounds' : b.name) : 'Pick a bank';
  $('#bank-meta').textContent = b ? `${streams.length} sound(s) · ${b.gun ? b.name + ' · ' : ''}${b.path}` : '';
  const longest = Math.max(0.001, ...streams.map((s) => s.seconds));
  $('#stream-list').innerHTML = streams.length
    ? streams.map((s, i) => `<li data-id="${s.id}" class="${s.id === streamId ? 'on' : ''}" style="animation-delay:${Math.min(i, 20) * 20}ms">
        <button class="pbtn" data-play="${s.id}" ${s.playable ? '' : 'disabled'}>${icon('play')}</button>
        <div><b>${s.gun ? esc(s.gun) + ' shot' : (b && b.gun ? esc(b.gun) + ' · sound ' + (i + 1) : 'Sound ' + (i + 1))}</b> <small class="mono">${s.hex}</small>${s.edited ? ' <span class="tag solid">Edited</span>' : ''}<br><small>${fmtTime(s.seconds)} · ${s.rate} Hz · ${s.codec}</small></div>
        <span class="dur"><i style="width:${(s.seconds / longest) * 100}%"></i></span>
        <span></span>
      </li>`).join('')
    : `<li class="empty">${b ? 'No playable sounds in this bank.' : 'Choose a bank on the left.'}</li>`;
  $$('#stream-list li[data-id]').forEach((li) => (li.onclick = (e) => { if (!e.target.closest('.pbtn')) selectStream(+li.dataset.id); }));
  $$('#stream-list [data-play]').forEach((btn) => (btn.onclick = async () => {
    if (btn.classList.contains('playing')) return stop();
    try { play(toBuffer(await fetchPcm(bankId, +btn.dataset.play)), btn, +btn.dataset.play === streamId); }
    catch (e) { notify.error('Cannot play', e.message); }
  }));
}

function renderExports() {
  $('#snd-export-list').innerHTML = state.archives.map((a) => `
    <div class="exp"><b>${esc(a.name)}</b><span class="tag ${a.edits ? 'solid' : ''}">${a.edits} edit${a.edits === 1 ? '' : 's'}</span>
      <button class="btn ghost sm" data-exp="${a.id}" title="Save as .rpf">${icon('download')}</button>
      <button class="btn primary sm" data-inst="${a.id}" title="Install to citizen/platform/audio/sfx">${icon('zap')}Install</button></div>`).join('');
  $$('[data-exp]').forEach((b) => (b.onclick = () => exportArchive(+b.dataset.exp, false, b)));
  $$('[data-inst]').forEach((b) => (b.onclick = () => exportArchive(+b.dataset.inst, true, b)));
}

function refreshAll() { renderArchives(); renderBanks(); renderStreams(); }

// ---------- selection ----------
async function selectBank(id) {
  bankId = id;
  streamId = null;
  $$('#bank-list li').forEach((li) => li.classList.toggle('on', +li.dataset.id === id));
  try {
    const r = await api.call('sound:streams', id);
    streams = r.streams;
    if (r.multichannel) notify.info('Music / stream bank', 'Multi-channel banks can be played back but not edited.');
  } catch (e) {
    streams = [];
    notify.error('Could not read bank', e.message);
  }
  renderStreams();
  resetInspector();
}

function resetInspector() {
  source = null; sourceName = ''; original = null; current = null;
  opts = { ...DEFAULTS };
  syncControls();
  $('#snd-title').textContent = 'Nothing selected';
  $('#snd-meta').textContent = '';
  drawWave(null);
}

async function selectStream(id) {
  streamId = id;
  $$('#stream-list li').forEach((li) => li.classList.toggle('on', +li.dataset.id === id));
  const s = streams.find((x) => x.id === id);
  source = null; sourceName = ''; opts = { ...DEFAULTS };
  syncControls();
  $('#snd-title').textContent = 'Sound ' + s.hex;
  $('#snd-meta').textContent = `${fmtTime(s.seconds)} · ${s.rate} Hz · ${s.codec}${s.edited ? ' · edited' : ''}`;
  if (!s.playable) { drawWave(null); return notify.warning('Codec not supported', s.codec + ' sounds cannot be decoded here.'); }
  try {
    original = await fetchPcm(bankId, id, true);
    current = await fetchPcm(bankId, id);
    drawWave(asFloat(current.pcm));
  } catch (e) { notify.error('Could not decode', e.message); }
}

function syncControls() {
  $$('[data-s]').forEach((el) => { el.value = opts[el.dataset.s]; fillRange(el); });
  const lab = (k) => $(`[data-so="${k}"]`);
  lab('vol').textContent = opts.vol + '%';
  lab('pitch').textContent = opts.pitch + '%';
  lab('trimStart').textContent = opts.trimStart + ' ms';
  lab('maxLen').textContent = opts.maxLen >= 10000 ? 'full' : opts.maxLen + ' ms';
  lab('fade').textContent = opts.fade + ' ms';
  $('#snd-src').textContent = sourceName ? '↳ ' + sourceName : 'Replace with your sound';
  $('#snd-replace').classList.toggle('has', !!sourceName);
}

let previewTimer = 0;
function schedulePreviewWave() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (streamId === null || !(source || original)) return;
    try { const r = await render(); drawWave(r.buffer.getChannelData(0)); } catch (e) { /* ignore */ }
  }, 120);
}

async function loadSource({ name, data }) {
  if (streamId === null) return notify.warning('Pick a sound first', 'Select the sound you want to replace, then drop your file.');
  try {
    source = await audio().decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    sourceName = name;
    syncControls();
    schedulePreviewWave();
    notify.success('Sound loaded', `${name} · ${source.duration.toFixed(2)} s. Preview it, then Apply.`);
  } catch (e) {
    notify.error('Could not decode audio', name + ' is not a supported audio file.');
  }
}

// ---------- actions ----------
async function apply(btn) {
  if (streamId === null) return notify.warning('Pick a sound first', 'Select a sound in the list.');
  if (!isDirty()) return notify.info('Nothing to apply', 'Load a sound or move a slider first.');
  busy(btn, true);
  try {
    const r = await render();
    const res = await api.call('sound:replace', bankId, streamId, r.pcm, r.rate);
    streams = res.streams;
    dropCache(bankId, streamId);
    current = { pcm: r.pcm, rate: r.rate };
    state = await api.call('sound:state');
    source = null; sourceName = ''; opts = { ...DEFAULTS };
    syncControls();
    renderStreams(); renderBanks(); renderExports();
    drawWave(asFloat(current.pcm));
    notify.success('Sound replaced', `${(r.pcm.length / r.rate).toFixed(2)} s at ${r.rate} Hz.${r.clipped ? ' Some peaks clipped — lower the volume if it crackles.' : ''}`);
  } catch (e) { notify.error('Could not apply', e.message); }
  busy(btn, false);
}

async function revert() {
  if (streamId === null) return;
  const res = await api.call('sound:revert', bankId, streamId);
  streams = res.streams;
  dropCache(bankId, streamId);
  state = await api.call('sound:state');
  renderStreams(); renderBanks(); renderExports();
  selectStream(streamId);
  notify.info('Sound reverted', 'Back to the original.');
}

async function exportArchive(id, toCitizen, btn) {
  const a = state.archives.find((x) => x.id === id);
  if (!a.edits) return notify.info('No edits yet', 'Replace at least one sound in ' + a.name + ' first.');
  busy(btn, true);
  const h = notify({ type: 'loading', title: toCitizen ? 'Installing sound pack…' : 'Exporting sound pack…', message: a.name });
  try {
    const r = await api.call('sound:export', id, { toCitizen });
    if (!r) { h.close(); busy(btn, false); return; }
    h.update({
      type: 'success',
      title: toCitizen ? 'Sound pack installed' : 'Sound pack exported',
      message: `${r.path.split(/[\\/]/).pop()} · ${(r.bytes / 1048576).toFixed(1)} MB${toCitizen ? '. Restart FiveM to hear it.' : ''}`,
      action: { label: 'Show in folder', fn: () => api.call('shell:reveal', r.path) },
      duration: 9000,
    });
  } catch (e) { h.update({ type: 'error', title: 'Export failed', message: e.message }); }
  busy(btn, false);
}

// ---------- open ----------
function showEmpty() {
  $('#snd-lab').classList.add('hidden');
  $('#snd-empty').classList.remove('hidden');
}

export async function openSoundFiles(paths) {
  const rpfs = paths.filter((p) => /\.rpf$/i.test(p));
  if (!rpfs.length) return;
  const h = notify({ type: 'loading', title: 'Opening sound archives…', message: rpfs.map((p) => p.split(/[\\/]/).pop()).join(', ') });
  try {
    state = await api.call('sound:open', rpfs);
  } catch (e) {
    if (needsKeys(e)) {
      h.close();
      if (await ensureKeys('This sound pack is encrypted by Rockstar (NG).')) return openSoundFiles(paths);
      return;
    }
    h.update({ type: 'error', title: 'Could not open', message: cleanError(e.message) });
    return;
  }
  $('#snd-empty').classList.add('hidden');
  $('#snd-lab').classList.remove('hidden');
  refreshAll();
  const counts = state.banks.reduce((m, b) => ((m[b.category] = (m[b.category] || 0) + 1), m), {});
  h.update({ type: 'success', title: `${state.banks.length} sound banks loaded`, message: `${counts.guns || 0} gun · ${counts.footsteps || 0} footstep · ${counts.kill || 0} kill/HUD · ${counts.other || 0} other` });
}

async function browse() { const f = await api.call('sound:pick'); if (f) openSoundFiles(f); }

export async function handleSoundDrop(paths) {
  const rpfs = paths.filter((p) => /\.rpf$/i.test(p));
  const aud = paths.find((p) => AUDIO_EXT.test(p));
  if (rpfs.length) await openSoundFiles(rpfs);
  if (aud) loadSource(await api.call('sound:readAudio', aud));
  if (!rpfs.length && !aud) notify.info('Unsupported file', 'Drop .rpf sound archives or .wav / .mp3 / .ogg audio.');
}

export function initSoundLab() {
  const lv = $('#listen-vol');
  lv.value = Math.round(listenVol * 100);
  fillRange(lv);
  setListenVol(listenVol);
  lv.addEventListener('input', () => setListenVol(lv.value / 100));
  let before = listenVol || 0.35;
  $('#listen-ic').onclick = () => {
    if (listenVol > 0) { before = listenVol; lv.value = 0; } else lv.value = Math.round(before * 100);
    fillRange(lv);
    setListenVol(lv.value / 100);
  };
  $('#snd-browse').onclick = browse;
  $('#snd-drop').onclick = (e) => { if (!e.target.closest('button')) browse(); };
  $$('#snd-cats button').forEach((b) => (b.onclick = () => {
    cat = b.dataset.cat;
    $$('#snd-cats button').forEach((x) => x.classList.toggle('on', x === b));
    renderBanks();
  }));
  $('#bank-search').addEventListener('input', renderBanks);
  $$('[data-s]').forEach((el) => el.addEventListener('input', () => {
    opts[el.dataset.s] = +el.value;
    syncControls();
    schedulePreviewWave();
  }));
  $('#snd-replace').onclick = async () => { const f = await api.call('sound:pickAudio'); if (f) loadSource(f); };
  $('#play-orig').onclick = () => { if (original) play(toBuffer(original), null, true); };
  $('#play-new').onclick = async () => {
    try { const r = await render(); play(r.buffer, null, true); } catch (e) { notify.warning('Nothing to preview', e.message); }
  };
  $('#snd-apply').onclick = (e) => apply(e.currentTarget);
  $('#snd-revert').onclick = revert;
  new ResizeObserver(() => { if (current) drawWave(asFloat(current.pcm)); }).observe($('.wave-box'));
}
