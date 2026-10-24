// Ambient effects + small interaction helpers shared across pages.

export const fxState = { bg: true, paused: false };

export function initBackground() {
  const c = document.getElementById('bg');
  const ctx = c.getContext('2d');
  const glow = document.querySelector('.cursor-glow');
  let w, h, dpr, dots = [];
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  const GAP = 34;

  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = [];
    for (let y = GAP / 2; y < h; y += GAP) for (let x = GAP / 2; x < w; x += GAP) dots.push({ x, y, ox: x, oy: y, ph: Math.random() * 6.28 });
  };
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mouse.tx = e.clientX; mouse.ty = e.clientY; });
  document.addEventListener('pointerleave', () => { mouse.tx = -9999; mouse.ty = -9999; });
  resize();

  let t = 0;
  let cleared = false;
  const frame = () => {
    // Paused on heavy pages (3D / audio): clear once, then idle.
    if (fxState.paused) {
      if (!cleared) { ctx.clearRect(0, 0, w, h); cleared = true; }
      requestAnimationFrame(frame);
      return;
    }
    cleared = false;
    t += 0.008;
    mouse.x += (mouse.tx - mouse.x) * 0.12;
    mouse.y += (mouse.ty - mouse.y) * 0.12;
    glow.style.transform = `translate(${mouse.x - 320}px, ${mouse.y - 320}px)`;
    ctx.clearRect(0, 0, w, h);
    if (fxState.bg) {
      for (const d of dots) {
        const dx = d.ox - mouse.x, dy = d.oy - mouse.y;
        const dist = Math.hypot(dx, dy);
        const force = Math.max(0, 1 - dist / 180);
        const wave = Math.sin(t * 2 + d.ox * 0.01 + d.oy * 0.013 + d.ph * 0.2) * 0.5 + 0.5;
        d.x += ((d.ox + (dx / (dist || 1)) * force * 22) - d.x) * 0.15;
        d.y += ((d.oy + (dy / (dist || 1)) * force * 22) - d.y) * 0.15;
        const a = 0.05 + wave * 0.05 + force * 0.5;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        const r = 0.8 + force * 1.6;
        ctx.fillRect(d.x - r / 2, d.y - r / 2, r, r);
      }
    }
    requestAnimationFrame(frame);
  };
  frame();
}

export function initInteractions() {
  // Spotlight on cards follows the cursor.
  document.addEventListener('pointermove', (e) => {
    if (fxState.paused) return;
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', e.clientX - r.left + 'px');
    card.style.setProperty('--my', e.clientY - r.top + 'px');
  });
  // Ripple on buttons.
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn');
    if (!b) return;
    const r = b.getBoundingClientRect();
    const s = Math.max(r.width, r.height);
    const rp = document.createElement('span');
    rp.className = 'ripple';
    rp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    b.appendChild(rp);
    setTimeout(() => rp.remove(), 700);
  });
  // Magnetic primary buttons.
  document.addEventListener('pointermove', (e) => {
    if (fxState.paused) return;
    document.querySelectorAll('.btn.primary.magnet').forEach((b) => {
      const r = b.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      b.style.transform = d < 120 ? `translate(${dx * 0.15}px, ${dy * 0.25}px)` : '';
    });
  });
  // Range fill.
  document.addEventListener('input', (e) => { if (e.target.type === 'range') fillRange(e.target); });
  document.querySelectorAll('input[type=range]').forEach(fillRange);
}

export function fillRange(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', p + '%');
}

export function syncSeg(seg) {
  const on = seg.querySelector('button.on');
  const thumb = seg.querySelector('.seg-thumb');
  if (!on || !thumb) return;
  thumb.style.width = on.offsetWidth + 'px';
  thumb.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}

export function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString()) {
  const from = parseFloat(el.dataset.v || '0');
  el.dataset.v = to;
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function stagger(root) {
  root.querySelectorAll('.card, .tile').forEach((el, i) => el.style.setProperty('--i', i));
}

export function busy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('loading', on);
}
