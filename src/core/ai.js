'use strict';
// Optional Claude call for the Graphics AI. The built-in prompt reader works
// offline; with an API key, Claude writes the pack spec instead (it can also
// look at the attached image). Runs in the main process so the key never
// reaches the renderer.

const fs = require('fs');
const path = require('path');

const MODEL = 'claude-sonnet-5-5';
const URL = 'https://api.anthropic.com/v1/messages';

class AiKey {
  constructor(file) { this.file = file; }

  get() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).key || null; } catch (e) { return null; }
  }

  set(key) {
    key = String(key || '').trim();
    if (!key) { fs.rmSync(this.file, { force: true }); return false; }
    if (!/^sk-ant-[\w-]{10,}$/.test(key)) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-).');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ key }), { mode: 0o600 });
    return true;
  }
}

/** image: { mediaType: 'image/jpeg'|'image/png'|'image/webp'|'image/gif', data: base64 } */
async function askClaude({ key, system, prompt, image, fetchImpl = globalThis.fetch }) {
  if (!key) throw new Error('Add your Anthropic API key in Settings first.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Write a request first.');
  const content = [];
  if (image) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(image.mediaType) || typeof image.data !== 'string' || image.data.length > 6.5e6) {
      throw new Error('That image cannot be sent. Use a JPEG, PNG or WebP under 5 MB.');
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  }
  content.push({ type: 'text', text: prompt.slice(0, 4000) });
  let res;
  try {
    res = await fetchImpl(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: String(system || '').slice(0, 8000), messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error('Could not reach the Anthropic API: ' + (e && e.message ? e.message : e));
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) {
    const why = body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
    throw new Error(res.status === 401 ? 'The API key was rejected. Check it in Settings.' : 'Anthropic API error: ' + why);
  }
  const text = ((body && body.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new Error('The AI sent back an empty reply.');
  return text;
}

module.exports = { AiKey, askClaude, MODEL };
