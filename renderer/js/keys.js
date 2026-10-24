// "Unlock encrypted RPFs": finds GTA5.exe, reads the archive key from it
// (one time, cached), so NG/AES packs open in the Gun Lab and Sound Lab.
import { notify } from './notify.js';
import { icon } from './icons.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const needsKeys = (e) => String(e && e.message || e).includes('[NEED_KEYS]');
export const cleanError = (m) => String(m).replace(/^.*\[NEED_KEYS\]\s*/, '');

let progressToast = null;
let lastPct = -1;
async function unlock(exe) {
  const name = exe.split(/[\\/]/).pop();
  const h = notify({ type: 'loading', title: 'Unlocking encrypted RPFs…', message: 'Reading keys from ' + name + ' · 0%' });
  progressToast = { h, name };
  lastPct = -1;
  try {
    await api.call('keys:unlock', exe).finally(() => { progressToast = null; });
    h.update({ type: 'success', title: 'Encrypted RPFs unlocked', message: 'Encrypted packs now open everywhere. This only happens once.' });
    refreshKeyCard();
    return true;
  } catch (e) {
    h.update({ type: 'error', title: 'Unlock failed', message: cleanError(e.message) });
    return false;
  }
}

/** Show the unlock dialog; resolves true once keys are ready. */
export async function ensureKeys(reason) {
  const st = await api.call('keys:status');
  if (st.ready) return true;
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const exe = st.exes[0] || '';
    back.innerHTML = `<div class="modal">
      <h3>${icon('shield')} Unlock encrypted RPFs</h3>
      <p>${esc(reason || 'This pack is encrypted by Rockstar (NG).')} Kt Mod Manager can read the unlock key from your own GTA V, the same way CodeWalker and OpenIV do. It only reads the file, never changes it, and only needs to do this once.</p>
      <label class="field"><span>GTA V executable</span><input type="text" id="k-exe" value="${esc(exe)}" placeholder="…\\Grand Theft Auto V\\GTA5.exe" /></label>
      <div class="row-end"><button class="btn ghost" data-r="browse">${icon('folder')}Browse</button><button class="btn ghost" data-r="0">Cancel</button><button class="btn primary" data-r="1">${icon('zap')}Unlock</button></div>
    </div>`;
    $('#modal-root').appendChild(back);
    const hide = () => { back.classList.add('out'); setTimeout(() => back.remove(), 300); };
    const close = (v) => { hide(); resolve(v); };
    back.onclick = (e) => { if (e.target === back) close(false); };
    $('[data-r="0"]', back).onclick = () => close(false);
    $('[data-r="browse"]', back).onclick = async () => { const p = await api.call('keys:pickExe'); if (p) $('#k-exe', back).value = p; };
    $('[data-r="1"]', back).onclick = async () => {
      const p = $('#k-exe', back).value.trim();
      if (!p) return notify.warning('Pick GTA5.exe', 'Browse to your Grand Theft Auto V folder.');
      hide();
      resolve(await unlock(p));
    };
  });
}

export async function refreshKeyCard() {
  const st = await api.call('keys:status').catch(() => ({ ready: false }));
  const b = $('#keys-btn');
  if (!b) return;
  $('#keys-state').textContent = st.ready ? 'Unlocked — encrypted packs open normally' : 'Locked — encrypted (NG) packs cannot be opened yet';
  b.innerHTML = st.ready ? icon('check') + 'Ready' : icon('zap') + 'Unlock';
  b.disabled = !!st.ready;
}

export function initKeys() {
  // One listener for the app's lifetime; updates the active unlock toast.
  api.onKeyProgress((p) => {
    const pct = Math.round(p * 100);
    if (!progressToast || pct === lastPct || pct % 5) return;
    lastPct = pct;
    progressToast.h.update({ type: 'loading', title: 'Unlocking encrypted RPFs…', message: 'Reading keys from ' + progressToast.name + ' · ' + pct + '%' });
  });
  const b = $('#keys-btn');
  if (b) b.onclick = () => ensureKeys('Unlock once so encrypted packs open in the Gun Lab and Sound Lab.');
  refreshKeyCard();
}
