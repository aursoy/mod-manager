// Mod Maker: the player describes a mod, their AI plans the file changes, the app
// builds them from the game's own files (see src/core/modmaker.js), then installs
// them or saves them as an .rpf.
import { notify } from './notify.js';
import { busy } from './fx.js';
import { paintUsage } from './aiusage.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const mk = { plan: null, mod: null, busy: false };
let ctx = { go: null };

function say(who, html) {
  const log = $('#mk-log');
  log.insertAdjacentHTML('beforeend', `<div class="msg ${who}">${html}</div>`);
  log.scrollTop = log.scrollHeight;
  return log.lastElementChild;
}

function paintResult() {
  const m = mk.mod;
  $('#mk-name').textContent = m ? m.name : 'Nothing yet';
  $('#mk-count').textContent = (m ? m.done.length : 0) + ' change' + (m && m.done.length === 1 ? '' : 's');
  $('#mk-count').classList.toggle('solid', !!(m && m.done.length));
  $('#mk-report').innerHTML = m
    ? m.done.map((d) => `<li>${esc(d)}</li>`).join('') + m.skipped.map((d) => `<li class="skip">${esc(d)}</li>`).join('') || '<li class="warn">No changes.</li>'
    : '<li class="warn">Ask for a mod on the left.</li>';
  $('#mk-files').textContent = m && m.files.length ? 'Files: ' + m.files.join(', ') : '';
  const has = !!(m && m.files.length);
  $('#mk-install').disabled = !has;
  $('#mk-rpf').disabled = !has;
}

async function send(text) {
  text = String(text || '').trim();
  if (!text || mk.busy) return;
  mk.busy = true;
  $('#mk-input').value = '';
  say('user', esc(text));
  const wait = say('ai', '<small>Making your mod…</small>');
  busy($('#mk-send'), true);
  try {
    const r = await api.call('mod:ask', text, mk.plan);
    mk.plan = r.plan; mk.mod = r.mod;
    const has = r.mod && r.mod.files.length;
    wait.innerHTML = esc(r.reply) + (has
      ? `<div class="mk-acts"><button class="btn primary sm" data-a="rpf">Save as .rpf</button><button class="btn ghost sm" data-a="install">Install</button></div>`
      : '<br><small>Nothing could be built from that, see the list on the right.</small>');
    if (has) {
      wait.querySelector('[data-a=rpf]').onclick = (e) => saveRpf(e.currentTarget);
      wait.querySelector('[data-a=install]').onclick = (e) => install(e.currentTarget);
    }
    paintResult();
    // asked for an rpf: open the save window straight away
    if (has && /\brpf\b|\.rpf|compile|export|file/i.test(text)) saveRpf(wait.querySelector('[data-a=rpf]'));
  } catch (e) {
    wait.innerHTML = '<small>' + esc(e.message) + '</small>';
  }
  busy($('#mk-send'), false);
  mk.busy = false;
  paintUsage($('#mk-usage'));
}

export async function refreshMaker() {
  const cfg = await api.call('ai:config').catch(() => null);
  const on = !!(cfg && (cfg.hasKey || cfg.url) && cfg.on !== false);
  $('#mk-off').classList.toggle('hidden', on);
  $('#mk-input').disabled = !on;
  $('#mk-send').disabled = !on;
  paintUsage($('#mk-usage'));
  if (!$('#mk-log').children.length) say('ai', 'Tell me what mod you want: more FPS, no lightning, a clear view, longer draw distance… I build it from your own game files.');
}

export function initMaker(c) {
  ctx = { ...ctx, ...c };
  $('#mk-send').onclick = () => send($('#mk-input').value);
  $('#mk-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#mk-input').value); } });
  $$('#mk-chips .chip').forEach((b) => (b.onclick = () => send(b.textContent)));
  $('#mk-settings').onclick = () => ctx.go && ctx.go('settings');
  $('#mk-new').onclick = () => { mk.plan = null; mk.mod = null; $('#mk-log').innerHTML = ''; paintResult(); refreshMaker(); };
  $('#mk-install').onclick = (e) => install(e.currentTarget);
  $('#mk-rpf').onclick = (e) => saveRpf(e.currentTarget);
  paintResult();
}

async function install(btn) {
  busy(btn, true);
  try {
    const r = await api.call('mod:install');
    notify.success('"' + r.name + '" installed', (r.conflicts.length ? 'It replaced files another mod had (' + r.conflicts.length + '). ' : '') + 'Restart FiveM to see it. Switch it off on the Mods page.');
  } catch (err) { notify.error('Could not install', err.message); }
  busy(btn, false);
}

async function saveRpf(btn) {
  busy(btn, true);
  try {
    const r = await api.call('mod:saveRpf');
    if (r) notify.success('Saved', r.path.split(/[\\/]/).pop() + ' · ' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB', { action: { label: 'Show in folder', fn: () => api.call('shell:reveal', r.path) } });
  } catch (err) { notify.error('Could not save', err.message); }
  busy(btn, false);
}
