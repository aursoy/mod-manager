// Custom background: a picture or looping video behind the whole app (Settings).
import { notify } from './notify.js';
import { fillRange } from './fx.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
let url = null;
let look = null;

function mediaEl(kind, src, cls) {
  const el = document.createElement(kind === 'video' ? 'video' : 'img');
  el.src = src;
  if (cls) el.className = cls;
  if (kind === 'video') { el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; }
  return el;
}

function paint() {
  const has = !!(look && look.kind && url);
  document.body.classList.toggle('custom-bg', has);
  const media = $('#cbg-media');
  const prev = $('#look-preview');
  media.innerHTML = '';
  prev.innerHTML = '<span>Default</span>';
  if (has) {
    media.appendChild(mediaEl(look.kind, url));
    prev.innerHTML = '';
    prev.appendChild(mediaEl(look.kind, url));
  }
  const dim = look ? look.dim : 0.55;
  const blur = look ? look.blur : 0;
  $('#cbg-dim').style.opacity = String(dim);
  media.style.filter = blur ? `blur(${blur}px)` : '';
  $('#look-dim').value = Math.round(dim * 100);
  $('#look-blur').value = blur;
  $('#look-dim-val').textContent = Math.round(dim * 100) + '%';
  $('#look-blur-val').textContent = blur + 'px';
  [$('#look-dim'), $('#look-blur')].forEach(fillRange);
  $('#look-state').textContent = has ? (look.kind === 'video' ? 'Video' : 'Picture') + ': ' + look.name : 'Use your own picture or video behind the whole app.';
  $('#look-clear').disabled = !has;
}

function useData(l) {
  look = l;
  if (url) URL.revokeObjectURL(url);
  url = l && l.data ? URL.createObjectURL(new Blob([new Uint8Array(l.data)], { type: l.mime })) : null;
  paint();
}

export async function setBackgroundFile(file) {
  try { useData(await api.call('look:file', file)); notify.success('Background set', 'Darken it in Settings if text is hard to read.'); }
  catch (e) { notify.error('Background not set', e.message); }
}

export function initLook() {
  $('#look-pick').onclick = async () => {
    try { const l = await api.call('look:pick'); if (l) { useData(l); notify.success('Background set', 'Use Darken and Blur to keep text easy to read.'); } }
    catch (e) { notify.error('Background not set', e.message); }
  };
  $('#look-clear').onclick = async () => { await api.call('look:clear'); useData(null); notify.success('Background reset', 'Back to the default background.'); };
  let t = null;
  const live = () => {
    look = { ...(look || {}), dim: $('#look-dim').value / 100, blur: +$('#look-blur').value };
    paint();
    clearTimeout(t);
    t = setTimeout(() => api.call('look:set', { dim: look.dim, blur: look.blur }).catch(() => {}), 250);
  };
  $('#look-dim').addEventListener('input', live);
  $('#look-blur').addEventListener('input', live);
  api.call('look:get').then(useData).catch(() => paint());
}
