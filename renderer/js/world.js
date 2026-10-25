// World page: Water, Black mountains and Player detail (visualsettings.dat), Snow (weather.xml), the
// visual settings editor, and any custom tweaks the player added.
import { notify } from './notify.js';
import { icon } from './icons.js';
import { stagger, syncSeg, fillRange, busy } from './fx.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (v == null ? '' : String(Number(Number(v).toFixed(4))));

let ctx = null;
const vs = { entries: [], edits: {}, q: '', open: false };

const seg = (on, off, onLabel, offLabel) => `<div class="seg"><button data-v="off" class="${on ? '' : 'on'}">${esc(offLabel)}</button><button data-v="on" class="${on ? 'on' : ''}">${esc(onLabel)}</button><i class="seg-thumb"></i></div>`;

function tweakCard(t) {
  return `<div class="card tweak ${t.enabled ? 'on' : ''}" data-id="${t.id}">
    <div class="tweak-top">
      <div class="tweak-icon"><div class="wave"></div>${icon(t.id === 'water' ? 'droplet' : 'layers')}</div>
      <div><span class="big-state">${esc(t.enabled ? t.onLabel : t.offLabel)}</span><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p></div>
    </div>
    <div class="files">${esc(t.files.slice(0, 3).join('  ·  ')) + (t.files.length > 3 ? '  +' + (t.files.length - 3) : '')}</div>
    <div class="state">${seg(t.enabled, !t.enabled, t.onLabel, t.offLabel)}
      <div class="head-actions">
        <button class="btn ghost sm" data-act="load">${icon('upload')}${t.id === 'water' ? 'Custom water.xml' : 'Replace files'}</button>
        ${t.builtin ? '' : `<button class="icon-btn" data-act="remove" title="Remove">${icon('trash')}</button>`}
      </div>
    </div></div>`;
}

function mountainsCard(m) {
  if (!m || !m.available) {
    return `<div class="card tweak unset" data-world="mountains"><div class="tweak-top"><div class="tweak-icon">${icon('mountain')}</div>
      <div><span class="big-state">Not found</span><h3>Black mountains</h3><p>Link your citizen folder first.</p></div></div></div>`;
  }
  const far = m.value != null;
  return `<div class="card tweak ${m.removed ? 'on' : ''}" data-world="mountains">
    <div class="tweak-top"><div class="tweak-icon"><div class="wave"></div>${icon('mountain')}</div>
      <div><span class="big-state">${m.removed ? 'Removed' : 'Visible'}</span><h3>Black mountains</h3>
      <p>Hides the dark mountains far away.</p></div></div>
    ${far ? `<div class="slider-field"><span>Draw distance <b id="mtn-val">${fmt(m.value)}×</b></span><input type="range" id="mtn-dist" min="0.1" max="2" step="0.05" value="${m.value}" /></div>` : ''}
    ${m.packKeys.length ? `<div class="mtn-keys"><p class="label">Your pack's "${esc(m.packKeys[0].section)}" lines</p>${m.packKeys.map((k) => `<label class="mtn-key"><span class="mono">${esc(k.key)}</span><input type="number" step="any" data-key="${esc(k.key)}" value="${fmt(k.value)}" /></label>`).join('')}</div>` : ''}
    <div class="state">${seg(m.removed, !m.removed, 'Removed', 'Visible')}<span class="fine">${far ? 'Original: ' + fmt(m.original) + '×' : ''}</span></div>
  </div>`;
}

function pedCard(p) {
  if (!p || !p.available) {
    return `<div class="card tweak unset" data-world="ped"><div class="tweak-top"><div class="tweak-icon">${icon('user')}</div>
      <div><span class="big-state">Not found</span><h3>Player detail distance</h3><p>Link your citizen folder first.</p></div></div></div>`;
  }
  const m = (v) => (v == null ? '?' : fmt(v) + ' m');
  return `<div class="card tweak ${p.on ? 'on' : ''}" data-world="ped">
    <div class="tweak-top"><div class="tweak-icon"><div class="wave"></div>${icon('user')}</div>
      <div><span class="big-state">${p.on ? 'Fixed' : 'Default'}</span><h3>Player detail distance</h3>
      <p>Stops players a few metres away turning into low-detail models.</p></div></div>
    <div class="state">${seg(p.on, !p.on, 'Fixed', 'Default')}<span class="fine">Full detail up to: ${m(p.now)}</span></div>
  </div>`;
}

function snowCard(sn) {
  if (!sn || !sn.available) {
    return `<div class="card tweak unset" data-world="snow"><div class="tweak-top"><div class="tweak-icon">${icon('snow')}</div>
      <div><span class="big-state">Not found</span><h3>Snow</h3><p>Link your citizen folder first.</p></div></div></div>`;
  }
  return `<div class="card tweak ${sn.on ? 'on' : ''}" data-world="snow">
    <div class="tweak-top"><div class="tweak-icon"><div class="wave"></div>${icon('snow')}</div>
      <div><span class="big-state">${sn.on ? 'On' : 'Off'}</span><h3>Snow</h3>
      <p>Snow on the ground and in the air, in every weather.</p></div></div>
    <div class="slider-field"><span>Amount <b id="snow-val">${Math.round((sn.on ? sn.amount : 1) * 100)}%</b></span><input type="range" id="snow-amt" min="5" max="100" value="${Math.round((sn.on ? sn.amount : 1) * 100)}" /></div>
    <div class="state">${seg(sn.on, !sn.on, 'On', 'Off')}<span></span></div>
  </div>`;
}

function cloudsCard(c) {
  if (!c || !c.available) {
    return `<div class="card tweak unset" data-world="clouds"><div class="tweak-top"><div class="tweak-icon">${icon('cloud')}</div>
      <div><span class="big-state">Not found</span><h3>Still clouds</h3><p>Link your citizen folder first.</p></div></div></div>`;
  }
  return `<div class="card tweak ${c.on ? 'on' : ''}" data-world="clouds">
    <div class="tweak-top"><div class="tweak-icon"><div class="wave"></div>${icon('cloud')}</div>
      <div><span class="big-state">${c.on ? 'Still' : 'Moving'}</span><h3>Still clouds</h3>
      <p>The clouds stop drifting and spinning across the sky. Works with any graphics pack.</p></div></div>
    <div class="state">${seg(c.on, !c.on, 'Still', 'Moving')}<span></span></div>
  </div>`;
}

function vsCard(v) {
  if (!v || !v.available) return '';
  return `<div class="card vs-card span-2" id="vs-card">
    <div class="row-between"><div><h3>Visual settings</h3><small class="fine">Every line of <code>visualsettings.dat</code>.</small></div>
      <div class="head-actions"><label class="search"><i>${icon('search')}</i><input type="text" id="vs-search" placeholder="Search, e.g. lod, farclip, fog" value="${esc(vs.q)}" /></label>
      <button class="btn ghost sm" id="vs-reset" ${v.edited ? '' : 'disabled'}>${icon('undo')}Reset</button><button class="btn primary sm" id="vs-save" disabled>${icon('save')}Save</button></div></div>
    <ul class="vs-list" id="vs-list"></ul></div>`;
}

function renderVsList() {
  const q = vs.q.trim().toLowerCase();
  const list = vs.entries.filter((e) => !q || e.key.toLowerCase().includes(q) || e.section.toLowerCase().includes(q));
  let last = null;
  $('#vs-list').innerHTML = list.slice(0, 400).map((e) => {
    const head = e.section !== last ? `<li class="vs-sec">${esc(e.section || '—')}</li>` : '';
    last = e.section;
    const val = e.key in vs.edits ? vs.edits[e.key] : e.value;
    return head + `<li class="vs-row ${e.key in vs.edits ? 'dirty' : ''}"><span class="mono">${esc(e.key)}</span><input type="number" step="any" data-key="${esc(e.key)}" value="${fmt(val)}" /></li>`;
  }).join('') + (list.length > 400 ? `<li class="vs-sec">${list.length - 400} more, search to narrow down</li>` : '') || '<li class="vs-sec">Nothing matches.</li>';
  $$('#vs-list input').forEach((inp) => inp.addEventListener('input', () => {
    const e = vs.entries.find((x) => x.key === inp.dataset.key);
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v) || v === e.value) delete vs.edits[e.key]; else vs.edits[e.key] = v;
    inp.closest('li').classList.toggle('dirty', e.key in vs.edits);
    $('#vs-save').disabled = !Object.keys(vs.edits).length;
    $('#vs-save').innerHTML = icon('save') + 'Save' + (Object.keys(vs.edits).length ? ' (' + Object.keys(vs.edits).length + ')' : '');
  }));
}

async function setMountains(opts, btn) {
  try {
    const m = await api.call('world:setMountains', opts);
    notify.success(m.removed ? 'Black mountains removed' : 'Black mountains back', 'Restart FiveM to see it.');
  } catch (e) { notify.error('Could not change black mountains', e.message); }
  if (btn) busy(btn, false);
  refreshWorld();
}

export async function refreshWorld() {
  const grid = $('#world-grid');
  const [tweaks, m, p, sn, cl, v] = await Promise.all([
    api.call('tweaks:list').catch(() => []),
    api.call('world:mountains').catch(() => null),
    api.call('world:pedLod').catch(() => null),
    api.call('world:snow').catch(() => null),
    api.call('world:clouds').catch(() => null),
    api.call('world:visual').catch(() => null),
  ]);
  const own = tweaks.filter((t) => t.kind !== 'pack');
  const water = own.find((t) => t.id === 'water');
  vs.entries = v && v.entries ? v.entries : [];
  vs.edits = {};
  grid.innerHTML = (water ? tweakCard(water) : '') + pedCard(p) + mountainsCard(m) + snowCard(sn) + cloudsCard(cl) + own.filter((t) => t.id !== 'water').map(tweakCard).join('') + vsCard(v);
  stagger(grid);
  requestAnimationFrame(() => $$('.seg', grid).forEach(syncSeg));
  $$('input[type=range]', grid).forEach(fillRange);

  // file tweaks (water, custom)
  $$('.tweak[data-id]', grid).forEach((card) => {
    const t = own.find((x) => x.id === card.dataset.id);
    $$('.seg button', card).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.v === 'on';
      if (on === t.enabled) return;
      $$('.seg button', card).forEach((x) => x.classList.toggle('on', x === b)); syncSeg($('.seg', card));
      await ctx.toggleTweak(t, on);
      setTimeout(refreshWorld, 400);
    }));
    $('[data-act=load]', card).onclick = async () => {
      const files = await api.call('pick:files', { title: 'Select files for ' + t.name });
      if (files) ctx.loadTweakFiles(t, files);
    };
    const rm = $('[data-act=remove]', card);
    if (rm) rm.onclick = async () => {
      if (!(await ctx.modal({ title: 'Remove "' + t.name + '"?', text: 'Its files are removed from citizen and originals restored.', confirm: 'Remove', danger: true }))) return;
      await api.call('tweaks:removeCustom', t.id).catch((e) => notify.error('Remove failed', e.message));
      refreshWorld();
    };
  });

  // black mountains
  const mc = $('[data-world=mountains]', grid);
  if (m && m.available) {
    $$('.seg button', mc).forEach((b) => (b.onclick = () => setMountains({ removed: b.dataset.v === 'on' })));
    const dist = $('#mtn-dist');
    if (dist) {
      dist.addEventListener('input', () => { $('#mtn-val').textContent = fmt(dist.value) + '×'; });
      dist.addEventListener('change', () => setMountains({ removed: +dist.value < m.original, distance: +dist.value }));
    }
    $$('.mtn-key input', mc).forEach((inp) => inp.addEventListener('change', () => {
      const keys = Object.fromEntries($$('.mtn-key input', mc).map((x) => [x.dataset.key, parseFloat(x.value)]).filter(([, val]) => Number.isFinite(val)));
      setMountains({ removed: true, distance: dist ? +dist.value : undefined, keys });
    }));
  }

  // player detail distance
  const pc = $('[data-world=ped]', grid);
  if (p && p.available) {
    $$('.seg button', pc).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.v === 'on';
      if (on === p.on) return;
      try {
        const r = await api.call('world:setPedLod', on);
        notify.success(r.on ? 'Player detail fixed' : 'Player detail back to default', r.on ? 'Players keep their full model out to ' + fmt(r.now) + ' m. Restart FiveM to see it.' : 'visualsettings.dat is back to how it was.');
      } catch (e) { notify.error('Could not change player detail', e.message); }
      refreshWorld();
    }));
  }

  // snow
  const sc = $('[data-world=snow]', grid);
  if (sn && sn.available) {
    const amt = $('#snow-amt');
    const apply = async (on) => {
      try {
        const r = await api.call('world:setSnow', on ? amt.value / 100 : 0);
        notify.success(r.on ? 'Snow on' : 'Snow off', r.on ? 'Every weather now has snow. Restart FiveM to see it.' : 'weather.xml is back to how it was.');
      } catch (e) { notify.error('Could not change snow', e.message); }
      refreshWorld();
    };
    $$('.seg button', sc).forEach((b) => (b.onclick = () => apply(b.dataset.v === 'on')));
    amt.addEventListener('input', () => { $('#snow-val').textContent = amt.value + '%'; });
    amt.addEventListener('change', () => { if (sn.on) apply(true); });
  }

  // still clouds
  const cc = $('[data-world=clouds]', grid);
  if (cl && cl.available) {
    $$('.seg button', cc).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.v === 'on';
      if (on === cl.on) return;
      try {
        const r = await api.call('world:setClouds', on);
        notify.success(r.on ? 'Clouds stopped' : 'Clouds moving again', r.on ? 'The clouds stay where they are. Restart FiveM to see it.' : 'clouds.xml is back to how it was.');
      } catch (e) { notify.error('Could not change the clouds', e.message); }
      refreshWorld();
    }));
  }

  // visual settings editor
  if (v && v.available) {
    renderVsList();
    $('#vs-search').addEventListener('input', (e) => { vs.q = e.target.value; renderVsList(); });
    $('#vs-save').onclick = async (e) => {
      busy(e.currentTarget, true);
      try { await api.call('world:saveVisual', vs.edits); notify.success('Visual settings saved', Object.keys(vs.edits).length + ' line(s) changed. Restart FiveM to see it.'); }
      catch (err) { notify.error('Could not save', err.message); }
      refreshWorld();
    };
    $('#vs-reset').onclick = async () => {
      if (!(await ctx.modal({ title: 'Reset visual settings?', text: 'Every line you changed here goes back to how it was.', confirm: 'Reset', danger: true }))) return;
      await api.call('world:resetVisual').catch((e) => notify.error('Reset failed', e.message));
      refreshWorld();
    };
  }
}

export function initWorldPage(c) { ctx = c; }
