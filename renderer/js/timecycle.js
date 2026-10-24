// Timecycle XML model: parse, edit, serialize. Pure (no DOM, no Node APIs) so
// the renderer and the tests share it.
//
// The parser does not assume a fixed schema. Every leaf tag whose text is a list
// of numbers (`<sky_zenith_col_r>0.1 0.2 ...</sky_zenith_col_r>`) becomes a
// parameter, and `_r/_g/_b` triples become one colour. Edits are written back
// into the original text by offset, so anything that was not touched stays
// byte-identical.

const NUM_LIST = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?:\s+[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)*\s*$/;
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const SECTION_TAGS = new Set(['cycle', 'region', 'modifier', 'weather', 'timecycle_modifier']);

export const GROUPS = [
  { id: 'sky', label: 'Sky' },
  { id: 'sun', label: 'Sun & moon' },
  { id: 'cloud', label: 'Clouds' },
  { id: 'light', label: 'Light' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'fog', label: 'Fog' },
  { id: 'post', label: 'Post FX' },
  { id: 'perf', label: 'LOD & shadows' },
  { id: 'water', label: 'Water' },
  { id: 'other', label: 'Other' },
];

// Order matters: the first match wins (light_natural_amb_* is ambient, not light).
const GROUP_RULES = [
  ['perf', /^(lod|shadow|ssao|light_ray|particle|reflection|water_reflection|sprite)/],
  ['post', /^(postfx_|nv_|bloom|dof|lens|motion_?blur|tonemap|exposure|hdr|vignette|colou?r_correct|filmic|noise)/],
  ['ambient', /^(ambient_|amb_|ped_light|light_natural_amb|light_artificial|light_amb)/],
  ['light', /^(light_|lightning|dir_|lod_light)/],
  ['fog', /^(fog_|haze_|height_?fog)/],
  ['cloud', /^(sky_cloud|cloud_)/],
  ['sun', /^(sky_sun|sun_|moon_|sky_moon|star)/],
  ['sky', /^(sky_|azimuth)/],
  ['water', /^water/],
];

export function groupOf(name) {
  const n = name.toLowerCase();
  for (const [id, re] of GROUP_RULES) if (re.test(n)) return id;
  return 'other';
}

/** What a colour is for, so the preview and the generator can find it by meaning. */
export function roleOf(name) {
  const n = name.toLowerCase();
  if (/zenith/.test(n)) return 'zenith';
  if (/azimuth_east/.test(n)) return 'azEast';
  if (/azimuth_west/.test(n)) return 'azWest';
  if (/horizon|azimuth/.test(n)) return 'horizon';
  if (/sun_disc/.test(n)) return 'sunDisc';
  if (/^(sky_)?sun(_disc)?_col/.test(n) || /^sun_col/.test(n)) return 'sun';
  if (/moon.*col|^sky_moon/.test(n)) return 'moon';
  if (/cloud.*col|^cloud_/.test(n)) return 'cloud';
  if (/^fog.*col|^haze.*col/.test(n)) return 'fog';
  if (/^light_dir_col|^dir_col/.test(n)) return 'dirLight';
  if (groupOf(n) === 'ambient') return 'ambient';
  return null;
}

/** Hour of day for each keyframe. GTA V keeps 9 samples per day; the exact
 *  clock times are approximate, they only drive the preview. The saved values
 *  and their order are never changed. */
const HOURS_9 = [0, 5, 6, 7, 12, 17, 18, 19, 21];
export function keyHours(n) {
  if (n <= 1) return [12];
  if (n === 9) return HOURS_9.slice();
  if (n === 24) return Array.from({ length: 24 }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => (i * 24) / n);
}

export function hourLabel(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}

/** Wrap-around linear sample of a keyframe list at an hour. */
export function sample(values, hour) {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0];
  const hrs = keyHours(n);
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < n; i++) {
    const a = hrs[i];
    const b = i + 1 < n ? hrs[i + 1] : hrs[0] + 24;
    const hh = i + 1 < n || h >= a ? h : h + 24;
    if (hh >= a && hh <= b) {
      const t = b === a ? 0 : (hh - a) / (b - a);
      return values[i] + (values[(i + 1) % n] - values[i]) * t;
    }
  }
  return values[0];
}

export function nearestKey(n, hour) {
  const hrs = keyHours(n);
  let best = 0;
  let bd = 99;
  for (let i = 0; i < n; i++) {
    let d = Math.abs(hrs[i] - hour);
    d = Math.min(d, 24 - d);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export const fmt = (n) => {
  const s = Number(Number(n).toFixed(6));
  return Object.is(s, -0) ? '0' : String(s);
};

// ---------- parse / serialize ----------

export function parse(xml) {
  const sections = [];
  const byId = new Map();
  const stack = [];
  const params = [];
  let m;
  TOKEN.lastIndex = 0;

  const sectionFor = () => {
    const chain = stack.filter((s) => SECTION_TAGS.has(s.name.toLowerCase()) && s.label);
    const label = chain.length ? chain.map((s) => s.label).join(' / ') : 'Global';
    let id = chain.length ? chain.map((s) => s.name + ':' + s.label).join('>') : 'root';
    if (!byId.has(id)) {
      const sec = { id, label, params: [], colours: [], scalars: [] };
      byId.set(id, sec);
      sections.push(sec);
    }
    return byId.get(id);
  };

  const addParam = (name, values, loc) => {
    const p = { name, values, orig: values.slice(), group: groupOf(name), ...loc };
    sectionFor().params.push(p);
    params.push(p);
  };

  while ((m = TOKEN.exec(xml))) {
    if (!m[2]) continue; // comment / PI / CDATA
    const closing = m[1] === '/';
    const name = m[2];
    const selfClose = m[4] === '/';
    const attrs = m[3] || '';
    if (closing) {
      const node = stack.pop();
      if (node && node.name === name && node.children === 0) {
        const text = xml.slice(node.textStart, m.index);
        if (NUM_LIST.test(text)) {
          const lead = text.length - text.trimStart().length;
          const trail = text.length - text.trimEnd().length;
          addParam(name, text.trim().split(/\s+/).map(Number), { form: 'text', start: node.textStart + lead, end: m.index - trail });
        }
      }
      continue;
    }
    if (stack.length) stack[stack.length - 1].children++;
    const label = (/\bname\s*=\s*"([^"]*)"/.exec(attrs) || /\bname\s*=\s*'([^']*)'/.exec(attrs) || [])[1] || null;
    if (selfClose) {
      const v = /\bvalue\s*=\s*("([^"]*)"|'([^']*)')/.exec(attrs);
      const raw = v && (v[2] ?? v[3]);
      if (raw != null && NUM_LIST.test(raw) && !SECTION_TAGS.has(name.toLowerCase())) {
        const attrStart = m.index + m[0].indexOf(attrs) + v.index + v[0].indexOf(v[1]) + 1;
        addParam(name, raw.trim().split(/\s+/).map(Number), { form: 'attr', start: attrStart, end: attrStart + raw.length });
      }
      continue;
    }
    stack.push({ name, label, children: 0, textStart: m.index + m[0].length });
  }

  for (const sec of sections) groupColours(sec);
  return { xml, sections, params };
}

function groupColours(sec) {
  const used = new Set();
  const byName = new Map(sec.params.map((p) => [p.name, p]));
  for (const p of sec.params) {
    const mm = /^(.*)_r$/.exec(p.name);
    if (!mm) continue;
    const g = byName.get(mm[1] + '_g');
    const b = byName.get(mm[1] + '_b');
    if (!g || !b || g.values.length !== p.values.length || b.values.length !== p.values.length) continue;
    used.add(p); used.add(g); used.add(b);
    sec.colours.push({ name: mm[1], group: p.group, role: roleOf(mm[1]), r: p, g, b });
  }
  sec.scalars = sec.params.filter((p) => !used.has(p));
}

export function isDirty(model) {
  return model.params.some((p) => p.values.some((v, i) => v !== p.orig[i]));
}

export function dirtyCount(model) {
  return model.params.filter((p) => p.values.some((v, i) => v !== p.orig[i])).length;
}

export function serialize(model) {
  const changed = model.params.filter((p) => p.values.some((v, i) => v !== p.orig[i])).sort((a, b) => b.start - a.start);
  let out = model.xml;
  for (const p of changed) {
    const text = p.form === 'attr' ? fmt(p.values[0]) : p.values.map(fmt).join(' ');
    out = out.slice(0, p.start) + text + out.slice(p.end);
  }
  return out;
}

export function revert(model) {
  for (const p of model.params) p.values = p.orig.slice();
}

// ---------- colour helpers ----------

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
export const rgbToHex = (c) => '#' + c.map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('');
export const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
export const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

export function colourAt(col, key) { return [col.r.values[key], col.g.values[key], col.b.values[key]]; }

export function colourSample(col, hour) {
  return [sample(col.r.values, hour), sample(col.g.values, hour), sample(col.b.values, hour)];
}

export function setColour(col, key, rgb) {
  col.r.values[key] = rgb[0]; col.g.values[key] = rgb[1]; col.b.values[key] = rgb[2];
}

export function setColourAll(col, rgb) {
  for (let i = 0; i < col.r.values.length; i++) setColour(col, i, rgb);
}

/** Multiply every colour in the chosen groups towards a tint, then adjust
 *  brightness and saturation. Returns how many colours changed. */
export function gradeColours(model, opts, sectionId = null) {
  const { r = 255, g = 255, b = 255, strength = 0, brightness = 0, saturation = 1, groups = ['sky', 'sun', 'cloud', 'light', 'ambient', 'fog', 'post'] } = opts;
  const avg = (r + g + b) / 3 || 1;
  const s = clamp01(strength);
  const bright = 1 + Math.max(-1, Math.min(1, brightness)) * 0.5;
  const f = [r, g, b].map((c) => (1 + s * (c / avg - 1)) * bright);
  let n = 0;
  for (const sec of model.sections) {
    if (sectionId && sec.id !== sectionId) continue;
    for (const col of sec.colours) {
      if (!groups.includes(col.group)) continue;
      n++;
      for (let i = 0; i < col.r.values.length; i++) {
        let c = [col.r.values[i] * f[0], col.g.values[i] * f[1], col.b.values[i] * f[2]];
        if (saturation !== 1) { const l = lum(c); c = c.map((x) => l + (x - l) * saturation); }
        setColour(col, i, c.map((x) => Math.max(0, x)));
      }
    }
  }
  return n;
}

/** Colour by role for a section, with sane fallbacks so the preview always has something. */
export function sceneColours(sec, hour) {
  const out = {};
  for (const col of sec.colours) {
    if (col.role && !out[col.role]) out[col.role] = colourSample(col, hour);
  }
  const anySky = sec.colours.find((c) => c.group === 'sky' || c.group === 'sun');
  const fallback = anySky ? colourSample(anySky, hour) : [0.45, 0.6, 0.85];
  out.zenith = out.zenith || fallback;
  out.horizon = out.horizon || out.azEast || out.azWest || mix(out.zenith, [1, 1, 1], 0.35);
  out.sun = out.sun || out.sunDisc || [1, 0.95, 0.8];
  out.fog = out.fog || mix(out.horizon, [0.7, 0.7, 0.7], 0.4);
  out.cloud = out.cloud || mix(out.horizon, [1, 1, 1], 0.5);
  out.ambient = out.ambient || mix(out.horizon, [0.2, 0.2, 0.25], 0.55);
  return out;
}

/** 0 at night, 1 in full daylight, used by the preview and the generator. */
export function daylight(hour) {
  const elev = Math.sin(((hour - 6) / 12) * Math.PI);
  const t = clamp01((elev + 0.12) / 0.5);
  return t * t * (3 - 2 * t);
}

/** Strength of the warm glow around sunrise/sunset. */
export function twilight(hour) {
  const elev = Math.sin(((hour - 6) / 12) * Math.PI);
  return Math.exp(-Math.pow((elev - 0.02) / 0.22, 2)) * (hour > 3 && hour < 22 ? 1 : 0);
}

// ---------- friendly names ----------

const NAMES = {
  sky_zenith_col: 'Sky colour (top)',
  sky_zenith_transition_col: 'Sky colour (middle)',
  sky_azimuth_east_col: 'Horizon colour (sunrise side)',
  sky_azimuth_west_col: 'Horizon colour (sunset side)',
  sky_azimuth_transition_col: 'Horizon colour (between)',
  sky_horizon_col: 'Horizon colour',
  sky_plane: 'Sky below the horizon',
  sky_sun_col: 'Sun glow colour',
  sky_sun_disc_col: 'Sun colour',
  sky_moon_col: 'Moon colour',
  sky_cloud_base_col: 'Cloud colour',
  fog_col: 'Fog colour',
  light_dir_col: 'Sunlight colour',
  light_natural_amb_down_col: 'Ambient light (from the ground)',
  light_natural_amb_up_col: 'Ambient light (from the sky)',
  light_directional_amb_col: 'Bounce light colour',
  light_artificial_int_down_col: 'Indoor lights (down)',
  light_artificial_int_up_col: 'Indoor lights (up)',
  light_artificial_ext_down_col: 'Street lights (down)',
  light_artificial_ext_up_col: 'Street lights (up)',
  sky_stars_iten: 'Stars brightness',
  sky_moon_iten: 'Moon brightness',
  sky_moon_disc_size: 'Moon size',
  sky_sun_disc_size: 'Sun size',
  sky_sun_hdr: 'Sun glow strength',
  sky_hdr: 'Sky brightness',
  light_dir_mult: 'Sunlight strength',
  lod_mult: 'Detail distance',
  shadow_distance_mult: 'Shadow distance',
  ssao_inten: 'Ambient occlusion',
  light_ray_mult: 'Light rays',
  postfx_exposure: 'Exposure',
  fog_start: 'Fog start distance',
  fog_density: 'Fog thickness',
  fog_base_height: 'Fog height',
  postfx_intensity_bloom: 'Glow (bloom)',
  postfx_bright_pass_thresh: 'Glow threshold',
  cloud_base_strength: 'Clouds strength',
  cloud_shadow_strength: 'Cloud shadows',
  dof_blur_far: 'Distance blur',
  dof_far: 'Distance blur starts at',
};

/** Human name for a timecycle tag ("sky_zenith_col_inten" -> "Sky colour (top) brightness"). */
export function labelOf(name) {
  const n = name.toLowerCase();
  if (NAMES[n]) return NAMES[n];
  const m = /^(.*?)_(inten|iten|intensity)$/.exec(n);
  if (m && NAMES[m[1]]) return NAMES[m[1]].replace(/ colour/, '') + ' brightness';
  const s = n.replace(/_col$/, '').replace(/_/g, ' ')
    .replace(/\b(iten|inten)\b/g, 'intensity').replace(/\bmult\b/g, 'strength').replace(/\bamb\b/g, 'ambient')
    .replace(/\bcol\b/g, 'colour').replace(/\bpostfx\b/g, 'post effect').replace(/\blod\b/g, 'detail');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "EXTRASUNNY / URBAN" -> { weather: 'EXTRASUNNY', area: 'URBAN' } */
export function splitSection(label) {
  const i = label.lastIndexOf(' / ');
  return i < 0 ? { weather: label, area: null } : { weather: label.slice(0, i), area: label.slice(i + 3) };
}

export const AREA_NAMES = { GLOBAL: 'Countryside', URBAN: 'City' };
export const WEATHER_NAMES = {
  EXTRASUNNY: 'Extra sunny', CLEAR: 'Clear', CLOUDS: 'Cloudy', SMOG: 'Smog', FOGGY: 'Foggy', OVERCAST: 'Overcast',
  RAIN: 'Rain', THUNDER: 'Thunder', CLEARING: 'Clearing', NEUTRAL: 'Neutral', SNOW: 'Snow', BLIZZARD: 'Blizzard',
  SNOWLIGHT: 'Light snow', XMAS: 'Christmas', HALLOWEEN: 'Halloween',
};
