// Texture codec: DXT1 / DXT3 / DXT5 / A8R8G8B8 / A8B8G8R8 decode + encode.

const BLOCK = { DXT1: 8, DXT3: 16, DXT5: 16 };

export function levelSize(format, w, h) {
  if (BLOCK[format]) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK[format];
  return w * h * 4;
}

const c565 = (c) => [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];
const to565 = (r, g, b) => ((Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255));

function colourPalette(c0, c1, fourColour) {
  const a = c565(c0), b = c565(c1);
  const p = [[...a, 255], [...b, 255]];
  if (fourColour) {
    p.push([(2 * a[0] + b[0]) / 3 | 0, (2 * a[1] + b[1]) / 3 | 0, (2 * a[2] + b[2]) / 3 | 0, 255]);
    p.push([(a[0] + 2 * b[0]) / 3 | 0, (a[1] + 2 * b[1]) / 3 | 0, (a[2] + 2 * b[2]) / 3 | 0, 255]);
  } else {
    p.push([(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1, 255]);
    p.push([0, 0, 0, 0]);
  }
  return p;
}

function alphaPalette(a0, a1) {
  const p = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) p.push(((7 - i) * a0 + i * a1) / 7 | 0);
  else { for (let i = 1; i < 5; i++) p.push(((5 - i) * a0 + i * a1) / 5 | 0); p.push(0, 255); }
  return p;
}

/** Decode one mip level to RGBA8. */
export function decode(format, src, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  if (format === 'A8R8G8B8' || format === 'A8B8G8R8') {
    const swap = format === 'A8R8G8B8';
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = src[i * 4 + (swap ? 2 : 0)];
      out[i * 4 + 1] = src[i * 4 + 1];
      out[i * 4 + 2] = src[i * 4 + (swap ? 0 : 2)];
      out[i * 4 + 3] = src[i * 4 + 3];
    }
    return out;
  }
  const bs = BLOCK[format];
  if (!bs) throw new Error('Unsupported format ' + format);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let o = (by * bw + bx) * bs;
      let alpha = null;
      if (format === 'DXT3') {
        alpha = [];
        for (let i = 0; i < 8; i++) { const v = src[o + i]; alpha.push((v & 15) * 17, (v >> 4) * 17); }
        o += 8;
      } else if (format === 'DXT5') {
        const ap = alphaPalette(src[o], src[o + 1]);
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(src[o + 2 + i]) << BigInt(8 * i);
        alpha = [];
        for (let i = 0; i < 16; i++) alpha.push(ap[Number((bits >> BigInt(3 * i)) & 7n)]);
        o += 8;
      }
      const c0 = dv.getUint16(o, true), c1 = dv.getUint16(o + 2, true);
      const pal = colourPalette(c0, c1, format !== 'DXT1' || c0 > c1);
      const idx = dv.getUint32(o + 4, true);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const k = py * 4 + px;
          const c = pal[(idx >>> (2 * k)) & 3];
          const d = (y * w + x) * 4;
          out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2];
          out[d + 3] = alpha ? alpha[k] : c[3];
        }
      }
    }
  }
  return out;
}

function readBlock(rgba, w, h, bx, by, px) {
  for (let py = 0; py < 4; py++) {
    for (let qx = 0; qx < 4; qx++) {
      const x = Math.min(w - 1, bx * 4 + qx), y = Math.min(h - 1, by * 4 + py);
      const s = (y * w + x) * 4, d = (py * 4 + qx) * 4;
      px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
    }
  }
}

function encodeColour(px, out, o, allowPunch) {
  let hasTransparent = false;
  let mn = [255, 255, 255], mx = [0, 0, 0];
  for (let i = 0; i < 16; i++) {
    if (allowPunch && px[i * 4 + 3] < 128) { hasTransparent = true; continue; }
    for (let c = 0; c < 3; c++) { const v = px[i * 4 + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  }
  if (mn[0] > mx[0]) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
  // Inset the bounding box slightly to reduce banding.
  for (let c = 0; c < 3; c++) {
    const inset = (mx[c] - mn[c]) / 16;
    mn[c] = Math.max(0, mn[c] + inset); mx[c] = Math.min(255, mx[c] - inset);
  }
  let c0 = to565(mx[0], mx[1], mx[2]), c1 = to565(mn[0], mn[1], mn[2]);
  let four = true;
  if (hasTransparent) { if (c0 > c1) [c0, c1] = [c1, c0]; four = false; }
  else if (c0 < c1) [c0, c1] = [c1, c0];
  else if (c0 === c1) { out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8; out[o + 4] = out[o + 5] = out[o + 6] = out[o + 7] = 0; return; }
  const pal = colourPalette(c0, c1, four);
  let idx = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0;
    if (!four && px[i * 4 + 3] < 128) best = 3;
    else {
      let bd = Infinity;
      const lim = four ? 4 : 3;
      for (let k = 0; k < lim; k++) {
        const dr = px[i * 4] - pal[k][0], dg = px[i * 4 + 1] - pal[k][1], db = px[i * 4 + 2] - pal[k][2];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bd) { bd = d; best = k; }
      }
    }
    idx |= best << (2 * i);
  }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255; out[o + 5] = (idx >>> 8) & 255; out[o + 6] = (idx >>> 16) & 255; out[o + 7] = (idx >>> 24) & 255;
}

function encodeAlpha5(px, out, o) {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a > a0) a0 = a; if (a < a1) a1 = a; }
  out[o] = a0; out[o + 1] = a1;
  let bits = 0n;
  if (a0 !== a1) {
    const pal = alphaPalette(a0, a1);
    for (let i = 0; i < 16; i++) {
      const a = px[i * 4 + 3];
      let best = 0, bd = 999;
      for (let k = 0; k < 8; k++) { const d = Math.abs(a - pal[k]); if (d < bd) { bd = d; best = k; } }
      bits |= BigInt(best) << BigInt(3 * i);
    }
  }
  for (let i = 0; i < 6; i++) out[o + 2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
}

/** Encode one RGBA8 level. */
export function encode(format, rgba, w, h) {
  const out = new Uint8Array(levelSize(format, w, h));
  if (format === 'A8R8G8B8' || format === 'A8B8G8R8') {
    const swap = format === 'A8R8G8B8';
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = rgba[i * 4 + (swap ? 2 : 0)];
      out[i * 4 + 1] = rgba[i * 4 + 1];
      out[i * 4 + 2] = rgba[i * 4 + (swap ? 0 : 2)];
      out[i * 4 + 3] = rgba[i * 4 + 3];
    }
    return out;
  }
  const bs = BLOCK[format];
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const px = new Uint8ClampedArray(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      readBlock(rgba, w, h, bx, by, px);
      let o = (by * bw + bx) * bs;
      if (format === 'DXT3') {
        for (let i = 0; i < 8; i++) out[o + i] = (px[i * 8 + 3] >> 4) | ((px[i * 8 + 7] >> 4) << 4);
        o += 8;
      } else if (format === 'DXT5') {
        encodeAlpha5(px, out, o);
        o += 8;
      }
      encodeColour(px, out, o, format === 'DXT1');
    }
  }
  return out;
}

export const EDITABLE = ['DXT1', 'DXT3', 'DXT5', 'A8R8G8B8', 'A8B8G8R8'];
