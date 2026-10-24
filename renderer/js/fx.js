// Ambient effects + small interaction helpers shared across pages.

export const fxState = { bg: true, paused: false };

export function initBackground() {
  // The dot grid is drawn once into a cached layer. Frames only run while the
  // cursor moves (or dots are still easing back), and only the dots near the
  // cursor are redrawn, so an idle window costs nothing.
  const c = document.getElementById('bg');
  const ctx = c.getContext('2d');
  const glow = document.querySelector('.cursor-glow');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  const GAP = 34, RADIUS = 180, PUSH = 22, REST = 0.075;
  let w, h, dpr, cols, rows, dots = [];
  const moved = new Set();
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  let raf = 0, wasOn = null;

  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    for (const k of [c, base]) { k.width = w * dpr; k.height = h * dpr; }
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil((w - GAP / 2) / GAP); rows = Math.ceil((h - GAP / 2) / GAP);
    dots = []; moved.clear();
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = GAP / 2 + i * GAP, y = GAP / 2 + j * GAP;
      dots.push({ x, y, ox: x, oy: y });
    }
    bctx.clearRect(0, 0, w, h);
    bctx.fillStyle = `rgba(255,255,255,${REST})`;
    for (const d of dots) bctx.fillRect(d.ox - 0.4, d.oy - 0.4, 0.8, 0.8);
    wasOn = null;
    kick();
  };

  const near = (fn) => {
    const i0 = Math.max(0, Math.floor((mouse.x - RADIUS) / GAP)), i1 = Math.min(cols - 1, Math.ceil((mouse.x + RADIUS) / GAP));
    const j0 = Math.max(0, Math.floor((mouse.y - RADIUS) / GAP)), j1 = Math.min(rows - 1, Math.ceil((mouse.y + RADIUS) / GAP));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(dots[j * cols + i]);
  };

  const frame = () => {
    raf = 0;
    const on = fxState.bg && !fxState.paused && !document.hidden;
    if (on !== wasOn) {
      ctx.clearRect(0, 0, w, h);
      if (on) ctx.drawImage(base, 0, 0, w, h);
      wasOn = on;
    }
    if (!on) return;
    mouse.x += (mouse.tx - mouse.x) * 0.12;
    mouse.y += (mouse.ty - mouse.y) * 0.12;
    glow.style.transform = `translate(${mouse.x - 320}px, ${mouse.y - 320}px)`;
    if (mouse.tx > -9000) near((d) => moved.add(d));
    let busy = Math.abs(mouse.tx - mouse.x) + Math.abs(mouse.ty - mouse.y) > 0.5;
    // Wipe the old spots, then draw every displaced dot at its new spot.
    for (const d of moved) ctx.clearRect(d.x - 2, d.y - 2, 4, 4);
    for (const d of moved) {
      ctx.clearRect(d.ox - 1, d.oy - 1, 2, 2);
      const dx = d.ox - mouse.x, dy = d.oy - mouse.y;
      const dist = Math.hypot(dx, dy);
      const force = Math.max(0, 1 - dist / RADIUS);
      d.x += ((d.ox + (dx / (dist || 1)) * force * PUSH) - d.x) * 0.15;
      d.y += ((d.oy + (dy / (dist || 1)) * force * PUSH) - d.y) * 0.15;
      const r = 0.8 + force * 1.6;
      ctx.fillStyle = `rgba(255,255,255,${REST + force * 0.5})`;
      ctx.fillRect(d.x - r / 2, d.y - r / 2, r, r);
      if (force === 0 && Math.abs(d.x - d.ox) + Math.abs(d.y - d.oy) < 0.05) { d.x = d.ox; d.y = d.oy; moved.delete(d); }
      else busy = true;
    }
    if (busy) kick();
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  fxState.kick = kick;

  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mouse.tx = e.clientX; mouse.ty = e.clientY; kick(); }, { passive: true });
  document.addEventListener('pointerleave', () => { mouse.tx = -9999; mouse.ty = -9999; kick(); });
  document.addEventListener('visibilitychange', kick);
  resize();
}

export function initInteractions() {
  // Spotlight on cards and magnetic primary buttons, at most once per frame.
  let last = null, queued = false;
  const track = () => {
    queued = false;
    const e = last;
    if (fxState.paused || !e) return;
    const card = e.target.closest && e.target.closest('.card');
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', e.clientX - r.left + 'px');
      card.style.setProperty('--my', e.clientY - r.top + 'px');
    }
    document.querySelectorAll('.page.active .btn.primary.magnet').forEach((b) => {
      const r = b.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      const t = d < 120 ? `translate(${dx * 0.15}px, ${dy * 0.25}px)` : '';
      if (b.style.transform !== t) b.style.transform = t;
    });
  };
  document.addEventListener('pointermove', (e) => {
    last = e;
    if (!queued) { queued = true; requestAnimationFrame(track); }
  }, { passive: true });
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
