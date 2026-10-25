'use strict';
// Pack AI over an API link. The model reads the player's message and answers with
// a short reply plus the pack changes as JSON; the renderer turns those into a spec
// (gfxai.js fromModel) and builds the pack the same way the offline reader does.
//
// Links: Anthropic (api.anthropic.com, or an sk-ant- key) goes through the official
// SDK; anything else is called as an OpenAI-style /chat/completions endpoint
// (OpenAI, OpenRouter, Groq, LM Studio, Ollama...).

const MOODS = ['pvp', 'sunny', 'sunset', 'sunrise', 'night', 'overcast', 'foggy', 'stormy', 'neon', 'vaporwave', 'winter', 'desert', 'apocalypse', 'cinematic', 'realistic'];
const OPS = ['more', 'less', 'none', 'bigger', 'smaller'];
const ADJUST = ['stars', 'moon', 'sun', 'clouds', 'fog', 'bloom', 'blur'];
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

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

function isAnthropic(cfg) {
  return /(^|\.)anthropic\.com/i.test(hostOf(cfg.url)) || /^sk-ant-/.test(cfg.key || '');
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

async function askAnthropic(cfg, input) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const base = /^https?:\/\//.test(cfg.url || '') ? cfg.url.replace(/\/v1\/messages\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') : undefined;
  const client = new Anthropic({ apiKey: cfg.key || undefined, baseURL: base, timeout: 60000, maxRetries: 1 });
  // server-side fallback: if the model declines, the API retries on a fallback model in the same call
  const res = await client.beta.messages.create({
    model: cfg.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: userText(input) }],
  });
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

async function askOpenAiStyle(cfg, input, fetchImpl = fetch) {
  if (!cfg.model) throw new Error('Add the model name for this API link in Settings.');
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM + '\n\nAnswer with only a JSON object of this shape: ' + JSON.stringify(SCHEMA) },
      { role: 'user', content: userText(input) },
    ],
    response_format: { type: 'json_object' },
  };
  const post = (b) => fetchImpl(chatUrl(cfg.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: 'Bearer ' + cfg.key } : {}) },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(60000),
  });
  let r = await post(body);
  if (r.status === 400) { delete body.response_format; r = await post(body); } // some servers do not know response_format
  if (!r.ok) throw new Error('The AI link answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return parseJson(msg && msg.content);
}

/** input: { text, spec, hasImage, hasPack } -> { reply, patch } */
async function askPackAi(cfg, input, fetchImpl) {
  if (!cfg || !cfg.url) throw new Error('No AI link set.');
  const out = isAnthropic(cfg) ? await askAnthropic(cfg, input) : await askOpenAiStyle(cfg, input, fetchImpl);
  if (!out || typeof out.reply !== 'string' || typeof out.patch !== 'object' || !out.patch) throw new Error('The AI answer was missing parts.');
  return out;
}

module.exports = { askPackAi, chatUrl, isAnthropic, parseJson, SCHEMA, SYSTEM, DEFAULT_ANTHROPIC_MODEL };
