// Notification system: stacked glass toasts with progress, swipe-to-dismiss,
// hover-pause, actions, promise toasts, sounds, and a history drawer.
import { icon } from './icons.js';

const ICONS = { success: 'check', error: 'x-circle', warning: 'alert', info: 'info', loading: 'info' };
const MAX = 5;
const host = () => document.getElementById('toasts');
const history = [];
let unread = 0;
let audio = null;

export const settings = { sound: true };

function ctx() {
  audio = audio || new AudioContext();
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}

/** Soft click for moving between pages (same switch as notification sounds). */
export function navSound() {
  if (!settings.sound) return;
  try {
    const a = ctx();
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1180, t);
    o.frequency.exponentialRampToValueAtTime(620, t + 0.06);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 0.1);
  } catch (e) { /* audio unavailable */ }
}

function blip(type) {
  if (!settings.sound) return;
  try {
    ctx();
    const t = audio.currentTime;
    const notes = { success: [660, 990], error: [220, 165], warning: [440, 330], info: [520, 520], loading: [400] }[type] || [520];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(0.05, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.2);
    });
  } catch (e) { /* audio unavailable */ }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function record(type, title, message) {
  history.unshift({ type, title, message, t: Date.now() });
  if (history.length > 100) history.pop();
  const drawer = document.getElementById('drawer');
  if (!drawer.classList.contains('open')) unread++;
  renderDrawer();
}

function renderBadge() {
  const b = document.getElementById('bell-badge');
  b.textContent = unread > 9 ? '9+' : unread;
  b.classList.toggle('show', unread > 0);
  b.classList.remove('bump');
  void b.offsetWidth;
  if (unread > 0) b.classList.add('bump');
}

function renderDrawer() {
  const list = document.getElementById('drawer-list');
  list.innerHTML = history.length
    ? history.map((h) => `<li class="${h.type}"><i></i><div><b>${esc(h.title)}</b>${h.message ? `<p>${esc(h.message)}</p>` : ''}<time>${new Date(h.t).toLocaleTimeString()}</time></div></li>`).join('')
    : '<li class="empty">You\'re all caught up.</li>';
  renderBadge();
}

function restack() {
  const items = [...host().querySelectorAll('.toast:not(.out)')];
  items.forEach((el, i) => {
    const depth = items.length - 1 - i;
    el.style.opacity = depth > 3 ? '0' : '';
  });
  while (items.length > MAX) dismiss(items.shift());
}

function dismiss(el, swipe) {
  if (!el || el.classList.contains('out')) return;
  clearTimeout(el._timer);
  el.classList.add('out');
  if (swipe) el.classList.add('swipe');
  el.style.transform = '';
  setTimeout(() => el.remove(), 480);
}

function arm(el, duration) {
  const bar = el.querySelector('.toast-progress');
  clearTimeout(el._timer);
  bar.classList.remove('run');
  void bar.offsetWidth;
  if (!duration) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.style.animationDuration = duration + 'ms';
  bar.classList.add('run');
  let remaining = duration;
  let started = Date.now();
  const tick = () => { el._timer = setTimeout(() => dismiss(el), remaining); started = Date.now(); };
  el.onmouseenter = () => { clearTimeout(el._timer); remaining -= Date.now() - started; };
  el.onmouseleave = () => tick();
  tick();
}

function enableSwipe(el) {
  let x0 = null;
  let dx = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    x0 = e.clientX; dx = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    dx = Math.max(-30, e.clientX - x0);
    el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    el.style.opacity = String(1 - Math.max(0, dx) / 300);
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    el.classList.remove('dragging');
    if (dx > 110) dismiss(el, true);
    else { el.style.transform = ''; el.style.opacity = ''; }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function paint(el, o) {
  el.className = 'toast ' + o.type;
  el.innerHTML = `
    <div class="toast-icon">${o.type === 'loading' ? '' : icon(ICONS[o.type])}</div>
    <div class="toast-body"><b>${esc(o.title)}</b>${o.message ? `<p>${esc(o.message)}</p>` : ''}${o.action ? `<button class="toast-action">${esc(o.action.label)}</button>` : ''}</div>
    <button class="toast-x">${icon('x')}</button>
    <div class="toast-progress"></div>`;
  el.querySelector('.toast-x').onclick = () => dismiss(el);
  if (o.action) el.querySelector('.toast-action').onclick = () => { o.action.fn(); dismiss(el); };
}

/**
 * notify({ type, title, message, duration, action:{label, fn} })
 * Returns { update(opts), close() }.
 */
export function notify(opts) {
  const o = { type: 'info', duration: 4500, ...opts };
  if (o.type === 'loading') o.duration = 0;
  if (o.type === 'error' && opts.duration === undefined) o.duration = 7000;
  const el = document.createElement('div');
  paint(el, o);
  host().appendChild(el);
  enableSwipe(el);
  arm(el, o.duration);
  restack();
  blip(o.type);
  if (o.type !== 'loading') record(o.type, o.title, o.message);
  return {
    update(next) {
      const n = { ...o, ...next };
      if (n.type !== 'loading' && next.duration === undefined) n.duration = n.type === 'error' ? 7000 : 4500;
      el.style.animation = 'none';
      paint(el, n);
      el.animate([{ transform: 'scale(.96)' }, { transform: 'scale(1.02)' }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      arm(el, n.duration);
      blip(n.type);
      if (n.type !== 'loading') record(n.type, n.title, n.message);
    },
    close() { dismiss(el); },
  };
}

notify.success = (title, message, extra) => notify({ type: 'success', title, message, ...extra });
notify.error = (title, message, extra) => notify({ type: 'error', title, message, ...extra });
notify.warning = (title, message, extra) => notify({ type: 'warning', title, message, ...extra });
notify.info = (title, message, extra) => notify({ type: 'info', title, message, ...extra });

/** Show a loading toast that resolves into success / error. */
notify.promise = async (promise, { loading, success, error }) => {
  const h = notify({ type: 'loading', title: loading.title || loading, message: loading.message });
  try {
    const v = await promise;
    const s = typeof success === 'function' ? success(v) : success;
    h.update({ type: 'success', ...(typeof s === 'string' ? { title: s, message: '' } : s) });
    return v;
  } catch (e) {
    const er = typeof error === 'function' ? error(e) : error;
    h.update({ type: 'error', ...(typeof er === 'string' ? { title: er, message: e.message } : er) });
    throw e;
  }
};

export function initDrawer() {
  const drawer = document.getElementById('drawer');
  document.getElementById('bell').onclick = (e) => {
    e.stopPropagation();
    drawer.classList.toggle('open');
    document.getElementById('bell').classList.toggle('on', drawer.classList.contains('open'));
    unread = 0;
    renderBadge();
  };
  document.getElementById('drawer-clear').onclick = () => { history.length = 0; renderDrawer(); };
  document.addEventListener('click', (e) => {
    if (drawer.classList.contains('open') && !drawer.contains(e.target)) {
      drawer.classList.remove('open');
      document.getElementById('bell').classList.remove('on');
    }
  });
  renderDrawer();
}
