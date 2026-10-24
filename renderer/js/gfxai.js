// Graphics-pack AI. Pure logic, no DOM or Node, shared by the UI and the tests.
//
//   prompt (+ image)  ->  spec  ->  buildPack(spec, timecycle files)  ->  edited files + tweak switches
//
// The spec comes from a built-in prompt reader that works offline. When the user
// has added an Anthropic API key, Claude can write the spec instead (see
// LLM_SYSTEM and validateSpec); the pack builder is the same either way.

import { parse, serialize, keyHours, daylight, twilight, mix, lum, clamp01, hexToRgb, rgbToHex, gradeColours, setColour } from './timecycle.js';

const WORLD_KEYS = ['water', 'mountains', 'trees', 'bushes', 'props'];
export const WORLD_LABEL = { water: 'Water', mountains: 'Black mountains', trees: 'Trees', bushes: 'Bushes', props: 'Props' };
const GRADE_GROUPS = ['sky', 'sun', 'cloud', 'light', 'ambient', 'fog'];

export const emptySpec = () => ({ name: '', mood: null, sky: null, grade: null, world: {}, fps: 0, constant: false });

// ---------- moods ----------
// Each mood is a "midday" sky palette plus an optional grade. `constant` keeps the
// look at every hour instead of fading to a normal night.
export const MOODS = {
  sunny: { label: 'Sunny', words: /\b(sunny|clear|bright day|blue sky|summer)\b/, sky: ['#2f7de1', '#bfe0ff', '#fff3c8', '#ffffff', '#cfe4f5'], grade: { saturation: 1.1, brightness: 0.05 } },
  sunset: { label: 'Sunset', words: /\b(sunset|golden hour|dusk|evening)\b/, constant: true, sky: ['#3a4a8c', '#ff8a3d', '#ffd08a', '#ff9d6b', '#ffb27a'], grade: { tint: '#ffa060', strength: 0.25, saturation: 1.1 } },
  sunrise: { label: 'Sunrise', words: /\b(sunrise|dawn|morning)\b/, constant: true, sky: ['#5b6fb5', '#ffb199', '#ffe3b0', '#ffc9b0', '#f2c1b5'], grade: { tint: '#ffc0a0', strength: 0.18 } },
  night: { label: 'Night', words: /\b(night|moonlit|moonlight|midnight)\b/, constant: true, sky: ['#05071a', '#1b2347', '#8a9bd8', '#2a3158', '#141a33'], grade: { tint: '#6080ff', strength: 0.2, brightness: -0.1 } },
  overcast: { label: 'Overcast', words: /\b(overcast|cloudy|grey|gray|dull)\b/, sky: ['#8a929c', '#b4bac2', '#d8dce0', '#c4c9cf', '#aeb4bb'], grade: { saturation: 0.7 } },
  foggy: { label: 'Foggy', words: /\b(fog|foggy|misty|mist|haze|hazy)\b/, sky: ['#a9b4bd', '#d3dadf', '#e6eaed', '#cfd6db', '#cfd6db'], grade: { saturation: 0.6 } },
  stormy: { label: 'Stormy', words: /\b(storm|stormy|rain|rainy|thunder)\b/, sky: ['#3b434d', '#6b747e', '#9aa3ad', '#4a525c', '#636c76'], grade: { saturation: 0.7, brightness: -0.15 } },
  neon: { label: 'Neon', words: /\b(neon|cyberpunk|synthwave|retrowave|outrun)\b/, constant: true, sky: ['#1a0b3d', '#ff2e97', '#00e5ff', '#8a3dff', '#3a1a6e'], grade: { tint: '#b050ff', strength: 0.3, saturation: 1.4 } },
  vaporwave: { label: 'Vaporwave', words: /\b(vaporwave|pastel|candy)\b/, constant: true, sky: ['#7b6bff', '#ff9ed8', '#fff1a8', '#ffc4ec', '#d9a8ff'], grade: { saturation: 1.15 } },
  winter: { label: 'Winter', words: /\b(winter|snow|snowy|icy|frozen|arctic)\b/, sky: ['#6fa0d6', '#e0f0ff', '#ffffff', '#f2f8ff', '#e6f1fa'], grade: { tint: '#a0c8ff', strength: 0.2 } },
  desert: { label: 'Desert', words: /\b(desert|hot|scorching|arid)\b/, sky: ['#4f8fd8', '#ffd9a0', '#fff0c0', '#fff4e0', '#f2d9b0'], grade: { tint: '#ffb060', strength: 0.22 } },
  apocalypse: { label: 'Apocalypse', words: /\b(apocalypse|apocalyptic|hell|doom|blood sky)\b/, constant: true, sky: ['#3a0a0a', '#ff3a1a', '#ffb060', '#6a1a10', '#5a2418'], grade: { tint: '#ff4020', strength: 0.3, saturation: 0.9 } },
  cinematic: { label: 'Cinematic', words: /\b(cinematic|film|movie|teal and orange|teal orange)\b/, sky: ['#1f5f7a', '#ffb27a', '#ffe0b0', '#ffd0a0', '#8fb5c0'], grade: { tint: '#ff9a50', strength: 0.15, saturation: 1.15 } },
  realistic: { label: 'Realistic', words: /\b(realistic|natural|real life|photoreal|lifelike)\b/, grade: { saturation: 0.92 } },
};

const COLOURS = {
  red: '#e02424', orange: '#ff8a1f', yellow: '#ffd21f', gold: '#ffc533', green: '#2fd04a', lime: '#9dff3a', teal: '#1fd1b5',
  cyan: '#1fe5ff', blue: '#2f7dff', purple: '#9b4dff', violet: '#8a5cff', pink: '#ff5fa8', magenta: '#ff2ee0', white: '#ffffff', black: '#0a0a0a',
};

export const EXAMPLES = [
  'Sunset sky, no water, FPS boost',
  'Neon cyberpunk night with no trees or bushes',
  'Realistic colours, keep water, remove black mountains',
  'Max FPS pack: no props, no trees, no bushes, no water',
  'Dark moody overcast, a bit more saturated',
];

// ---------- image palette ----------

/** Reads a sky palette from pixels (RGBA, 0-255). Top of the image becomes the
 *  zenith, the bottom the horizon, the brightest spot the sun. */
export function extractPalette({ data, width, height }) {
  const bands = [[0, 0.3], [0.3, 0.6], [0.6, 1]].map(([a, b]) => ({ a: Math.floor(a * height), b: Math.max(Math.floor(b * height), Math.floor(a * height) + 1), sum: [0, 0, 0], n: 0 }));
  const bright = [];
  const clouds = { sum: [0, 0, 0], n: 0 };
  let lumSum = 0;
  let satSum = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  for (let y = 0; y < height; y += step) {
    const band = bands.find((x) => y >= x.a && y < x.b);
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 8) continue;
      const c = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
      const l = lum(c);
      const mx = Math.max(...c);
      const sat = mx ? (mx - Math.min(...c)) / mx : 0;
      lumSum += l; satSum += sat;
      if (band) { band.sum[0] += c[0]; band.sum[1] += c[1]; band.sum[2] += c[2]; band.n++; }
      bright.push([l, c]);
      if (l > 0.6 && sat < 0.3) { clouds.sum[0] += c[0]; clouds.sum[1] += c[1]; clouds.sum[2] += c[2]; clouds.n++; }
    }
  }
  const total = bright.length || 1;
  const avg = (b) => (b.n ? b.sum.map((s) => s / b.n) : [0.5, 0.5, 0.5]);
  const [zenith, mid, horizon] = bands.map(avg);
  bright.sort((p, q) => q[0] - p[0]);
  const top = bright.slice(0, Math.max(1, Math.ceil(bright.length * 0.01)));
  let sun = top.reduce((s, [, c]) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]).map((x) => x / top.length);
  if (lum(sun) < 0.6) sun = mix(horizon, [1, 1, 1], 0.5);
  const cloud = clouds.n > 8 ? clouds.sum.map((s) => s / clouds.n) : mix(mid, [1, 1, 1], 0.4);
  const fog = mix(horizon, [lum(horizon), lum(horizon), lum(horizon)], 0.45);
  return {
    zenith: rgbToHex(zenith), horizon: rgbToHex(mix(horizon, mid, 0.25)), sun: rgbToHex(sun), cloud: rgbToHex(cloud), fog: rgbToHex(fog),
    brightness: lumSum / total, saturation: satSum / total,
  };
}

/** A whole sky from one colour. */
export function skyFromColour(hex) {
  const c = hexToRgb(hex);
  const grey = lum(c);
  return {
    zenith: rgbToHex(mix(c, [0, 0, 0], 0.45)),
    horizon: rgbToHex(mix(c, [1, 1, 1], 0.35)),
    sun: rgbToHex(mix(c, [1, 1, 1], 0.75)),
    cloud: rgbToHex(mix(mix(c, [1, 1, 1], 0.55), [grey, grey, grey], 0.3)),
    fog: rgbToHex(mix(mix(c, [1, 1, 1], 0.3), [grey, grey, grey], 0.4)),
  };
}

const skyOf = (arr) => ({ zenith: arr[0], horizon: arr[1], sun: arr[2], cloud: arr[3], fog: arr[4] });

// ---------- prompt reader ----------

const FEATURES = {
  water: /\b(water|ocean|sea|rivers?|lakes?)\b/,
  mountains: /\b(black\s+mountains?|mountains?)\b/,
  trees: /\b(trees?|forests?|foliage)\b/,
  bushes: /\b(bush(?:es)?|shrubs?|grass|foliage|plants?)\b/,
  props: /\b(props?|clutter|debris)\b/,
};
const NEG = /\b(no|without|remove|removed|removing|hide|delete|disable|disabled|kill|get rid of|zero|none|turn off|nothing)\b/;
const POS = /\b(have|with|keep|add|show|restore|enable|enabled|bring back|include|turn on)\b/;

/** Reads a prompt into a spec patch. Only fields the prompt mentions are set. */
export function parsePrompt(text) {
  const raw = String(text || '').replace(/[“”]/g, '"');
  const patch = { world: {} };

  // name, then take it out so "called Night City" is not read as a night mood
  const nm = /\b(?:called|named|name it)\s+"?([^",.\n]{2,40})"?/i.exec(raw);
  if (nm) patch.name = nm[1].trim();
  const t = (nm ? raw.replace(nm[0], ' ') : raw).toLowerCase();

  // world switches, clause by clause so "no trees, have bushes" works
  const clauses = t.split(/[,;.\n]|\b(?:and|or|but|also|then|plus)\b/).map((c) => c.trim()).filter(Boolean);
  let last = null;
  for (const c of clauses) {
    const words = c.split(/\s+/).length;
    let pol = NEG.test(c) ? 'remove' : POS.test(c) ? 'keep' : null;
    if (!pol && words <= 3 && last) pol = last;
    const hits = Object.entries(FEATURES).filter(([, re]) => re.test(c)).map(([k]) => k);
    if (/\bfoliage\b/.test(c)) for (const k of ['trees', 'bushes']) if (!hits.includes(k)) hits.push(k);
    if (/\bnature\b/.test(c)) for (const k of ['trees', 'bushes']) if (!hits.includes(k)) hits.push(k);
    if (pol && hits.length) for (const k of hits) patch.world[k] = pol;
    if (pol) last = pol;
    else if (!hits.length && words > 3) last = null;
  }

  // fps
  if (/\b(fps|performance|boost|lag|laggy|potato|low[- ]end|optimi[sz]e[ds]?|faster|smoother|smooth)\b/.test(t) && !/\bno (fps|boost)\b/.test(t)) {
    patch.fps = /\b(max|maximum|extreme|ultra|potato|lowest|best fps|insane)\b/.test(t) ? 3 : /\b(light|slight|small|bit|little)\b/.test(t) ? 1 : 2;
  }

  // mood
  let strengthMul = 1;
  if (/\b(slight(ly)?|subtle|a (little|bit)|gentle)\b/.test(t)) strengthMul = 0.5;
  else if (/\b(very|super|extreme(ly)?|heavy|strong(ly)?|intense|max)\b/.test(t)) strengthMul = 1.4;
  const moodHit = Object.entries(MOODS).find(([, m]) => m.words.test(t));
  if (moodHit) {
    const [id, m] = moodHit;
    patch.mood = id;
    if (m.sky) patch.sky = { ...skyOf(m.sky), strength: 0.85 };
    if (m.constant) patch.constant = true;
    patch.grade = { ...(m.grade || {}) };
    if (patch.grade.strength != null) patch.grade.strength = clamp01(patch.grade.strength * strengthMul);
  }

  // colour words ("purple sky", "red tint"). "black mountains" is a map feature, not a colour.
  const tc = t.replace(/black\s+mountains?/g, ' ');
  const colHit = Object.keys(COLOURS).find((c) => new RegExp('\\b' + c + '\\b').test(tc));
  const hexHit = /#[0-9a-f]{6}\b/.exec(tc);
  const colour = hexHit ? hexHit[0] : colHit ? COLOURS[colHit] : null;
  if (colour) {
    const gradeOnly = /\b(tint|grade|filter|overlay)\b/.test(tc) && !/\bsky\b/.test(tc);
    const moodHasSky = moodHit && MOODS[moodHit[0]].sky;
    if (!gradeOnly && !moodHasSky) patch.sky = { ...skyFromColour(colour), strength: 0.85 };
    if (gradeOnly || !moodHit) patch.grade = { ...(patch.grade || {}), tint: colour, strength: clamp01((gradeOnly ? 0.5 : 0.22) * strengthMul) };
  }

  // brightness / saturation words
  const g = () => (patch.grade = patch.grade || {});
  if (/\b(brighter|lighter|more light|bright(?!\s+day))\b/.test(t)) g().brightness = (g().brightness || 0) + 0.25 * strengthMul;
  if (/\b(darker|dimmer|dim|moody|more dark|dark)\b/.test(t) && !patch.mood) g().brightness = (g().brightness || 0) - 0.25 * strengthMul;
  else if (/\b(darker|dimmer|moody)\b/.test(t)) g().brightness = (g().brightness || 0) - 0.2 * strengthMul;
  if (/\b(vibrant|saturated|colou?rful|vivid|pop)\b/.test(t) && !/desaturated/.test(t)) g().saturation = (g().saturation || 1) * (1 + 0.3 * strengthMul);
  if (/\b(desaturated|muted|washed|faded)\b/.test(t)) g().saturation = (g().saturation || 1) * (1 - 0.3 * strengthMul);
  if (/\b(black and white|black & white|monochrome|greyscale|grayscale)\b/.test(t)) g().saturation = 0;
  if (patch.grade && !Object.keys(patch.grade).length) delete patch.grade;

  if (/\b(always|all day|forever|permanent(ly)?|constant(ly)?|24\/?7)\b/.test(t)) patch.constant = true;
  return patch;
}

/** Layer a patch on top of a spec (used for "now make it darker" follow-ups). */
export function mergeSpec(base, patch) {
  const out = JSON.parse(JSON.stringify(base || emptySpec()));
  if (patch.name) out.name = patch.name;
  if (patch.mood) out.mood = patch.mood;
  if (patch.sky) out.sky = { ...patch.sky };
  if (patch.constant != null) out.constant = patch.constant;
  if (patch.fps != null) out.fps = patch.fps;
  out.world = { ...(out.world || {}), ...(patch.world || {}) };
  if (patch.grade) {
    const a = out.grade || {};
    const b = patch.grade;
    out.grade = { ...a, ...b };
    if (b.brightness != null && a.brightness != null && !patch._replaceGrade) out.grade.brightness = Math.max(-1, Math.min(1, a.brightness + b.brightness));
    if (b.saturation != null && a.saturation != null && !patch._replaceGrade) out.grade.saturation = a.saturation * b.saturation;
  }
  return out;
}

const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

/** Checks anything that did not come from our own parser (the LLM) and drops what is invalid. */
export function validateSpec(raw) {
  const spec = emptySpec();
  if (!raw || typeof raw !== 'object') return spec;
  if (typeof raw.name === 'string') spec.name = raw.name.slice(0, 40);
  if (typeof raw.mood === 'string') spec.mood = raw.mood.slice(0, 24);
  if (raw.sky && typeof raw.sky === 'object') {
    const keys = ['zenith', 'horizon', 'sun', 'cloud', 'fog'];
    if (keys.every((k) => isHex(raw.sky[k]))) {
      spec.sky = Object.fromEntries(keys.map((k) => [k, raw.sky[k].toLowerCase()]));
      spec.sky.strength = clamp01(Number.isFinite(+raw.sky.strength) ? +raw.sky.strength : 0.85);
    }
  }
  if (raw.grade && typeof raw.grade === 'object') {
    const g = {};
    if (isHex(raw.grade.tint)) g.tint = raw.grade.tint.toLowerCase();
    if (Number.isFinite(+raw.grade.strength)) g.strength = clamp01(+raw.grade.strength);
    if (Number.isFinite(+raw.grade.brightness)) g.brightness = Math.max(-1, Math.min(1, +raw.grade.brightness));
    if (Number.isFinite(+raw.grade.saturation)) g.saturation = Math.max(0, Math.min(2, +raw.grade.saturation));
    if (Object.keys(g).length) spec.grade = g;
  }
  if (raw.world && typeof raw.world === 'object') {
    for (const k of WORLD_KEYS) if (raw.world[k] === 'remove' || raw.world[k] === 'keep') spec.world[k] = raw.world[k];
  }
  if (Number.isFinite(+raw.fps)) spec.fps = Math.max(0, Math.min(3, Math.round(+raw.fps)));
  spec.constant = raw.constant === true;
  return spec;
}

export const LLM_SYSTEM = `You turn a player's request into a JSON "graphics pack spec" for a GTA V / FiveM timecycle editor. Reply with ONLY a JSON object, no prose, no code fence.

Schema:
{
  "name": string (short pack name),
  "mood": string or null,
  "sky": null | { "zenith": "#rrggbb", "horizon": "#rrggbb", "sun": "#rrggbb", "cloud": "#rrggbb", "fog": "#rrggbb", "strength": 0..1 },
  "grade": null | { "tint": "#rrggbb", "strength": 0..1, "brightness": -1..1, "saturation": 0..2 },
  "world": { "water"?: "remove"|"keep", "mountains"?: "remove"|"keep", "trees"?: "remove"|"keep", "bushes"?: "remove"|"keep", "props"?: "remove"|"keep" },
  "fps": 0..3,
  "constant": boolean
}

Rules:
- "sky" holds the MIDDAY sky colours. If an image is attached and the player wants it as the sky, read its colours: zenith = top of the sky, horizon = colour near the horizon, sun = brightest/warmest highlight, cloud = cloud colour, fog = hazy horizon colour.
- "grade" is an overall colour grade; leave null when not asked for.
- "world" only lists things the player mentioned. "remove" = no water / no trees etc, "keep" = have them.
- "fps": 0 = not asked, 1 = light boost, 2 = boost, 3 = maximum performance.
- "constant": true only when the look should stay the same all day and night.
- Never invent fields. Colours are always 7-character hex strings.`;

/** Pulls the JSON object out of a model reply, tolerating a stray fence or sentence. */
export function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI did not return a pack spec.');
  return JSON.parse(s.slice(start, end + 1));
}

// ---------- spec -> files ----------

const FPS_RULES = [
  { re: /^lod_mult$/, scale: [0.92, 0.8, 0.65], label: 'LOD distance' },
  { re: /^shadow_distance_mult$/, scale: [0.85, 0.65, 0.4], label: 'Shadow distance' },
  { re: /^ssao_inten$/, scale: [0.6, 0.25, 0], label: 'Ambient occlusion' },
  { re: /^light_ray_mult$/, scale: [0.6, 0.2, 0], label: 'Light rays' },
  { re: /^motion_?blur/, scale: [0.5, 0, 0], label: 'Motion blur' },
];

function nightness(sky) {
  const l = lum(hexToRgb(sky.zenith)) * 0.5 + lum(hexToRgb(sky.horizon)) * 0.5;
  return 1 - clamp01(l / 0.35);
}

function skyTarget(role, hour, P, constant, night) {
  const dl = daylight(hour);
  const tw = twilight(hour);
  let c;
  switch (role) {
    case 'zenith': c = P.zenith; break;
    case 'horizon': c = constant ? P.horizon : mix(P.horizon, P.sun, tw * 0.35); break;
    case 'azEast': c = constant ? P.horizon : mix(P.horizon, P.sun, hour < 12 ? tw * 0.55 : 0); break;
    case 'azWest': c = constant ? P.horizon : mix(P.horizon, P.sun, hour >= 12 ? tw * 0.55 : 0); break;
    case 'sun': case 'sunDisc': c = P.sun; break;
    case 'cloud': c = P.cloud; break;
    case 'fog': c = P.fog; break;
    default: return null;
  }
  const dim = constant ? 1 - (1 - dl) * 0.35 * (1 - night) : 0.1 + 0.9 * dl;
  const floor = [0.012, 0.018, 0.045].map((x) => x * (1 - dl) * (role === 'sun' || role === 'sunDisc' ? 0 : 1));
  return c.map((x, i) => x * dim + floor[i]);
}

/** Applies a spec to timecycle files. files: { 'common/data/timecycle/w_x.xml': xml }.
 *  Returns the changed files, which world tweaks to switch, and a readable report. */
export function buildPack(spec, files) {
  const report = [];
  const out = {};
  let skyCols = 0;
  let gradeCols = 0;
  const fpsHits = {};
  const sky = spec.sky && spec.sky.strength > 0 ? spec.sky : null;
  const P = sky ? Object.fromEntries(['zenith', 'horizon', 'sun', 'cloud', 'fog'].map((k) => [k, hexToRgb(sky[k])])) : null;
  const night = sky ? nightness(sky) : 0;
  const g = spec.grade;
  const gradeOpts = g && (g.strength || g.brightness || (g.saturation != null && g.saturation !== 1))
    ? (() => {
      const t = hexToRgb(g.tint || '#ffffff').map((x) => Math.round(x * 255));
      return { r: t[0], g: t[1], b: t[2], strength: g.tint ? (g.strength ?? 0.2) : 0, brightness: g.brightness || 0, saturation: g.saturation ?? 1, groups: GRADE_GROUPS };
    })() : null;

  for (const [rel, xml] of Object.entries(files)) {
    const model = parse(xml);
    for (const sec of model.sections) {
      if (P) {
        for (const col of sec.colours) {
          if (!col.role || !['zenith', 'horizon', 'azEast', 'azWest', 'sun', 'sunDisc', 'cloud', 'fog'].includes(col.role)) continue;
          const hrs = keyHours(col.r.values.length);
          for (let i = 0; i < hrs.length; i++) {
            const tgt = skyTarget(col.role, hrs[i], P, spec.constant, night);
            if (!tgt) continue;
            const cur = [col.r.values[i], col.g.values[i], col.b.values[i]];
            setColour(col, i, mix(cur, tgt, sky.strength));
          }
          skyCols++;
        }
      }
    }
    if (gradeOpts) gradeCols += gradeColours(model, gradeOpts);
    if (spec.fps > 0) {
      const lvl = spec.fps - 1;
      for (const sec of model.sections) {
        for (const p of sec.scalars) {
          const rule = FPS_RULES.find((r) => r.re.test(p.name));
          if (!rule) continue;
          p.values = p.values.map((v) => v * rule.scale[lvl]);
          fpsHits[rule.label] = (fpsHits[rule.label] || 0) + 1;
        }
      }
    }
    const next = serialize(model);
    if (next !== xml) out[rel] = next;
  }

  const fileCount = Object.keys(files).length;
  if (sky) report.push({ ok: skyCols > 0, text: skyCols > 0 ? `Sky recoloured: ${skyCols} colour tracks across ${fileCount} file(s)` + (spec.constant ? ' (same look all day)' : ' (follows day and night)') : 'No sky colours found in your timecycle files, so the sky was not changed.' });
  if (gradeOpts) report.push({ ok: gradeCols > 0, text: gradeCols > 0 ? `Colour grade applied to ${gradeCols} colour tracks` : 'No colours matched the grade.' });
  if (spec.fps > 0) {
    const hit = Object.entries(fpsHits);
    report.push({
      ok: hit.length > 0,
      text: hit.length
        ? `FPS boost level ${spec.fps}: lowered ${hit.map(([k]) => k.toLowerCase()).join(', ')}`
        : 'FPS boost: none of the usual performance values (LOD, shadow distance, ambient occlusion, light rays, motion blur) were found in these files, so nothing was lowered.',
    });
  }

  const tweaks = {};
  for (const k of WORLD_KEYS) {
    if (spec.world && spec.world[k]) tweaks[k] = spec.world[k] === 'remove';
  }
  return { files: out, tweaks, report, changed: Object.keys(out).length };
}

// ---------- wording ----------

export function describeSpec(spec) {
  const chips = [];
  if (spec.mood && MOODS[spec.mood]) chips.push(MOODS[spec.mood].label + ' mood');
  else if (spec.mood) chips.push(spec.mood + ' mood');
  if (spec.sky) chips.push('Custom sky');
  if (spec.grade) chips.push('Colour grade');
  if (spec.constant) chips.push('Same all day');
  for (const k of WORLD_KEYS) if (spec.world && spec.world[k]) chips.push((spec.world[k] === 'remove' ? 'No ' : 'Keep ') + WORLD_LABEL[k].toLowerCase());
  if (spec.fps) chips.push('FPS boost ' + spec.fps);
  return chips;
}

export function isEmptySpec(spec) {
  return !spec.sky && !spec.grade && !spec.fps && !Object.keys(spec.world || {}).length;
}

export function packName(spec) {
  if (spec.name) return spec.name;
  const bits = [];
  if (spec.mood && MOODS[spec.mood]) bits.push(MOODS[spec.mood].label);
  else if (spec.sky) bits.push('Custom sky');
  if (spec.fps) bits.push('FPS');
  if (!bits.length) bits.push('Custom');
  return 'AI ' + bits.join(' + ');
}
