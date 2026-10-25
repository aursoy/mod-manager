// Custom dropdowns for every <select> in the app. The real <select> stays in the page
// (hidden) and keeps the value, so existing code that reads .value, sets .value or
// listens for input / change works unchanged; this only draws the button and menu.
import { icon } from './icons.js';

const NATIVE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const NATIVE_INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let open = null; // { sel, menu, btn }

function label(sel) {
  const o = sel.options[NATIVE_INDEX.get.call(sel)];
  return o ? o.textContent : '';
}

function refresh(sel) {
  const btn = sel._ddBtn;
  if (!btn) return;
  btn.querySelector('.dd-label').textContent = label(sel) || '—';
  btn.disabled = sel.disabled;
}

function close() {
  if (!open) return;
  const { menu, btn } = open;
  btn.classList.remove('open');
  menu.classList.add('out');
  setTimeout(() => menu.remove(), 160);
  open = null;
}

function choose(sel, i) {
  if (i < 0 || i === NATIVE_INDEX.get.call(sel)) { close(); return; }
  NATIVE_INDEX.set.call(sel, i);
  refresh(sel);
  close();
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function openMenu(sel) {
  if (open && open.sel === sel) return close();
  close();
  const btn = sel._ddBtn;
  const opts = [...sel.options];
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  const searchable = opts.length > 10;
  menu.innerHTML = (searchable ? `<label class="dd-search">${icon('search')}<input type="text" placeholder="Search" spellcheck="false" /></label>` : '')
    + `<ul>${opts.map((o, i) => `<li data-i="${i}" class="${i === NATIVE_INDEX.get.call(sel) ? 'on' : ''} ${o.disabled ? 'off' : ''}"><span>${esc(o.textContent)}</span>${icon('check')}</li>`).join('')}</ul>`;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const h = Math.min(340, menu.offsetHeight);
  const below = innerHeight - r.bottom - 12;
  const up = below < h && r.top > below;
  Object.assign(menu.style, {
    left: Math.min(r.left, innerWidth - Math.max(r.width, 180) - 8) + 'px',
    minWidth: r.width + 'px',
    top: (up ? r.top - h - 6 : r.bottom + 6) + 'px',
    maxHeight: (up ? Math.min(340, r.top - 14) : Math.min(340, below)) + 'px',
  });
  menu.classList.toggle('up', up);
  btn.classList.add('open');
  open = { sel, menu, btn };
  const items = [...menu.querySelectorAll('li')];
  let hi = Math.max(0, NATIVE_INDEX.get.call(sel));
  const mark = () => { items.forEach((li, k) => li.classList.toggle('hi', k === hi)); const li = items[hi]; if (li && li.offsetParent) li.scrollIntoView({ block: 'nearest' }); };
  mark();
  items.forEach((li) => {
    li.onpointerenter = () => { hi = +li.dataset.i; mark(); };
    li.onclick = () => { if (!li.classList.contains('off')) choose(sel, +li.dataset.i); };
  });
  const search = menu.querySelector('.dd-search input');
  if (search) {
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      items.forEach((li) => li.classList.toggle('hidden', !!q && !li.textContent.toLowerCase().includes(q)));
      const first = items.find((li) => !li.classList.contains('hidden'));
      if (first) { hi = +first.dataset.i; mark(); }
    };
    setTimeout(() => search.focus(), 30);
  }
  menu._key = (e) => {
    const visible = items.filter((li) => !li.classList.contains('hidden') && !li.classList.contains('off'));
    const pos = visible.findIndex((li) => +li.dataset.i === hi);
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = +(visible[Math.min(visible.length - 1, pos + 1)] || visible[0]).dataset.i; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = +(visible[Math.max(0, pos - 1)] || visible[0]).dataset.i; mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel, hi); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  };
}

/** Give one <select> the custom look. Safe to call twice. */
export function enhance(sel) {
  if (sel._ddBtn || sel.multiple || sel.closest('.dd-skip')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn' + (sel.classList.contains('tc-select') ? ' compact' : '');
  btn.innerHTML = `<span class="dd-label"></span><i class="dd-chev">${icon('chevron-right')}</i>`;
  sel.after(btn);
  sel.classList.add('dd-native');
  sel._ddBtn = btn;
  btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openMenu(sel); };
  btn.onkeydown = (e) => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) { e.preventDefault(); openMenu(sel); } };
  // code that sets .value / .selectedIndex directly updates the button too
  Object.defineProperty(sel, 'value', { configurable: true, get() { return NATIVE.get.call(this); }, set(v) { NATIVE.set.call(this, v); refresh(this); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return NATIVE_INDEX.get.call(this); }, set(v) { NATIVE_INDEX.set.call(this, v); refresh(this); } });
  new MutationObserver(() => refresh(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  sel.addEventListener('change', () => refresh(sel));
  sel.addEventListener('kt:refresh', () => refresh(sel));
  refresh(sel);
}

export function initDropdowns(root = document) {
  root.querySelectorAll('select').forEach(enhance);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'SELECT') enhance(n);
      else n.querySelectorAll && n.querySelectorAll('select').forEach(enhance);
    }
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('pointerdown', (e) => { if (open && !open.menu.contains(e.target) && !open.btn.contains(e.target)) close(); }, true);
  addEventListener('keydown', (e) => { if (open && open.menu._key) open.menu._key(e); }, true);
  addEventListener('resize', close);
  document.addEventListener('scroll', (e) => { if (open && !open.menu.contains(e.target)) close(); }, true);
}
