// Draws a stylised preview of a timecycle at a given hour. It is not the game
// renderer: it reads the sky, sun, cloud, fog and ambient colours of the chosen
// weather and paints a skyline with them, so colour edits show up instantly.

import { sceneColours, daylight, mix, clamp01 } from './timecycle.js';

const css = (c, a = 1) => `rgba(${Math.round(clamp01(c[0]) * 255)},${Math.round(clamp01(c[1]) * 255)},${Math.round(clamp01(c[2]) * 255)},${a})`;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function ridge(ctx, W, baseY, amp, rough, seed, fill) {
  const r = rng(seed);
  const pts = [];
  const n = 26;
  let h = 0.5;
  for (let i = 0; i <= n; i++) { h = clamp01(h + (r() - 0.5) * rough); pts.push(h); }
  ctx.beginPath();
  ctx.moveTo(0, baseY + 400);
  for (let i = 0; i <= n; i++) ctx.lineTo((i / n) * W, baseY - pts[i] * amp);
  ctx.lineTo(W, baseY + 400);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function cloud(ctx, x, y, s, base, shade, alpha) {
  const lobes = [[0, 0, 1], [-0.9, 0.2, 0.7], [0.9, 0.18, 0.75], [0.35, -0.3, 0.8], [-0.4, -0.2, 0.7]];
  for (const pass of [0, 1]) {
    for (const [dx, dy, k] of lobes) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, y + dy * s * 0.55 + (pass ? 0 : s * 0.12), s * k, s * k * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = css(pass ? base : shade, alpha);
      ctx.fill();
    }
  }
}

export function drawScene(canvas, sec, hour) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(2, Math.round(rect.width * dpr));
  const H = Math.max(2, Math.round(rect.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  const c = sceneColours(sec, hour);
  const dl = daylight(hour);
  const horizonY = H * 0.64;

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, css(c.zenith));
  sky.addColorStop(0.55, css(mix(c.zenith, c.horizon, 0.62)));
  sky.addColorStop(1, css(c.horizon));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // east / west glow where the sun rises and sets
  for (const [x, col] of [[0, c.azEast || c.horizon], [W, c.azWest || c.horizon]]) {
    const g = ctx.createRadialGradient(x, horizonY, 0, x, horizonY, W * 0.55);
    g.addColorStop(0, css(col, 0.7));
    g.addColorStop(1, css(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizonY);
  }

  // stars
  const starAlpha = clamp01(1 - dl * 2.2);
  if (starAlpha > 0.02) {
    const r = rng(7);
    for (let i = 0; i < 140; i++) {
      const x = r() * W; const y = r() * horizonY * 0.9; const s = r();
      ctx.fillStyle = `rgba(255,255,255,${starAlpha * (0.3 + 0.7 * s)})`;
      ctx.fillRect(x, y, 1 + s * dpr, 1 + s * dpr);
    }
  }

  // sun and moon share one arc: the sun is up 06:00 to 18:00, the moon the other half
  const body = (h, col, size, glow) => {
    const t = ((h - 6 + 24) % 24) / 12;
    if (t > 1.04) return;
    const x = W * (0.08 + 0.84 * t);
    const y = horizonY - Math.sin(clamp01(t) * Math.PI) * horizonY * 0.82;
    const g = ctx.createRadialGradient(x, y, 0, x, y, size * glow);
    g.addColorStop(0, css(col, 0.9));
    g.addColorStop(0.18, css(col, 0.45));
    g.addColorStop(1, css(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - size * glow, y - size * glow, size * glow * 2, size * glow * 2);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = css(mix(col, [1, 1, 1], 0.35));
    ctx.fill();
  };
  const sunUp = ((hour - 6 + 24) % 24) / 12 <= 1.04;
  if (sunUp) body(hour, c.sun, H * 0.035, 7);
  else body(hour + 12, c.moon || [0.8, 0.85, 1], H * 0.028, 5);

  // clouds
  const r = rng(21);
  const cloudCol = mix(c.cloud, [1, 1, 1], 0.1 * dl);
  const shade = mix(c.cloud, c.zenith, 0.5);
  for (let i = 0; i < 6; i++) {
    const x = r() * W; const y = H * (0.08 + r() * 0.34); const s = H * (0.07 + r() * 0.09);
    cloud(ctx, x, y, s, cloudCol, shade, 0.5 + 0.35 * r());
  }

  // distant mountains, hills, then the city
  const ambient = c.ambient;
  const mount = mix(mix(c.fog, ambient, 0.45), c.horizon, 0.2);
  ridge(ctx, W, horizonY + 6 * dpr, H * 0.26, 0.5, 5, css(mount));
  const haze = ctx.createLinearGradient(0, horizonY - H * 0.28, 0, horizonY + 10);
  haze.addColorStop(0, css(c.fog, 0));
  haze.addColorStop(1, css(c.fog, 0.72));
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizonY - H * 0.28, W, H * 0.28 + 10);

  ridge(ctx, W, horizonY + H * 0.12, H * 0.11, 0.4, 13, css(mix(ambient, c.fog, 0.35)));

  const cityBase = horizonY + H * 0.13;
  const rb = rng(99);
  const bodyCol = mix(ambient, [0, 0, 0], 0.5);
  let x = -10;
  while (x < W) {
    const bw = (22 + rb() * 38) * dpr;
    const bh = (H * 0.07) + rb() * H * 0.19;
    ctx.fillStyle = css(mix(bodyCol, c.fog, 0.12 + 0.1 * rb()));
    ctx.fillRect(x, cityBase - bh, bw, bh + 40);
    if (dl < 0.45) {
      const lit = (1 - dl / 0.45) * 0.9;
      for (let wy = cityBase - bh + 6 * dpr; wy < cityBase - 4 * dpr; wy += 9 * dpr) {
        for (let wx = x + 4 * dpr; wx < x + bw - 5 * dpr; wx += 8 * dpr) {
          if (rb() < 0.38) { ctx.fillStyle = `rgba(255,214,140,${lit * (0.5 + rb() * 0.5)})`; ctx.fillRect(wx, wy, 3 * dpr, 4 * dpr); }
        }
      }
    }
    x += bw + 2 * dpr;
  }

  // ground
  const ground = ctx.createLinearGradient(0, cityBase, 0, H);
  ground.addColorStop(0, css(mix(ambient, [0, 0, 0], 0.55)));
  ground.addColorStop(1, css(mix(ambient, [0, 0, 0], 0.8)));
  ctx.fillStyle = ground;
  ctx.fillRect(0, cityBase, W, H - cityBase);
  // sun/moon light reflected on the road
  const lg = ctx.createLinearGradient(0, cityBase, 0, H);
  lg.addColorStop(0, css(c.sun, 0.12 * dl));
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, cityBase, W, H - cityBase);

  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}
