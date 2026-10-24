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

function cycle(name) {
  return `  <cycle name="${name}">
${colour('sky_zenith_col', [0.25, 0.45, 0.85])}
${colour('sky_horizon_col', [0.7, 0.8, 0.95])}
${colour('sky_azimuth_east_col', [0.9, 0.75, 0.6])}
${colour('sky_azimuth_west_col', [0.95, 0.7, 0.5])}
${colour('sky_sun_col', [1, 0.95, 0.8])}
${colour('sky_cloud_base_col', [0.85, 0.88, 0.95])}
${colour('fog_col', [0.6, 0.7, 0.85])}
${colour('light_dir_col', [1, 0.95, 0.85])}
${colour('light_natural_amb_down_col', [0.3, 0.35, 0.45])}
      <postfx_exposure>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</postfx_exposure>
      <lod_mult>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</lod_mult>
      <ssao_inten>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</ssao_inten>
      <shadow_distance_mult>1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0</shadow_distance_mult>
      <light_ray_mult>0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8</light_ray_mult>
      <sky_sun_disc_size value="2.5"/>
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

module.exports = { buildTimecycle };
