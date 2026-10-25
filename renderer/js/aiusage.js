// How much AI is left: what the provider reported on the last answer (requests and
// tokens left in its current window), OpenRouter credits, and what was used today.
const api = window.api;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => Number(v).toLocaleString();
const WHERE = { 'Google Gemini': 'aistudio.google.com (Usage)', Groq: 'console.groq.com (Settings → Limits)', OpenAI: 'platform.openai.com (Usage)', Anthropic: 'console.anthropic.com (Usage)' };

function bar(label, x) {
  if (!x || x.remaining == null) return '';
  const pct = x.limit ? Math.max(0, Math.min(100, (x.remaining / x.limit) * 100)) : 100;
  return `<div class="u-row"><span>${label} left</span><b>${n(x.remaining)}${x.limit ? ' / ' + n(x.limit) : ''}</b></div>
    <div class="u-bar ${pct < 15 ? 'low' : ''}"><i style="width:${pct}%"></i></div>${x.reset ? `<small>Refills in ${esc(x.reset)}</small>` : ''}`;
}

/** One line: "27 / 30 requests · 600 / 6,000 tokens left · 12 today". */
function compactHtml(u) {
  const bits = [];
  const fmt = (x, what) => (x && x.remaining != null ? n(x.remaining) + (x.limit ? ' / ' + n(x.limit) : '') + ' ' + what : '');
  if (u.credits && u.credits.remaining != null) bits.push('$' + Number(u.credits.remaining).toFixed(2) + ' credit');
  if (u.last) bits.push(...[fmt(u.last.requests, 'requests'), fmt(u.last.tokens, 'tokens')].filter(Boolean));
  const low = u.last && [u.last.requests, u.last.tokens].some((x) => x && x.limit && x.remaining / x.limit < 0.15);
  return `<div class="u-line ${low ? 'low' : ''}"><span>${bits.length ? esc(bits.join(' · ')) + ' left' : esc(u.provider) + ' AI'}</span><b>${n(u.today.requests)} today</b></div>`;
}

export function usageHtml(u, compact = false) {
  if (!u || !u.provider) return '';
  if (compact) return compactHtml(u);
  const parts = [];
  if (u.credits) {
    const c = u.credits;
    parts.push(c.limit != null
      ? `<div class="u-row"><span>Credit left</span><b>$${Number(c.remaining).toFixed(2)} / $${Number(c.limit).toFixed(2)}</b></div><div class="u-bar ${c.remaining / c.limit < 0.15 ? 'low' : ''}"><i style="width:${Math.max(0, Math.min(100, (c.remaining / c.limit) * 100))}%"></i></div>`
      : `<div class="u-row"><span>Credit used</span><b>$${Number(c.used || 0).toFixed(2)}${c.free ? ' · free tier' : ''}</b></div>`);
  }
  if (u.last) parts.push(bar('Requests', u.last.requests) + bar('Tokens', u.last.tokens));
  const known = parts.join('').trim();
  const fresh = u.last ? Math.round((Date.now() - u.last.at) / 60000) : null;
  return `<div class="ai-usage-in">
    ${known || `<small>${esc(u.provider)} does not tell apps how much is left${WHERE[u.provider] ? '. See it at ' + esc(WHERE[u.provider]) : ''}.</small>`}
    ${known && fresh != null ? `<small>As of ${fresh < 1 ? 'your last message' : fresh + ' min ago'}</small>` : ''}
    <div class="u-row today"><span>Used today</span><b>${n(u.today.requests)} request${u.today.requests === 1 ? '' : 's'}${u.today.tokens ? ' · ' + n(u.today.tokens) + ' tokens' : ''}</b></div>
  </div>`;
}

export async function paintUsage(el) {
  if (!el) return;
  const u = await api.call('ai:usage').catch(() => null);
  el.innerHTML = usageHtml(u, el.classList.contains('mini'));
  el.classList.toggle('hidden', !el.innerHTML.trim());
}
