'use strict';
// AI Mod Maker: the player says what mod they want ("optimise my game", "no lightning,
// darker nights"); the AI answers with a plan of changes to GTA V's own data files,
// and this turns the plan into real files built from the player's current ones:
//   visualsettings.dat   any line (draw distances, LOD, lights, coronas...)
//   weather.xml          any value of any weather type (rain, fog, wind, lightning...)
//   timecycle w_*.xml    any setting, set / multiplied / added, for chosen weathers
//   clouds.xml           still clouds
// Keys the AI makes up are skipped and listed, never written. The result installs like a
// graphics pack (citizen, switchable on the Mods page) or saves as an .rpf.

const { parseVS, setValues } = require('./visualsettings');
const { stillCloudsText, snowify } = require('./worldfiles');
const rpf = require('./rpf');

const VS = 'common/data/visualsettings.dat';
const WEATHER = 'common/data/levels/gta5/weather.xml';
const CLOUDS = 'common/data/clouds.xml';
const TC_DIR = 'common/data/timecycle/';
const WEATHERS = ['EXTRASUNNY', 'CLEAR', 'CLOUDS', 'SMOG', 'FOGGY', 'OVERCAST', 'RAIN', 'THUNDER', 'CLEARING', 'NEUTRAL', 'SNOW', 'BLIZZARD', 'SNOWLIGHT', 'XMAS', 'HALLOWEEN'];
const WEATHER_FIELDS = ['Sun', 'Cloud', 'WindMin', 'WindMax', 'Rain', 'Snow', 'SnowMist', 'Fog', 'Lightning', 'Sandstorm',
  'RippleBumpiness', 'RippleMinBumpiness', 'RippleMaxBumpiness', 'RippleBumpinessWindScale', 'RippleScale', 'RippleSpeed', 'RippleVelocityTransfer',
  'OceanBumpiness', 'DeepOceanScale', 'OceanNoiseMinAmplitude', 'OceanWaveAmplitude', 'ShoreWaveAmplitude', 'OceanWaveWindScale', 'ShoreWaveWindScale',
  'OceanWaveMinAmplitude', 'ShoreWaveMinAmplitude', 'OceanWaveMaxAmplitude', 'ShoreWaveMaxAmplitude', 'OceanFoamIntensity', 'OceanFoamScale', 'RippleDisturb'];

const tcRel = (w) => TC_DIR + 'w_' + w.toLowerCase() + '.xml';
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const MOD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'name', 'visualsettings', 'weather', 'timecycle', 'stillClouds', 'snow', 'unsupported'],
  properties: {
    reply: { type: 'string' },
    name: nullable({ type: 'string' }),
    visualsettings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'number' } } } },
    weather: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['weather', 'field', 'value'], properties: { weather: { type: 'string' }, field: { type: 'string', enum: WEATHER_FIELDS }, value: { type: 'number' } } } },
    timecycle: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['param', 'op', 'value', 'weathers'], properties: { param: { type: 'string' }, op: { type: 'string', enum: ['set', 'multiply', 'add'] }, value: { type: 'number' }, weathers: { type: 'string' } } } },
    stillClouds: nullable({ type: 'boolean' }),
    snow: nullable({ type: 'number' }),
    unsupported: { type: 'array', items: { type: 'string' } },
  },
};

const MOD_SYSTEM = `You make GTA V / FiveM mods inside Kt Mod Manager. The player describes a mod; you answer with JSON matching the schema. The app builds the files from the player's own game files and packs them into an .rpf.

What you can change (and only this):
- "visualsettings": lines of visualsettings.dat, { key, value }. Only keys from the list you are given. For FPS / optimisation lower LOD and light distances (car.lod.distance.*, lod.fadedist.*, distantlights.*, misc.coronas.*, ped.lod.distance.*), never to 0 unless asked.
- "weather": values in weather.xml, { weather: a weather name or "ALL", field, value }. Lightning 0 = no lightning; Rain 0 = no rain; Fog 0 = no fog.
- "timecycle": settings in the weather timecycles (w_*.xml), { param, op: set | multiply | add, value, weathers: "ALL" or a comma list like "EXTRASUNNY,CLEAR" }. Only params from the list you are given. Colours are three params (name_r, name_g, name_b, 0-1 values). Turning off blur/depth of field, glow or fog helps FPS and visibility.
- "stillClouds": true to stop clouds moving. "snow": 0-1 for snow in every weather, null to leave it.

"unsupported": for anything asked that is not in the list above (car or ped models, clothes, textures, scripts, handling, sounds), one short plain line each, e.g. "Recolouring people's clothes needs their texture files, which this can't change yet." Never pretend you did it.
"reply": one or two short, casual sentences about the mod. No lists, no markdown. "name": a short mod name.
Follow-ups change the mod you made last time (given as "current mod"); send the whole mod again with the change.`;

/** The lists the AI chooses from, from the player's own files. */
function modContext(read) {
  const vs = read(VS);
  const tc = read(tcRel('EXTRASUNNY')) || read(tcRel('CLEAR')) || '';
  const params = [...new Set([...tc.matchAll(/<([a-z][a-z0-9_]*)>\s*-?[\d.]/gi)].map((m) => m[1]))];
  return {
    visualsettings: vs ? parseVS(vs).map((e) => e.key + ' ' + e.value) : [],
    timecycleParams: params,
    weathers: WEATHERS,
  };
}

function userMessage(text, ctx, current) {
  return [
    'visualsettings.dat now (key value):\n' + (ctx.visualsettings.join('\n') || '(not found)'),
    'Timecycle params: ' + (ctx.timecycleParams.join(' ') || '(not found)'),
    'Weathers: ' + ctx.weathers.join(', '),
    current ? 'Current mod: ' + JSON.stringify(current) : '',
    'Player: ' + String(text || ''),
  ].filter(Boolean).join('\n\n');
}

const num = (v) => String(Number(Number(v).toFixed(4)));

/** plan (the AI's JSON) + read(rel) -> { name, files: { rel: text }, done: [line], skipped: [line] } */
function buildMod(plan, read) {
  const files = {};
  const done = [];
  const skipped = [...(plan.unsupported || [])];
  const get = (rel) => (rel in files ? files[rel] : read(rel));

  // visualsettings.dat
  const vsItems = (plan.visualsettings || []).filter((x) => x && x.key && Number.isFinite(+x.value));
  if (vsItems.length) {
    const base = get(VS);
    if (base == null) skipped.push('visualsettings.dat was not found in your game.');
    else {
      const have = new Set(parseVS(base).map((e) => e.key));
      const changes = {};
      for (const x of vsItems) {
        if (have.has(x.key)) changes[x.key] = +x.value;
        else skipped.push('No setting called ' + x.key + ' in visualsettings.dat.');
      }
      if (Object.keys(changes).length) {
        files[VS] = setValues(base, changes);
        done.push(...Object.entries(changes).map(([k, v]) => 'visualsettings: ' + k + ' → ' + num(v)));
      }
    }
  }

  // weather.xml
  const wItems = (plan.weather || []).filter((x) => x && WEATHER_FIELDS.includes(x.field) && Number.isFinite(+x.value));
  if (wItems.length || plan.snow) {
    let text = get(WEATHER);
    if (text == null) skipped.push('weather.xml was not found in your game.');
    else {
      for (const x of wItems) {
        const all = !x.weather || /^all$/i.test(x.weather);
        let hit = 0;
        text = text.replace(/<Item>[\s\S]*?<\/Item>/g, (it) => {
          const name = (/<Name>\s*([^<\s]+)\s*<\/Name>/.exec(it) || [])[1] || '';
          if (!all && name.toUpperCase() !== String(x.weather).toUpperCase()) return it;
          const re = new RegExp('(<' + x.field + '\\s+value=")[^"]*(")');
          if (!re.test(it)) return it;
          hit++;
          return it.replace(re, '$1' + (+x.value).toFixed(6) + '$2');
        });
        if (hit) done.push('weather: ' + x.field + ' → ' + num(x.value) + (all ? ' in every weather' : ' in ' + x.weather));
        else skipped.push('weather.xml has no ' + x.field + (all ? '' : ' for ' + x.weather) + '.');
      }
      const snow = Math.max(0, Math.min(1, +plan.snow || 0));
      if (snow) { text = snowify(text, snow); done.push('snow in every weather (' + Math.round(snow * 100) + '%)'); }
      files[WEATHER] = text;
    }
  }

  // timecycles
  for (const x of (plan.timecycle || []).filter((t) => t && t.param && Number.isFinite(+t.value))) {
    const list = !x.weathers || /^all$/i.test(x.weathers) ? WEATHERS : String(x.weathers).split(/[\s,]+/).filter(Boolean).map((w) => w.toUpperCase());
    const re = new RegExp('(<' + x.param.replace(/[^a-z0-9_]/gi, '') + '>)([^<]*)(</' + x.param.replace(/[^a-z0-9_]/gi, '') + '>)', 'gi');
    let nFiles = 0;
    for (const w of list) {
      const rel = tcRel(w);
      const base = get(rel);
      if (base == null || !re.test(base)) continue;
      re.lastIndex = 0;
      files[rel] = base.replace(re, (m, a, body, b) => a + body.trim().split(/\s+/).map((v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return v;
        const out = x.op === 'set' ? +x.value : x.op === 'add' ? n + +x.value : n * +x.value;
        return num(Math.max(0, out));
      }).join(' ') + b);
      nFiles++;
    }
    if (nFiles) done.push('timecycle: ' + x.param + ' ' + (x.op === 'set' ? '= ' : x.op === 'add' ? '+ ' : '× ') + num(x.value) + ' (' + nFiles + ' weather' + (nFiles === 1 ? '' : 's') + ')');
    else skipped.push('No timecycle setting called ' + x.param + '.');
  }

  // clouds
  if (plan.stillClouds) {
    const base = get(CLOUDS);
    if (base == null || !/<mAngularVelocity\b/.test(base)) skipped.push('clouds.xml was not found in your game.');
    else { files[CLOUDS] = stillCloudsText(base); done.push('clouds stay still'); }
  }

  return { name: String(plan.name || 'AI mod').replace(/[^\w .()-]/g, '').trim().slice(0, 40) || 'AI mod', files, done, skipped };
}

/** The mod's files as an .rpf, laid out at their game paths (common/data/...). */
function modRpf(files) {
  const root = { type: 'dir', name: '', children: [] };
  for (const [rel, text] of Object.entries(files)) {
    const parts = rel.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.children.find((c) => c.type === 'dir' && c.name === p);
      if (!next) { next = { type: 'dir', name: p, children: [] }; dir.children.push(next); }
      dir = next;
    }
    const data = Buffer.from(text, 'utf8');
    dir.children.push({ type: 'bin', name: parts[parts.length - 1], stored: data, compressed: false, size: data.length });
  }
  return rpf.writeRpf(root);
}

module.exports = { MOD_SCHEMA, MOD_SYSTEM, modContext, userMessage, buildMod, modRpf, WEATHER_FIELDS, WEATHERS };
