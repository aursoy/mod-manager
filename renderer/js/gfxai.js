// Graphics-pack AI. Pure logic, no DOM or Node, shared by the UI and the tests.
//
//   prompt (+ image)  ->  spec  ->  buildPack(spec, timecycle files)  ->  edited files + tweak switches
//
// The spec comes from the built-in prompt reader; it works offline.

import { parse, serialize, keyHours, daylight, twilight, mix, lum, clamp01, hexToRgb, rgbToHex, gradeColours, setColour } from './timecycle.js';

const WORLD_KEYS = ['water', 'mountains', 'snow'];
export const WORLD_LABEL = { water: 'Water', mountains: 'Black mountains', snow: 'Snow' };
const GRADE_GROUPS = ['sky', 'sun', 'cloud', 'light', 'ambient', 'fog'];

export const emptySpec = () => ({ name: '', mood: null, sky: null, skyImage: null, grade: null, world: {}, adjust: {}, fps: 0, constant: false, timeLock: null });

// "add stars", "bigger moon", "no fog"... Each target is found by tag name in the
// timecycle; `amount` values (intensity, density...) or `size` values are scaled.
export const ADJUST = {
  stars: { label: 'Stars', words: /\b(stars?|starfield|starry)\b/, tags: /star(?!t)/ },
  moon: { label: 'Moon', words: /\bmoon\b/, tags: /moon/ },
  sun: { label: 'Sun', words: /\bsun\b/, tags: /sun/ },
  clouds: { label: 'Clouds', words: /\bclouds?\b/, tags: /cloud/ },
  fog: { label: 'Fog', words: /\b(fog|haze|mist)\b/, tags: /fog|haze/ },
  bloom: { label: 'Glow', words: /\b(bloom|glow)\b/, tags: /bloom/ },
  // distance blur (depth of field) hides players far away; any dof_blur value is an amount
  blur: { label: 'Distance blur', words: /\b(blur|blurry|dof|depth of field)\b/, tags: /dof_blur|blur/, any: true },
};
const ADJUST_OPS = ['more', 'less', 'none', 'bigger', 'smaller'];
const AMOUNT_TAG = /(iten|inten|dens|alpha|opacity|amount|bright|mult|strength|visib)/;
const SIZE_TAG = /(size|scale|radius)/;
const VERB = [
  ['bigger', /\b(bigger|larger|huge|giant|massive)\b/],
  ['smaller', /\b(smaller|tiny|little)\b/],
  ['less', /\b(less|fewer|dimmer|weaker|lower|reduce|softer|subtler)\b/],
  ['more', /\b(more|add|brighter|stronger|extra|lots of|increase|have|with|show|visible|bright)\b/],
];

// ---------- moods ----------
// Each mood is a "midday" sky palette plus an optional grade. `constant` keeps the
// look at every hour instead of fading to a normal night.
export const MOODS = {
  // PvP packs: see players clearly and keep FPS steady. No fog, no glare, punchy colours.
  pvp: { label: 'PvP', words: /\b(pvp|competitive|clear view|visibility|tryhard|sweaty|crisp)\b/, grade: { saturation: 1.25, brightness: 0.08 }, pvp: true },
  sunny: { label: 'Sunny', words: /\b(sunny|clear|bright day|blue sky|summer)\b/, sky: ['#2f7de1', '#bfe0ff', '#fff3c8', '#ffffff', '#cfe4f5'], grade: { saturation: 1.1, brightness: 0.05 } },
  sunset: { label: 'Sunset', words: /\b(sunset|golden hour|dusk|evening)\b/, constant: true, sky: ['#3a4a8c', '#ff8a3d', '#ffd08a', '#ff9d6b', '#ffb27a'], grade: { tint: '#ffa060', strength: 0.25, saturation: 1.1 } },
  sunrise: { label: 'Sunrise', words: /\b(sunrise|dawn|morning)\b/, constant: true, sky: ['#5b6fb5', '#ffb199', '#ffe3b0', '#ffc9b0', '#f2c1b5'], grade: { tint: '#ffc0a0', strength: 0.18 } },
  night: { label: 'Night', words: /\b(night|moonlit|moonlight|midnight)\b/, constant: true, sky: ['#05071a', '#1b2347', '#8a9bd8', '#2a3158', '#141a33'], grade: { tint: '#6080ff', strength: 0.2, brightness: -0.1 } },
  overcast: { label: 'Overcast', words: /\b(overcast|cloudy|grey|gray|dull)\b/, sky: ['#8a929c', '#b4bac2', '#d8dce0', '#c4c9cf', '#aeb4bb'], grade: { saturation: 0.7 } },
  foggy: { label: 'Foggy', words: /\b(fog|foggy|misty|mist|haze|hazy)\b/, sky: ['#a9b4bd', '#d3dadf', '#e6eaed', '#cfd6db', '#cfd6db'], grade: { saturation: 0.6 } },
  stormy: { label: 'Stormy', words: /\b(storm|stormy|rain|rainy|thunder)\b/, sky: ['#3b434d', '#6b747e', '#9aa3ad', '#4a525c', '#636c76'], grade: { saturation: 0.7, brightness: -0.15 } },
  neon: { label: 'Neon', words: /\b(neon|cyberpunk|synthwave|retrowave|outrun)\b/, constant: true, sky: ['#1a0b3d', '#ff2e97', '#00e5ff', '#8a3dff', '#3a1a6e'], grade: { tint: '#b050ff', strength: 0.3, saturation: 1.4 } },
  vaporwave: { label: 'Vaporwave', words: /\b(vaporwave|pastel|candy)\b/, constant: true, sky: ['#7b6bff', '#ff9ed8', '#fff1a8', '#ffc4ec', '#d9a8ff'], grade: { saturation: 1.15 } },
  winter: { label: 'Winter', words: /\b(winter|icy|frozen|arctic)\b/, sky: ['#6fa0d6', '#e0f0ff', '#ffffff', '#f2f8ff', '#e6f1fa'], grade: { tint: '#a0c8ff', strength: 0.2 } },
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
  'PvP pack with my picture as the sky',
  'Always night, purple sky, no fog, max FPS',
  'Black sky, no sun, no clouds, FPS boost',
  'Pink neon sky, more stars, bigger moon',
  'Snowy winter pack, no black mountains',
  'Max FPS pack: no water, no black mountains',
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
  snow: /\b(snow|snowy|snowfall)\b/,
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

  // world switches and adjustments, clause by clause so "no trees, have bushes" works
  const clauses = t.split(/[,;.\n]|\b(?:and|or|but|also|then|plus)\b/).map((c) => c.trim()).filter(Boolean);
  let last = null;
  let lastOp = null;
  const positive = [];
  patch.adjust = {};
  for (const c of clauses) {
    const neg = NEG.test(c);
    if (!neg) positive.push(c);
    let op = neg ? 'none' : (VERB.find(([, re]) => re.test(c)) || [])[0] || null;
    if (!op && c.split(/\s+/).length <= 2 && lastOp) op = lastOp;
    for (const [k, a] of Object.entries(ADJUST)) if (op && a.words.test(c)) patch.adjust[k] = op;
    lastOp = op;
  }
  if (!Object.keys(patch.adjust).length) delete patch.adjust;
  const tPos = positive.join(', ');
  for (const c of clauses) {
    const words = c.split(/\s+/).length;
    let pol = NEG.test(c) ? 'remove' : POS.test(c) ? 'keep' : null;
    if (!pol && words <= 3 && last) pol = last;
    const hits = Object.entries(FEATURES).filter(([, re]) => re.test(c)).map(([k]) => k);
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
  // the mood named first wins ("foggy morning" is foggy, not sunrise)
  const moodHit = Object.entries(MOODS)
    .map(([id, m]) => [id, m, tPos.search(m.words)])
    .filter((x) => x[2] >= 0)
    .sort((x, y) => x[2] - y[2])
    .map(([id, m]) => [id, m])[0];
  if (moodHit) {
    const [id, m] = moodHit;
    patch.mood = id;
    if (m.sky) patch.sky = { ...skyOf(m.sky), strength: 0.85 };
    if (m.constant) patch.constant = true;
    if (id === 'winter' && !patch.world.snow) patch.world.snow = 'keep';
    if (m.pvp) {
      if (patch.fps == null) patch.fps = 2;
      patch.adjust = { fog: 'none', bloom: 'none', blur: 'none', ...(patch.adjust || {}) };
    }
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

  // lock the clock: every hour looks like night (or day), the way "only night" PvP packs do it
  if (/\b(always|only|permanent(ly)?|forever|constant(ly)?|all the time|24\/?7)\s+(at\s+)?night\b|\bno\s+day(time|light)?\b|\bnight\s+only\b|\bonly\s+night\b/.test(t)) patch.timeLock = 'night';
  else if (/\b(always|only|permanent(ly)?|forever|constant(ly)?|all the time|24\/?7)\s+(in\s+the\s+)?day(time|light)?\b|\bno\s+night\b|\bday\s+only\b/.test(t)) patch.timeLock = 'day';

  // what an attached image is for: the sky texture itself, or only its colours
  if (/\b(colou?rs? only|only the colou?rs|just the colou?rs|palette only|just a palette)\b/.test(t)) patch.imageUse = 'colours';
  else if (/\b(actual|real|whole|literal(ly)?|full)\s+sky\b|\bsky\s*(box|texture|dome|image|picture)\b|\b(image|picture|photo|pic)\s+(as|for|in)\s+(the\s+|my\s+|a\s+)?sky\b|\bas\s+(the|my|a)\s+sky\b/.test(t)) patch.imageUse = 'texture';
  // the picture shows all the time unless they only want it at night
  patch.imageAllDay = !/\b(only\s+at\s+night|at\s+night\s+only|just\s+at\s+night)\b/.test(t);
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
  if (patch.skyImage !== undefined) out.skyImage = patch.skyImage;
  if (patch.timeLock !== undefined) out.timeLock = patch.timeLock;
  out.world = { ...(out.world || {}), ...(patch.world || {}) };
  out.adjust = { ...(out.adjust || {}), ...(patch.adjust || {}) };
  if (patch.grade) {
    const a = out.grade || {};
    const b = patch.grade;
    out.grade = { ...a, ...b };
    if (b.brightness != null && a.brightness != null && !patch._replaceGrade) out.grade.brightness = Math.max(-1, Math.min(1, a.brightness + b.brightness));
    if (b.saturation != null && a.saturation != null && !patch._replaceGrade) out.grade.saturation = a.saturation * b.saturation;
  }
  return out;
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

  const adjHits = {};
  const adjust = Object.entries(spec.adjust || {}).filter(([k, op]) => ADJUST[k] && ADJUST_OPS.includes(op));
  let starTags = 0;
  let locked = 0;
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
    for (const [k, op] of adjust) {
      const sizeOp = op === 'bigger' || op === 'smaller';
      for (const sec of model.sections) {
        for (const p of sec.scalars) {
          const n = p.name.toLowerCase();
          if (!ADJUST[k].tags.test(n)) continue;
          const fits = sizeOp ? SIZE_TAG.test(n) : op === 'none' ? AMOUNT_TAG.test(n) || SIZE_TAG.test(n) || /hdr/.test(n) : AMOUNT_TAG.test(n);
          if (!fits && k !== 'stars' && !ADJUST[k].any) continue;
          const f = { more: 1.6, less: 0.5, none: 0, bigger: 1.6, smaller: 0.6 }[op];
          const allZero = p.values.every((v) => v === 0);
          p.values = p.values.map((v) => (op === 'more' && allZero ? 1 : v * f));
          (adjHits[k] = adjHits[k] || new Set()).add(p.name);
        }
      }
    }
    // The picture on the sky texture is blended in by the star intensity. Make sure it shows
    // at night, and with allDay keep it on and darken the day sky so it is not washed out.
    if (spec.skyImage) {
      for (const sec of model.sections) {
        for (const p of sec.scalars) {
          if (!/star(?!t)/i.test(p.name) || (spec.adjust && spec.adjust.stars === 'none')) continue;
          const hrs = keyHours(p.values.length);
          const top = Math.max(1, ...p.values);
          p.values = p.values.map((v, i) => (spec.skyImage.allDay || daylight(hrs[i]) < 0.3 ? Math.max(v, top) : v));
          starTags++;
        }
        if (spec.skyImage.allDay) {
          for (const col of sec.colours) {
            if (col.role !== 'zenith' && col.role !== 'horizon' && col.role !== 'azEast' && col.role !== 'azWest') continue;
            for (let i = 0; i < col.r.values.length; i++) setColour(col, i, [col.r.values[i], col.g.values[i], col.b.values[i]].map((x) => x * 0.25));
          }
        }
      }
    }
    if (spec.timeLock) {
      for (const p of model.params) {
        if (p.values.length < 2) continue;
        const hrs = keyHours(p.values.length);
        // the darkest (night) or brightest (day) keyframe, by the clock
        let k = 0;
        hrs.forEach((h, i) => { if (spec.timeLock === 'night' ? daylight(h) < daylight(hrs[k]) || (daylight(h) === daylight(hrs[k]) && Math.abs(h - 0) < Math.abs(hrs[k] - 0)) : daylight(h) > daylight(hrs[k])) k = i; });
        const v = p.values[k];
        p.values = p.values.map(() => v);
      }
      locked++;
    }
    const next = serialize(model);
    if (next !== xml) out[rel] = next;
  }

  const fileCount = Object.keys(files).length;
  if (sky && !spec.skyImage) report.push({ ok: skyCols > 0, text: skyCols > 0 ? `Sky colours changed in ${fileCount} weather file(s)` : 'No sky colours found in your timecycle files, so the sky was not changed.' });
  if (spec.timeLock) report.push({ ok: locked > 0, text: locked ? `Always ${spec.timeLock}: every hour of every weather now looks like ${spec.timeLock === 'night' ? 'midnight' : 'midday'}` : 'No timecycle files to lock to ' + spec.timeLock + '.' });
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

  for (const [k, op] of adjust) {
    const hit = adjHits[k];
    const verb = { more: 'more', less: 'less', none: 'off', bigger: 'bigger', smaller: 'smaller' }[op];
    report.push(hit
      ? { ok: true, text: `${ADJUST[k].label}: ${verb} (${[...hit].slice(0, 3).join(', ')}${hit.size > 3 ? ' +' + (hit.size - 3) : ''})` }
      : { ok: false, text: `${ADJUST[k].label}: these timecycle files have no ${ADJUST[k].label.toLowerCase()} ${op === 'bigger' || op === 'smaller' ? 'size' : 'strength'} values, so nothing changed.` });
  }
  if (spec.skyImage) {
    report.push(starTags
      ? { ok: true, text: spec.skyImage.allDay ? 'Day sky darkened and stars turned up, so your picture shows all the time' : 'Your picture shows at night' }
      : { ok: false, text: 'No star values in these timecycles, so the game decides when the sky picture shows.' });
  }

  const tweaks = {};
  // water / mountains: true = removed. snow: true = snow on.
  for (const k of WORLD_KEYS) {
    if (spec.world && spec.world[k]) tweaks[k] = k === 'snow' ? spec.world[k] === 'keep' : spec.world[k] === 'remove';
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
  for (const k of WORLD_KEYS) if (spec.world && spec.world[k]) chips.push((spec.world[k] === 'remove' ? 'No ' : k === 'snow' ? 'Add ' : 'Keep ') + WORLD_LABEL[k].toLowerCase());
  for (const [k, op] of Object.entries(spec.adjust || {})) if (ADJUST[k]) chips.push(ADJUST[k].label + ': ' + (op === 'none' ? 'off' : op));
  if (spec.skyImage) chips.push(spec.skyImage.allDay ? 'Picture sky (all the time)' : 'Picture sky (night)');
  if (spec.timeLock) chips.push('Always ' + spec.timeLock);
  if (spec.fps) chips.push('FPS boost ' + spec.fps);
  return chips;
}

export function isEmptySpec(spec) {
  return !spec.sky && !spec.skyImage && !spec.grade && !spec.fps && !spec.timeLock && !Object.keys(spec.world || {}).length && !Object.keys(spec.adjust || {}).length;
}

export function packName(spec) {
  if (spec.name) return spec.name;
  const bits = [];
  if (spec.mood && MOODS[spec.mood]) bits.push(MOODS[spec.mood].label);
  else if (spec.skyImage) bits.push('Picture sky');
  else if (spec.sky) bits.push('Custom sky');
  if (spec.fps) bits.push('FPS');
  if (!bits.length) bits.push('Custom');
  return 'AI ' + bits.join(' + ');
}
