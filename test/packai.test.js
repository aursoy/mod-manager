'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { askPackAi, chatUrl, isAnthropic, parseJson } = require('../src/core/packai');
const aiP = import('../renderer/js/gfxai.js');

const answer = { reply: 'PvP pack, no fog, black sky.', patch: { name: null, mood: 'pvp', skyColour: '#000000', tint: null, tintStrength: null, brightness: 0.2, saturation: null, world: { water: 'remove', mountains: null, snow: null }, adjust: { stars: 'more', moon: null, sun: 'none', clouds: null, fog: null, bloom: null, blur: null }, fps: 3, constant: true, timeLock: 'night', imageUse: null } };

test('AI link: OpenAI-style links get the chat endpoint, the key and a JSON answer', async () => {
  assert.strictEqual(chatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(chatUrl('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
  assert.strictEqual(chatUrl('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(isAnthropic({ url: 'https://api.anthropic.com' }) && isAnthropic({ url: 'https://x.example', key: 'sk-ant-abc' }) && !isAnthropic({ url: 'https://api.openai.com/v1', key: 'sk-proj' }));
  const calls = [];
  const fake = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.authorization, body });
    if (body.response_format) return { ok: false, status: 400, text: async () => 'unknown field response_format' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(answer) + '\n```' } }] }) };
  };
  const out = await askPackAi({ url: 'https://llm.example/v1', key: 'k1', model: 'm1' }, { text: 'pvp pack black sky max fps', spec: null }, fake);
  assert.deepStrictEqual(out, answer);
  assert.strictEqual(calls.length, 2, 'retried without response_format');
  assert.strictEqual(calls[0].auth, 'Bearer k1');
  assert.strictEqual(calls[1].body.model, 'm1');
  assert.ok(calls[1].body.messages[1].content.includes('pvp pack black sky max fps'));
  await assert.rejects(askPackAi({ url: 'https://llm.example/v1' }, { text: 'x' }, fake), /model name/);
  assert.throws(() => parseJson('sorry, no'), /JSON/);
});

test('AI link: the answer becomes the same kind of spec the offline reader makes', async () => {
  const ai = await aiP;
  const p = ai.fromModel(answer.patch);
  assert.strictEqual(p.mood, 'pvp');
  assert.strictEqual(p.fps, 3, 'their fps wins over the pvp default');
  assert.strictEqual(p.world.water, 'remove');
  assert.deepStrictEqual(p.adjust, { fog: 'none', bloom: 'none', blur: 'none', stars: 'more', sun: 'none' });
  assert.strictEqual(p.timeLock, 'night');
  assert.ok(p.sky && p.sky.zenith, 'sky colour turned into a sky palette');
  assert.strictEqual(p.grade.brightness, 0.2);
  const junk = ai.fromModel({ mood: 'nope', skyColour: 'red', fps: 9, world: { water: 'maybe' }, brightness: 7 });
  assert.strictEqual(junk.mood, undefined);
  assert.strictEqual(junk.sky, undefined);
  assert.strictEqual(junk.fps, undefined);
  assert.deepStrictEqual(junk.world, {});
  assert.strictEqual(junk.grade.brightness, 1, 'clamped');
  const spec = ai.mergeSpec(ai.emptySpec(), p);
  assert.ok(!ai.isEmptySpec(spec));
});
