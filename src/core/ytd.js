'use strict';
// Texture dictionary (gen8 PC) parsing. Textures are located by absolute
// offset into the decompressed resource so edits can be patched in place.

const FORMATS = {
  0x31545844: { name: 'DXT1', block: 8, editable: true },
  0x33545844: { name: 'DXT3', block: 16, editable: true },
  0x35545844: { name: 'DXT5', block: 16, editable: true },
  0x31495441: { name: 'ATI1', block: 8, editable: false },
  0x32495441: { name: 'ATI2', block: 16, editable: false },
  0x20374342: { name: 'BC7', block: 16, editable: false },
  21: { name: 'A8R8G8B8', bpp: 4, editable: true },
  32: { name: 'A8B8G8R8', bpp: 4, editable: true },
  25: { name: 'A1R5G5B5', bpp: 2, editable: false },
  28: { name: 'A8', bpp: 1, editable: false },
  50: { name: 'L8', bpp: 1, editable: false },
};

function levelSize(fmt, w, h) {
  if (fmt.block) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * fmt.block;
  return w * h * fmt.bpp;
}

function totalSize(fmt, w, h, levels) {
  let s = 0;
  for (let i = 0; i < levels; i++) {
    s += levelSize(fmt, Math.max(1, w >> i), Math.max(1, h >> i));
  }
  return s;
}

/** Parse one Texture struct at absolute offset `t`. Returns null if invalid. */
function parseTexture(v, t) {
  if (t < 0 || t + 0x78 > v.d.length) return null;
  const name = v.str(v.at(t + 0x28));
  const width = v.u16(t + 0x50);
  const height = v.u16(t + 0x52);
  const formatCode = v.u32(t + 0x58);
  const levels = Math.max(1, v.u8(t + 0x5d));
  const dataAbs = v.at(t + 0x70);
  const fmt = FORMATS[formatCode];
  if (!fmt || !width || !height || width > 16384 || height > 16384 || dataAbs < 0) return null;
  const size = totalSize(fmt, width, height, levels);
  if (dataAbs + size > v.d.length) return null;
  return {
    name: name || 'texture_' + t.toString(16),
    width,
    height,
    levels,
    format: fmt.name,
    editable: fmt.editable,
    dataOffset: dataAbs,
    dataSize: size,
  };
}

/** Parse a TextureDictionary at absolute offset `base`. */
function parseTextureDictionary(v, base) {
  if (base < 0) return [];
  const listAbs = v.at(base + 0x30);
  const count = v.u16(base + 0x38);
  if (listAbs < 0 || count === 0 || count > 1024) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const tAbs = v.at(listAbs + i * 8);
    const tex = parseTexture(v, tAbs);
    if (tex) out.push(tex);
  }
  return out;
}

module.exports = { parseTextureDictionary, parseTexture, FORMATS, levelSize, totalSize };
