'use strict';
// AWC (audio wave container) reader / writer for single-channel sfx banks.
// Layout: 16-byte header, [chunk indices], stream infos (u32), chunk infos
// (u64 each: type<<56 | size<<28 | offset), then chunk payloads.

const AWC_MAGIC = 0x54414441; // 'ADAT'
const CHUNK = { data: 0x55, format: 0xfa, animation: 0x5c, peak: 0x36, mid: 0x68, gesture: 0x2b, grains: 0x5a, loops: 0xd9, markers: 0xbd, streamformat: 0x48, seektable: 0xa3 };
const CODEC = { PCM: 0, ADPCM: 4 };
const CODEC_NAME = { 0: 'PCM', 4: 'ADPCM', 5: 'XMA2', 7: 'MPEG', 8: 'Vorbis' };

class AwcError extends Error {}

const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** GTA-style IMA ADPCM: 2048-byte blocks, 4-byte header (step index, -, predictor i16). */
function decodeAdpcm(data, sampleCount) {
  const out = new Int16Array(sampleCount);
  let w = 0, r = 0, inBlock = 0, pred = 0, idx = 0;
  const nib = (n) => {
    const step = IMA_STEP[idx];
    let diff = ((((n & 7) << 1) + 1) * step) >> 3;
    if (n & 8) diff = -diff;
    pred = clamp(pred + diff, -32768, 32767);
    idx = clamp(idx + IMA_INDEX[n & 7], 0, 88);
    if (w < sampleCount) out[w++] = pred;
  };
  while (r < data.length && w < sampleCount) {
    if (inBlock === 0) {
      if (r + 4 > data.length) break;
      idx = clamp(data[r], 0, 88);
      pred = data.readInt16LE(r + 2);
      inBlock = 2044;
      r += 4;
    } else {
      nib(data[r] & 0x0f);
      nib((data[r] >> 4) & 0x0f);
      inBlock--;
      r++;
    }
  }
  return out;
}

/** Inverse of decodeAdpcm (used by tests and to keep ADPCM banks small). */
function encodeAdpcm(pcm) {
  const blocks = Math.ceil(pcm.length / 4088) || 1;
  const out = Buffer.alloc(blocks * 2048);
  let s = 0;
  let idx = 0;
  for (let b = 0; b < blocks; b++) {
    let o = b * 2048;
    let pred = s < pcm.length ? pcm[s] : 0;
    out[o] = idx; out.writeInt16LE(pred, o + 2);
    o += 4;
    for (let k = 0; k < 2044; k++) {
      let byte = 0;
      for (let half = 0; half < 2; half++) {
        const target = s < pcm.length ? pcm[s] : pred;
        s++;
        const step = IMA_STEP[idx];
        let diff = target - pred;
        let n = 0;
        if (diff < 0) { n = 8; diff = -diff; }
        let mag = Math.min(7, Math.floor((diff * 4) / step));
        n |= mag;
        let d = ((((n & 7) << 1) + 1) * step) >> 3;
        pred = clamp(pred + (n & 8 ? -d : d), -32768, 32767);
        idx = clamp(idx + IMA_INDEX[n & 7], 0, 88);
        byte |= n << (half * 4);
      }
      out[o++] = byte;
    }
  }
  return out;
}

function parseAwc(buf) {
  if (buf.length < 16) throw new AwcError('File too small to be an AWC.');
  const keys = require('./rpf').getKeys();
  let magic = buf.readUInt32LE(0);
  // Whole-file XXTEA encryption (decrypted copies are written back plain).
  if (magic !== AWC_MAGIC && magic !== 0x41444154 && keys && buf.length % 4 === 0) {
    const dec = keys.decryptXXTEA(buf);
    if (dec.readUInt32LE(0) === AWC_MAGIC) { buf = dec; magic = AWC_MAGIC; }
  }
  if (magic !== AWC_MAGIC) {
    throw new AwcError(magic === 0x41444154 ? 'Console (big-endian) AWC banks are not supported.' : 'AWC is encrypted or not an audio bank.');
  }
  const version = buf.readUInt16LE(4);
  let flags = buf.readUInt16LE(6);
  const count = buf.readInt32LE(8);
  const dataOffset = buf.readInt32LE(12);
  if (count < 0 || count > 100000) throw new AwcError('Bad stream count.');
  let o = 16;
  let chunkIndices = null;
  if (flags & 1) {
    chunkIndices = [];
    for (let i = 0; i < count; i++, o += 2) chunkIndices.push(buf.readUInt16LE(o));
  }
  const streams = [];
  for (let i = 0; i < count; i++, o += 4) {
    const v = buf.readUInt32LE(o);
    streams.push({ id: v & 0x1fffffff, chunkCount: v >>> 29, chunks: [] });
  }
  for (const s of streams) {
    for (let j = 0; j < s.chunkCount; j++, o += 8) {
      const v = buf.readBigUInt64LE(o);
      const type = Number(v >> 56n);
      const size = Number((v >> 28n) & 0x0fffffffn);
      const offset = Number(v & 0x0fffffffn);
      s.chunks.push({ type, size, offset, data: buf.subarray(offset, offset + size) });
    }
    const fmt = s.chunks.find((c) => c.type === CHUNK.format);
    if (fmt && fmt.size >= 20) {
      const f = fmt.data;
      s.format = {
        samples: f.readUInt32LE(0), loopPoint: f.readInt32LE(4), rate: f.readUInt16LE(8), headroom: f.readInt16LE(10),
        loopBegin: f.readUInt16LE(12), loopEnd: f.readUInt16LE(14), playEnd: f.readUInt16LE(16), playBegin: f[18], codec: f[19],
      };
    }
  }
  // Per-stream encrypted sample data (single-channel banks): decrypt and
  // clear the flag so the bank is written back unencrypted.
  if ((flags & 2) && !(flags & 4)) {
    if (!keys) throw new AwcError('This sound bank is encrypted. Unlock encrypted RPFs with your GTA V install first.');
    for (const s of streams) for (const c of s.chunks) if (c.type === CHUNK.data) c.data = keys.decryptXXTEA(c.data);
    flags &= ~2;
  }
  return { version, flags, dataOffset, chunkIndices, streams, multichannel: !!(flags & 4) };
}

/** Public, serializable summary of a parsed bank. */
function describeAwc(awc) {
  return awc.streams
    .filter((s) => s.format && s.chunks.some((c) => c.type === CHUNK.data))
    .map((s) => ({
      id: s.id,
      hex: s.id.toString(16).toUpperCase().padStart(8, '0'),
      samples: s.format.samples,
      rate: s.format.rate,
      codec: CODEC_NAME[s.format.codec] || 'codec ' + s.format.codec,
      seconds: s.format.rate ? s.format.samples / s.format.rate : 0,
      playable: s.format.codec === CODEC.PCM || s.format.codec === CODEC.ADPCM,
    }));
}

function streamPcm(awc, id) {
  const s = awc.streams.find((x) => x.id === id);
  if (!s || !s.format) throw new AwcError('Stream not found.');
  const data = s.chunks.find((c) => c.type === CHUNK.data).data;
  if (s.format.codec === CODEC.PCM) {
    const n = Math.min(s.format.samples, data.length >> 1);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2);
    return { pcm: out, rate: s.format.rate };
  }
  if (s.format.codec === CODEC.ADPCM) return { pcm: decodeAdpcm(data, s.format.samples), rate: s.format.rate };
  throw new AwcError('Codec ' + (CODEC_NAME[s.format.codec] || s.format.codec) + ' cannot be decoded.');
}

function peaksFor(pcm, from) {
  const blocks = [];
  for (let b = from; b * 4096 < pcm.length; b++) {
    let m = 0;
    for (let i = b * 4096; i < Math.min(pcm.length, (b + 1) * 4096); i++) { const a = Math.abs(pcm[i]); if (a > m) m = a; }
    blocks.push(Math.min(65535, m * 2));
  }
  return blocks;
}

/** Replace a stream's audio with 16-bit PCM. Keeps the stream id and other chunks. */
function replaceStream(awc, id, pcm, rate) {
  const s = awc.streams.find((x) => x.id === id);
  if (!s || !s.format) throw new AwcError('Stream not found.');
  if (awc.multichannel) throw new AwcError('Multi-channel banks (music/streams) cannot be edited.');
  const fmtChunk = s.chunks.find((c) => c.type === CHUNK.format);
  const peak = s.chunks.find((c) => c.type === CHUNK.peak);
  // Peak chunk length relative to sample count tells us how many blocks it covers.
  const oldBlocks = Math.ceil(s.format.samples / 4096);
  const skipFirst = peak ? (peak.size / 2 === oldBlocks ? 0 : 1) : 1;

  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i], i * 2);
  const allPeaks = peaksFor(pcm, 0);

  const f = Buffer.from(fmtChunk.data);
  f.writeUInt32LE(pcm.length, 0);
  f.writeInt32LE(-1, 4);
  f.writeUInt16LE(rate, 8);
  f.writeUInt16LE(0, 12);
  f.writeUInt16LE(0, 14);
  f.writeUInt16LE(0, 16);
  f[18] = 0;
  f[19] = CODEC.PCM;
  if (f.length >= 22) f.writeUInt16LE(allPeaks[0] || 0, 20);
  fmtChunk.data = f;

  s.chunks.find((c) => c.type === CHUNK.data).data = data;
  if (peak) {
    const vals = allPeaks.slice(skipFirst);
    const pb = Buffer.alloc(vals.length * 2);
    vals.forEach((v, i) => pb.writeUInt16LE(v, i * 2));
    peak.data = pb;
  }
  // ADPCM seek tables no longer apply to PCM data.
  s.chunks = s.chunks.filter((c) => c.type !== CHUNK.seektable);
  s.format = { ...s.format, samples: pcm.length, rate, codec: CODEC.PCM, loopPoint: -1 };
  s.edited = true;
}

function writeAwc(awc) {
  const count = awc.streams.length;
  const chunkTotal = awc.streams.reduce((n, s) => n + s.chunks.length, 0);
  const hasIdx = !!(awc.flags & 1);
  let headerLen = 16 + (hasIdx ? count * 2 : 0) + count * 4 + chunkTotal * 8;
  let cursor = Math.ceil(headerLen / 16) * 16;
  const parts = [];
  // Data chunks last so small chunks sit together after the header (as Rockstar does).
  const placed = new Map();
  const order = [];
  for (const s of awc.streams) for (const c of s.chunks) if (c.type !== CHUNK.data) order.push(c);
  for (const s of awc.streams) for (const c of s.chunks) if (c.type === CHUNK.data) order.push(c);
  for (const c of order) {
    const align = c.type === CHUNK.data ? 16 : 4;
    cursor = Math.ceil(cursor / align) * align;
    placed.set(c, cursor);
    parts.push({ at: cursor, data: c.data });
    cursor += c.data.length;
  }
  const out = Buffer.alloc(cursor);
  out.writeUInt32LE(AWC_MAGIC, 0);
  out.writeUInt16LE(awc.version, 4);
  out.writeUInt16LE(awc.flags, 6);
  out.writeInt32LE(count, 8);
  const firstData = order.find((c) => c.type === CHUNK.data);
  out.writeInt32LE(firstData ? placed.get(firstData) : cursor, 12);
  let o = 16;
  if (hasIdx) {
    // Indices are the running chunk offset per stream when they look like it;
    // otherwise keep whatever the original bank stored.
    const orig = awc.chunkIndices || [];
    let running = 0, origRunning = 0, looksRunning = true;
    awc.streams.forEach((s, i) => { if (orig[i] !== origRunning) looksRunning = false; origRunning += s.chunkCount; });
    awc.streams.forEach((s, i) => {
      out.writeUInt16LE(looksRunning ? running : (orig[i] || 0), o);
      o += 2;
      running += s.chunks.length;
    });
  }
  for (const s of awc.streams) { out.writeUInt32LE(((s.chunks.length << 29) | (s.id & 0x1fffffff)) >>> 0, o); o += 4; }
  for (const s of awc.streams) {
    for (const c of s.chunks) {
      const v = (BigInt(c.type) << 56n) | (BigInt(c.data.length & 0x0fffffff) << 28n) | BigInt(placed.get(c) & 0x0fffffff);
      out.writeBigUInt64LE(v, o);
      o += 8;
    }
  }
  for (const p of parts) p.data.copy(out, p.at);
  return out;
}

module.exports = { parseAwc, describeAwc, streamPcm, replaceStream, writeAwc, decodeAdpcm, encodeAdpcm, CHUNK, CODEC, AwcError };
