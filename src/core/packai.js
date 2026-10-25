'use strict';
// The AI behind the Graphics AI chat. The player pastes an API key from any AI
// provider; the provider is worked out from the key (or a link they give), and the
// model is picked from the provider's own model list unless they choose one. The AI
// reads the player's message and answers with a short reply plus the pack changes as
// JSON; the renderer turns those into a spec (gfxai.js fromModel) and builds the pack
// the same way the offline reader does.
//
// Anthropic goes through its official SDK; everyone else is called as an OpenAI-style
// /chat/completions API (OpenAI, Google Gemini, xAI, Groq, OpenRouter, Mistral,
// DeepSeek, LM Studio, Ollama...).

const MOODS = ['pvp', 'sunny', 'sunset', 'sunrise', 'night', 'overcast', 'foggy', 'stormy', 'neon', 'vaporwave', 'winter', 'desert', 'apocalypse', 'cinematic', 'realistic'];
const OPS = ['more', 'less', 'none', 'bigger', 'smaller'];
const ADJUST = ['stars', 'moon', 'sun', 'clouds', 'fog', 'bloom', 'blur'];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const HEX = { type: 'string', description: 'hex colour like #ff2d55' };

/** What the model must return. Every field is present; null means "not mentioned". */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'patch'],
  properties: {
    reply: { type: 'string' },
    patch: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'mood', 'skyColour', 'tint', 'tintStrength', 'brightness', 'saturation', 'world', 'adjust', 'fps', 'constant', 'timeLock', 'imageUse'],
      properties: {
        name: nullable({ type: 'string' }),
        mood: nullable({ type: 'string', enum: MOODS }),
        skyColour: nullable(HEX),
        tint: nullable(HEX),
        tintStrength: nullable({ type: 'number' }),
        brightness: nullable({ type: 'number' }),
        saturation: nullable({ type: 'number' }),
        world: {
          type: 'object', additionalProperties: false, required: ['water', 'mountains', 'snow'],
          properties: { water: nullable({ type: 'string', enum: ['keep', 'remove'] }), mountains: nullable({ type: 'string', enum: ['keep', 'remove'] }), snow: nullable({ type: 'string', enum: ['keep', 'remove'] }) },
        },
        adjust: {
          type: 'object', additionalProperties: false, required: ADJUST,
          properties: Object.fromEntries(ADJUST.map((k) => [k, nullable({ type: 'string', enum: OPS })])),
        },
        fps: nullable({ type: 'integer', enum: [0, 1, 2, 3] }),
        constant: nullable({ type: 'boolean' }),
        timeLock: nullable({ type: 'string', enum: ['night', 'day'] }),
        imageUse: nullable({ type: 'string', enum: ['texture', 'colours'] }),
      },
    },
  },
};

const SYSTEM = `You build GTA V / FiveM graphics packs inside Kt Mod Manager. The player says what look they want; you answer with JSON matching the schema.

"reply": one or two short, casual sentences about what you're making. No lists, no markdown.
"patch": only what this message asks for; null for everything it does not mention. Follow-ups build on the current pack (given below), so only send the changes.
- mood: the overall look. "pvp" = competitive pack: clear view, no fog/glare/blur, punchy colours, steady FPS (not about day or night).
- skyColour: a hex colour when they name a sky colour. tint + tintStrength (0-1): colour grade over the whole game.
- brightness: -1..1 change. saturation: multiplier, 1 = unchanged, 0 = black and white.
- world: water/mountains/snow -> "remove" or "keep". "black mountains" means the far mountains: "no black mountains" = remove.
- adjust: stars, moon, sun, clouds, fog, bloom (glow), blur (distance blur) -> more / less / none / bigger / smaller.
- fps: 1 light, 2 normal, 3 max FPS boost.
- constant: true when the look should stay the same all day.
- timeLock: "night" for always night / no daytime, "day" for always day.
- imageUse: when a picture is attached: "texture" to use it as the actual sky, "colours" for only its colours.`;

// Provider from the key's prefix (or the link's host). OpenAI-style keys ("sk-") that are
// not OpenAI's need their link.
const PROVIDERS = [
  { name: 'Anthropic', key: /^sk-ant-/, host: /anthropic\.com$/, url: 'https://api.anthropic.com', anthropic: true },
  { name: 'OpenRouter', key: /^sk-or-/, host: /openrouter\.ai$/, url: 'https://openrouter.ai/api/v1' },
  { name: 'Groq', key: /^gsk_/, host: /groq\.com$/, url: 'https://api.groq.com/openai/v1' },
  { name: 'xAI', key: /^xai-/, host: /x\.ai$/, url: 'https://api.x.ai/v1' },
  { name: 'Google Gemini', key: /^AIza/, host: /googleapis\.com$/, url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'Mistral', key: null, host: /mistral\.ai$/, url: 'https://api.mistral.ai/v1' },
  { name: 'DeepSeek', key: null, host: /deepseek\.com$/, url: 'https://api.deepseek.com/v1' },
  { name: 'OpenAI', key: /^sk-/, host: /openai\.com$/, url: 'https://api.openai.com/v1' },
];

/** { name, url, anthropic } for a config, or null when neither the key nor a link says. */
function provider(cfg) {
  const host = hostOf(cfg.url);
  const key = String(cfg.key || '').trim();
  const byKey = key && PROVIDERS.find((x) => x.key && x.key.test(key));
  if (host) {
    const byHost = PROVIDERS.find((p) => p.host.test(host));
    if (byHost) return { ...byHost, url: cfg.url };
    // a proxy or local server: speaks Anthropic's API only when the key is an Anthropic key
    const local = LOCAL_GATEWAYS.find((g) => { try { return new URL(g.url).port === new URL(cfg.url).port && /^(localhost|127\.0\.0\.1)$/.test(host); } catch (e) { return false; } });
    return { name: local ? local.name : host, url: cfg.url, anthropic: !!(byKey && byKey.anthropic) };
  }
  return byKey ? { ...byKey } : null;
}

function isAnthropic(cfg) {
  const p = provider(cfg);
  return !!(p && p.anthropic);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function userText(input) {
  const ctx = {
    currentPack: input.spec || null,
    pictureAttached: !!input.hasImage,
    packFolderAttached: !!input.hasPack,
  };
  return 'Current state: ' + JSON.stringify(ctx) + '\n\nPlayer: ' + String(input.text || '(no text, just the picture)');
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not answer with JSON.');
  return JSON.parse(t.slice(start, end + 1));
}

// ---------- usage: what the provider says is left, from the last answer's headers ----------
let lastUsage = null; // { at, provider, tokens, requests: { limit, remaining, reset }, tokens: {...} }
const numH = (h, name) => { const v = h && h.get(name); return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
function limitsFrom(h) {
  const req = {
    limit: numH(h, 'x-ratelimit-limit-requests') ?? numH(h, 'anthropic-ratelimit-requests-limit'),
    remaining: numH(h, 'x-ratelimit-remaining-requests') ?? numH(h, 'anthropic-ratelimit-requests-remaining'),
    reset: (h && (h.get('x-ratelimit-reset-requests') || h.get('anthropic-ratelimit-requests-reset'))) || null,
  };
  const tok = {
    limit: numH(h, 'x-ratelimit-limit-tokens') ?? numH(h, 'anthropic-ratelimit-tokens-limit'),
    remaining: numH(h, 'x-ratelimit-remaining-tokens') ?? numH(h, 'anthropic-ratelimit-tokens-remaining'),
    reset: (h && (h.get('x-ratelimit-reset-tokens') || h.get('anthropic-ratelimit-tokens-reset'))) || null,
  };
  return { requests: req.limit != null || req.remaining != null ? req : null, tokens: tok.limit != null || tok.remaining != null ? tok : null };
}
function noteUsage(headers, tokens) {
  lastUsage = { at: Date.now(), tokensUsed: tokens || 0, ...limitsFrom(headers) };
}
function getLastUsage() { return lastUsage; }

function anthropicClient(cfg) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const base = /^https?:\/\//.test(cfg.url || '') ? cfg.url.replace(/\/v1\/messages\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') : undefined;
  return new Anthropic({ apiKey: cfg.key || undefined, baseURL: base, timeout: 60000, maxRetries: 1 });
}

async function askAnthropic(cfg, input, job = { system: SYSTEM, schema: SCHEMA }) {
  const client = anthropicClient(cfg);
  // server-side fallback: if the model declines, the API retries on a fallback model in the same call
  const { data: res, response } = await client.beta.messages.create({
    model: cfg.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: job.system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: job.schema } },
    messages: [{ role: 'user', content: job.user || userText(input) }],
  }).withResponse();
  noteUsage(response.headers, res.usage ? (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0) : 0);
  if (res.stop_reason === 'refusal') throw new Error('The AI declined that request.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

function chatUrl(url) {
  const u = String(url || '').replace(/\/$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

const authHeaders = (cfg) => (cfg.key ? { authorization: 'Bearer ' + cfg.key } : {});

async function askOpenAiStyle(cfg, input, fetchImpl = fetch, job = { system: SYSTEM, schema: SCHEMA }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: job.system + '\n\nAnswer with only a JSON object of this shape: ' + JSON.stringify(job.schema) },
      { role: 'user', content: job.user || userText(input) },
    ],
    response_format: { type: 'json_object' },
  };
  const post = (b) => fetchImpl(chatUrl(cfg.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(60000),
  });
  let r = await post(body);
  if (r.status === 400) { delete body.response_format; r = await post(body); } // some servers do not know response_format
  if (r.status === 429) { noteUsage(r.headers, 0); throw new Error('You have hit your AI limit for now. ' + (r.headers.get('retry-after') ? 'Try again in ' + r.headers.get('retry-after') + ' seconds.' : 'Wait a bit and try again.')); }
  if (!r.ok) throw new Error('The AI answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  noteUsage(r.headers, j.usage ? j.usage.total_tokens || 0 : 0);
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return parseJson(msg && msg.content);
}

/** The provider's chat models, best first for this job (fast, cheap, follows JSON). */
const PREFER = [/claude-opus-5-5/, /claude-sonnet-5-5/, /claude-sonnet/, /gpt-4o-mini/, /gpt-4\.1-mini/, /gpt-4o/, /gemini-.*flash/, /grok/, /llama-3\.3-70b/, /mistral-(small|medium)/, /deepseek-chat/, /llama/, /qwen/];
async function listModels(cfg, fetchImpl = fetch) {
  const p = provider(cfg);
  if (!p) throw new Error('This key is not one the app knows. Add your provider\'s API link too.');
  let ids = [];
  if (p.anthropic) {
    const page = await anthropicClient({ ...cfg, url: p.url }).models.list({ limit: 50 });
    ids = (page.data || []).map((m) => m.id);
  } else {
    const r = await fetchImpl(p.url.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models', { headers: authHeaders(cfg), signal: AbortSignal.timeout(30000) });
    if (r.status === 401 || r.status === 403) throw new Error('The API key was not accepted.');
    if (!r.ok) throw new Error('Could not get the model list (' + r.status + ').');
    const j = await r.json();
    ids = (j.data || j.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  }
  // drop models that are not for chat
  ids = ids.filter((id) => !/embed|whisper|tts|dall-e|image|audio|moderation|transcribe|realtime|search|vision-preview/i.test(id));
  const rank = (id) => { const i = PREFER.findIndex((re) => re.test(id)); return i < 0 ? PREFER.length : i; };
  return ids.sort((a, b) => rank(a) - rank(b));
}

/** input: { text, spec, hasImage, hasPack } -> { reply, patch }. cfg: { key, url?, model? };
 *  a missing model is picked from the provider's list. */
async function askPackAi(cfg, input, fetchImpl) {
  if (!cfg || (!cfg.key && !cfg.url)) throw new Error('No AI set up.');
  const p = provider(cfg);
  if (!p) throw new Error('This key is not one the app knows. Add your provider\'s API link too.');
  const full = { ...cfg, url: p.url, model: cfg.model || (await listModels(cfg, fetchImpl))[0] };
  if (!full.model) throw new Error('No chat model found for this key.');
  const out = p.anthropic ? await askAnthropic(full, input) : await askOpenAiStyle(full, input, fetchImpl);
  if (!out || typeof out.reply !== 'string' || typeof out.patch !== 'object' || !out.patch) throw new Error('The AI answer was missing parts.');
  return out;
}

// AI routers / local servers people run on their own PC (OpenAI-style API). A key that
// is not from a known provider, or one the provider it looks like refuses, is tried here.
const LOCAL_GATEWAYS = [
  { name: 'OmniRoute', url: 'http://localhost:20128/v1' },
  { name: 'LiteLLM', url: 'http://localhost:4000/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
];

/** Where this key works, when its first letters do not say: every OpenAI-style provider
 *  and every local gateway is asked for its model list with the key, all at once, and
 *  the first in list order that answers wins. { name, url } or null. */
async function findGateway(key, fetchImpl = fetch) {
  const places = [...PROVIDERS.filter((p) => !p.anthropic).map((p) => ({ name: p.name, url: p.url })), ...LOCAL_GATEWAYS];
  const ok = await Promise.all(places.map(async (g) => {
    try {
      const r = await fetchImpl(g.url.replace(/\/$/, '') + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return false;
      const j = await r.json();
      return Array.isArray(j.data || j.models);
    } catch (e) { return false; }
  }));
  const i = ok.indexOf(true);
  return i < 0 ? null : places[i];
}

/** Credits on an OpenRouter key: { used, limit, remaining } (dollars), or null elsewhere. */
async function credits(cfg, fetchImpl = fetch) {
  const p = provider(cfg);
  if (!p || p.name !== 'OpenRouter' || !cfg.key) return null;
  try {
    const r = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: authHeaders(cfg), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = (await r.json()).data || {};
    return { used: d.usage ?? null, limit: d.limit ?? null, remaining: d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null), free: !!d.is_free_tier };
  } catch (e) { return null; }
}

/** Any other job: { system, schema, user } -> the parsed JSON answer. */
async function askJson(cfg, job, fetchImpl) {
  if (!cfg || (!cfg.key && !cfg.url)) throw new Error('No AI set up.');
  const p = provider(cfg);
  if (!p) throw new Error('This key is not one the app knows. Add your provider\'s API link too.');
  const full = { ...cfg, url: p.url, model: cfg.model || (await listModels(cfg, fetchImpl))[0] };
  if (!full.model) throw new Error('No chat model found for this key.');
  return p.anthropic ? askAnthropic(full, null, job) : askOpenAiStyle(full, null, fetchImpl, job);
}

module.exports = { getLastUsage, credits, limitsFrom, findGateway, LOCAL_GATEWAYS, askJson, askPackAi, listModels, provider, chatUrl, isAnthropic, parseJson, SCHEMA, SYSTEM };
