// First-run tutorial: a spotlight glides between a few parts of the app with one
// line each. Shown once (remembered in localStorage); Settings can replay it.

const $ = (s, r = document) => r.querySelector(s);

const STEPS = [
  { page: 'home', target: '#citizen-drop', title: 'Link FiveM', text: 'Drop your citizen folder here, or hit Auto-detect.' },
  { target: '#nav a[data-page="graphics"]', title: 'Graphics', text: 'Tell the AI what pack you want. Clouds and blood too.' },
  { target: '#nav a[data-page="world"]', title: 'World', text: 'Water, black mountains, snow and player detail. One click each.' },
  { target: '#nav a[data-page="mods"]', title: 'Mods', text: 'Turn mods and graphics packs on and off.' },
  { target: '#nav a[data-page="gun"]', title: 'Gun Lab', text: 'Recolour guns, add 3D text and chains.' },
  { target: '#profile-card', title: 'You', text: 'Your Discord shows here by itself.' },
];
const KEY = 'kt.tour.done';

export function tourSeen() {
  try { return localStorage.getItem(KEY) === '1'; } catch (e) { return true; }
}

export function startTour({ go }) {
  if (document.querySelector('.tour')) return;
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `<div class="tour-spot"></div>
    <div class="tour-card"><small class="tour-count"></small><b class="tour-title"></b><p class="tour-text"></p>
      <div class="tour-foot"><div class="tour-dots">${STEPS.map(() => '<i></i>').join('')}</div>
      <button class="btn ghost sm" data-t="skip">Skip</button><button class="btn primary sm" data-t="next">Next</button></div></div>`;
  document.body.appendChild(root);
  const spot = $('.tour-spot', root), card = $('.tour-card', root);
  let i = 0;

  const place = () => {
    const s = STEPS[i];
    if (s.page && go) go(s.page);
    const el = $(s.target);
    if (!el) return next();
    const r = el.getBoundingClientRect();
    const pad = 8;
    Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    $('.tour-count', root).textContent = i + 1 + ' / ' + STEPS.length;
    $('.tour-title', root).textContent = s.title;
    $('.tour-text', root).textContent = s.text;
    root.querySelectorAll('.tour-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    $('[data-t=next]', root).textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
    // card beside the spotlight: right of it if there is room, else below
    const cw = 300, ch = card.offsetHeight || 150;
    let x = r.right + 24, y = r.top + r.height / 2 - ch / 2;
    if (x + cw > innerWidth - 16) { x = Math.min(innerWidth - cw - 16, Math.max(16, r.left)); y = r.bottom + 20; }
    if (y + ch > innerHeight - 16) y = r.top - ch - 20;
    card.style.transform = `translate(${Math.round(x)}px, ${Math.max(16, Math.round(y))}px)`;
    card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  };
  const end = () => {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
    root.classList.add('out');
    removeEventListener('resize', place);
    removeEventListener('keydown', key);
    setTimeout(() => root.remove(), 400);
  };
  const next = () => { if (++i >= STEPS.length) end(); else place(); };
  const key = (e) => { if (e.key === 'Escape') end(); if (e.key === 'Enter' || e.key === 'ArrowRight') next(); };
  $('[data-t=next]', root).onclick = next;
  $('[data-t=skip]', root).onclick = end;
  addEventListener('resize', place);
  addEventListener('keydown', key);
  requestAnimationFrame(() => { root.classList.add('in'); place(); });
}
