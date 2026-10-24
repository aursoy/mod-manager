'use strict';
// Builds a timecycle XML shaped like a FiveM weather file: 9 keyframes per value,
// one <cycle> per weather. Colours are plain _r/_g/_b triples.

const DAY = [
  // [midnight, 5, 6, 7, 12, 17, 18, 19, 21] brightness of a typical day
  0.04, 0.12, 0.35, 0.7, 1, 0.9, 0.5, 0.2, 0.06,
];

function track(base, k) {
  return DAY.map((d, i) => +(Math.min(1, base * (0.15 + 0.85 * d) * k + (i === 0 || i === 8 ? 0.01 : 0))).toFixed(4)).join(' ');
}

function colour(name, rgb, k = 1) {
  return ['r', 'g', 'b'].map((ch, i) => `      <${name}_${ch}>${track(rgb[i], k)}</${name}_${ch}>`).join('\n');
}

// Same layout as the game files (as read by CodeWalker): one <cycle> per weather
// with a GLOBAL (countryside) and an URBAN (city) region, real tag names.
function region(rname, k) {
  return `    <region name="${rname}">
${colour('sky_zenith_col', [0.25, 0.45, 0.85], k)}
      <sky_zenith_col_inten>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</sky_zenith_col_inten>
${colour('sky_zenith_transition_col', [0.4, 0.6, 0.9], k)}
${colour('sky_azimuth_east_col', [0.9, 0.75, 0.6], k)}
${colour('sky_azimuth_west_col', [0.95, 0.7, 0.5], k)}
${colour('sky_azimuth_transition_col', [0.7, 0.8, 0.95], k)}
${colour('sky_sun_col', [1, 0.95, 0.8], k)}
${colour('sky_moon_col', [0.7, 0.75, 0.9], k)}
${colour('sky_cloud_base_col', [0.85, 0.88, 0.95], k)}
${colour('fog_col', [0.6, 0.7, 0.85], k)}
${colour('light_dir_col', [1, 0.95, 0.85], k)}
${colour('light_natural_amb_down_col', [0.3, 0.35, 0.45], k)}
      <postfx_exposure>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</postfx_exposure>
      <lod_mult>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</lod_mult>
      <ssao_inten>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</ssao_inten>
      <shadow_distance_mult>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</shadow_distance_mult>
      <light_ray_mult>0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8</light_ray_mult>
      <sky_stars_iten>1.0 0.4 0.0 0.0 0.0 0.0 0.0 0.3 1.0</sky_stars_iten>
      <sky_moon_iten>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</sky_moon_iten>
      <sky_moon_disc_size>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</sky_moon_disc_size>
      <fog_start>20 20 20 20 20 20 20 20 20</fog_start>
      <fog_density>0.4 0.4 0.4 0.4 0.4 0.4 0.4 0.4 0.4</fog_density>
      <postfx_intensity_bloom>0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6</postfx_intensity_bloom>
      <cloud_base_strength>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</cloud_base_strength>
      <dof_far>800 800 800 800 800 800 800 800 800</dof_far>
      <dof_blur_far>0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5</dof_blur_far>
      <sky_sun_disc_size>2.5 2.5 2.5 2.5 2.5 2.5 2.5 2.5 2.5</sky_sun_disc_size>
    </region>`;
}

function cycle(name) {
  return `  <cycle name="${name}" regions="2">
${region('GLOBAL', 1)}
${region('URBAN', 0.9)}
  </cycle>`;
}

function buildTimecycle(names = ['EXTRASUNNY']) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- fixture -->
<timecycle_keyframe_data>
${names.map(cycle).join('\n')}
</timecycle_keyframe_data>
`;
}

// Minimal gen8 texture dictionary (.ytd file bytes) with one DXT1 texture per name.
function buildYtd(names, w = 64, h = 64) {
  const zlib = require('zlib');
  const size = Math.max(8, (w / 4) * (h / 4) * 8);
  // gfx page: the smallest 0x200 << n that holds every texture
  let ss = 0;
  while ((0x200 << ss) < size * names.length) ss++;
  const sys = Buffer.alloc(0x2000);
  const gfx = Buffer.alloc(0x200 << ss);
  const S = 0x50000000, G = 0x60000000;
  sys.writeUInt32LE(S + 0x40, 0x30); sys.writeUInt16LE(names.length, 0x38); sys.writeUInt16LE(names.length, 0x3a);
  names.forEach((name, i) => {
    const t = 0x100 + i * 0x100;
    sys.writeUInt32LE(S + t, 0x40 + i * 8);
    sys.writeUInt32LE(S + t + 0xc0, t + 0x28);
    sys.writeUInt16LE(w, t + 0x50); sys.writeUInt16LE(h, t + 0x52); sys.writeUInt16LE(1, t + 0x54);
    sys.writeUInt32LE(0x31545844, t + 0x58); sys[t + 0x5d] = 1;
    sys.writeUInt32LE(G + i * size, t + 0x70);
    sys.write(name + '\0', t + 0xc0, 'latin1');
    gfx.fill(0x11 * (i + 1), i * size, (i + 1) * size);
  });
  const sysFlags = (1 << 27) | 4;
  const gfxFlags = ((13 << 28) | (1 << 27) | ss) >>> 0;
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(0x37435352, 0); hdr.writeUInt32LE(13, 4); hdr.writeUInt32LE(sysFlags, 8); hdr.writeUInt32LE(gfxFlags, 12);
  return Buffer.concat([hdr, zlib.deflateRawSync(Buffer.concat([sys, gfx]))]);
}

module.exports = { buildTimecycle, buildYtd };
