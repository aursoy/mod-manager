// 3D preview of a timecycle at an hour: a bay with a city skyline, hills and
// mountains under the pack's own sky. Everything takes its colour from the
// timecycle (sky top / horizon / sunrise and sunset sides, sun, moon, clouds, fog,
// sunlight, ambient, stars), so an edit shows up the way it would in game.
//
// One WebGL renderer draws for every preview canvas and the frame is copied into
// it, so the same drawScene(canvas, section, hour, opts) call as the 2D preview
// works. Until three.js has loaded, the 2D preview stands in.
import { sceneColours, daylight, twilight, sample, clamp01, mix } from './timecycle.js';
import { drawScene as draw2d } from './tcpreview.js';
let mergeGeometries = null;

let THREE = null;
let loading = null;
let S = null; // the scene, built once
const pending = new Map(); // canvas -> last args, redrawn once three.js is ready

const VERT = `varying vec3 vDir; void main() { vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const NOISE = `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }`;

const SKY_FRAG = `
uniform vec3 zenith, horizon, azEast, azWest, sunCol, moonCol, fogCol;
uniform vec3 sunDir, moonDir;
uniform float sunSize, moonSize, stars, day, time, imgMix, sideMix;
uniform sampler2D img; uniform bool hasImg;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float up = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 side = mix(azWest, azEast, d.x * 0.5 + 0.5);
  vec3 hor = mix(horizon, side, sideMix);
  vec3 col = mix(hor, zenith, up);
  if (h < 0.0) col = mix(hor, fogCol * 0.6, clamp(-h * 6.0, 0.0, 1.0));
  // the pack's sky picture (GTA blends it in at night, or all day)
  // (spread over the sky in front of the camera, so the whole picture is in view)
  if (hasImg && h > -0.02) {
    vec2 uv = vec2(0.5 + atan(d.x, -d.z) / 2.4, 1.0 - clamp(h / 0.62, 0.0, 1.0));
    vec3 t = texture2D(img, clamp(uv, 0.0, 1.0)).rgb;
    col = mix(col, t, imgMix * smoothstep(-0.02, 0.05, h));
  }
  // stars
  if (stars > 0.001 && h > 0.0) {
    vec2 g = vec2(atan(d.z, d.x) * 80.0, asin(h) * 80.0);
    vec2 cell = floor(g);
    float r = h21(cell);
    vec2 c = fract(g) - 0.5 - (vec2(h21(cell + 3.1), h21(cell + 7.7)) - 0.5) * 0.6;
    float s = step(0.965, r) * smoothstep(0.12, 0.0, length(c)) * (0.6 + 0.4 * sin(time * 2.0 + r * 40.0));
    col += vec3(s) * stars * smoothstep(0.0, 0.25, h);
  }
  // sun: disc and glow
  float sd = dot(d, sunDir);
  float disc = smoothstep(cos(sunSize), cos(sunSize * 0.85), sd);
  col += sunCol * (disc * 4.0 + pow(max(sd, 0.0), 300.0) * 1.5 + pow(max(sd, 0.0), 24.0) * 0.35 + pow(max(sd, 0.0), 4.0) * 0.12) * smoothstep(-0.1, 0.05, sunDir.y);
  // moon
  float md = dot(d, moonDir);
  float mdisc = smoothstep(cos(moonSize), cos(moonSize * 0.9), md);
  col = mix(col, moonCol * 1.4, mdisc * smoothstep(-0.05, 0.05, moonDir.y));
  col += moonCol * pow(max(md, 0.0), 60.0) * 0.25 * smoothstep(-0.05, 0.05, moonDir.y);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_FRAG = `
uniform vec3 cloudCol, shadeCol, sunCol, sunDir;
uniform float cover, time, day;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.02) discard;
  vec2 p = d.xz / d.y * 0.9 + vec2(time * 0.01, time * 0.004);
  float n = fbm(p * 1.3);
  float a = smoothstep(1.0 - cover, 1.0 - cover + 0.35, n);
  float lit = clamp(fbm(p * 1.3 + sunDir.xz * 0.08) - n + 0.55, 0.0, 1.0);
  vec3 col = mix(shadeCol, cloudCol, lit) + sunCol * pow(max(dot(d, sunDir), 0.0), 8.0) * 0.4 * day;
  a *= smoothstep(0.02, 0.25, d.y);
  gl_FragColor = vec4(col, a * 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const WATER_VERT = `varying vec3 vPos; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const WATER_FRAG = `
uniform vec3 zenith, horizon, sunCol, fogCol, deep;
uniform vec3 sunDir, moonDir, moonCol;
uniform float time, day, fogFar, imgMix;
uniform sampler2D img; uniform bool hasImg;
varying vec3 vPos;
${NOISE}
void main() {
  vec2 p = vPos.xz;
  float e = 0.35;
  vec2 q1 = p * 0.06 + vec2(time * 0.05, time * 0.03), q2 = p * 0.18 - vec2(time * 0.08, -time * 0.04);
  float h0 = fbm(q1) + 0.35 * fbm(q2);
  float hx = fbm(q1 + vec2(0.06 * e, 0.0)) + 0.35 * fbm(q2 + vec2(0.18 * e, 0.0));
  float hz = fbm(q1 + vec2(0.0, 0.06 * e)) + 0.35 * fbm(q2 + vec2(0.0, 0.18 * e));
  vec3 n = normalize(vec3((h0 - hx) * 6.0, 1.0, (h0 - hz) * 6.0));
  vec3 v = normalize(vPos - cameraPosition);
  vec3 r = reflect(v, n);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
  vec3 sky = mix(horizon, zenith, pow(clamp(r.y, 0.0, 1.0), 0.6));
  if (hasImg) sky = mix(sky, texture2D(img, clamp(vec2(0.5 + atan(r.x, -r.z) / 2.4, 1.0 - clamp(r.y / 0.62, 0.0, 1.0)), 0.0, 1.0)).rgb, imgMix);
  vec3 col = mix(deep, sky, fres);
  col += sunCol * pow(max(dot(r, sunDir), 0.0), 220.0) * 6.0 * smoothstep(-0.05, 0.05, sunDir.y);
  col += moonCol * pow(max(dot(r, moonDir), 0.0), 160.0) * 1.5 * smoothstep(-0.05, 0.05, moonDir.y);
  float f = smoothstep(fogFar * 0.15, fogFar, length(vPos - cameraPosition));
  col = mix(col, fogCol, f);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// 8 x 16 windows; buildings map it by their size, so every window is about 3.5 m wide
const WIN_W = 8 * 3.5, WIN_H = 16 * 3.4;
function windowsTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 128);
  const r = rng(5);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
    if (r() < 0.16) { const k = 0.3 + r() * 0.7; g.fillStyle = `rgb(${255 * k | 0},${205 * k | 0},${140 * k | 0})`; g.fillRect(x * 8 + 2, y * 8 + 2, 4, 4); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function build() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x888888, 150, 1500);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 4000);
  camera.position.set(0, 9, 70);
  camera.lookAt(0, 22, -300);

  const col = () => new THREE.Color();
  const skyU = {
    zenith: { value: col() }, horizon: { value: col() }, azEast: { value: col() }, azWest: { value: col() }, sunCol: { value: col() }, moonCol: { value: col() }, fogCol: { value: col() },
    sunDir: { value: new THREE.Vector3() }, moonDir: { value: new THREE.Vector3() }, sunSize: { value: 0.02 }, moonSize: { value: 0.018 }, sideMix: { value: 0.3 }, stars: { value: 0 }, day: { value: 1 }, time: { value: 0 },
    img: { value: null }, hasImg: { value: false }, imgMix: { value: 0 },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.renderOrder = -2;
  scene.add(sky);

  const cloudU = { cloudCol: { value: col() }, shadeCol: { value: col() }, sunCol: skyU.sunCol, sunDir: skyU.sunDir, cover: { value: 0.45 }, time: skyU.time, day: skyU.day };
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(2900, 48, 24), new THREE.ShaderMaterial({ uniforms: cloudU, vertexShader: VERT, fragmentShader: CLOUD_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }));
  clouds.renderOrder = -1;
  scene.add(clouds);

  const waterU = { zenith: skyU.zenith, horizon: skyU.horizon, sunCol: skyU.sunCol, moonCol: skyU.moonCol, fogCol: skyU.fogCol, deep: { value: col() }, sunDir: skyU.sunDir, moonDir: skyU.moonDir, time: skyU.time, day: skyU.day, fogFar: { value: 1500 }, img: skyU.img, hasImg: skyU.hasImg, imgMix: skyU.imgMix };
  const water = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.ShaderMaterial({ uniforms: waterU, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, fog: false }));
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  // land: a shore with hills, then mountains far back
  const landMat = new THREE.MeshStandardMaterial({ color: 0x4a5040, roughness: 0.95, flatShading: true });
  const r = rng(11);
  const ridge = (z, depth, height, w, seg, seed, mat) => {
    const g = new THREE.PlaneGeometry(w, depth, seg, 8);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const rr = rng(seed);
    const bumps = Array.from({ length: 7 }, () => [rr() * w - w / 2, rr() * 0.6 + 0.4, rr() * 180 + 80]);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), zz = p.getZ(i);
      const back = clamp01((-zz / depth) + 0.5);
      let hh = 0;
      for (const [bx, bh, bw] of bumps) hh = Math.max(hh, bh * Math.exp(-((x - bx) ** 2) / (2 * bw * bw)));
      hh = hh * height * Math.pow(back, 0.8) + (rr() - 0.5) * height * 0.06 * back;
      p.setY(i, Math.max(-2, hh - 1.5));
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.position.z = z;
    scene.add(m);
    return m;
  };
  const mountMat = landMat.clone();
  ridge(-1150, 300, 230, 3400, 90, 3, mountMat);
  ridge(-690, 200, 60, 2200, 80, 9, landMat);

  // the city on the shore: one mesh of boxes, windows mapped by each building's size
  const cityMat = new THREE.MeshStandardMaterial({ color: 0xc4c9cf, roughness: 0.55, metalness: 0.25, emissive: 0xffffff, emissiveMap: windowsTexture(), emissiveIntensity: 0 });
  const parts = [];
  for (let i = 0; i < 150; i++) {
    const x = (r() - 0.5) * 760;
    const centre = Math.exp(-(x * x) / (2 * 140 * 140));
    const h = 10 + r() * 22 + centre * (30 + r() * 95);
    const w = 10 + r() * 16, d = 10 + r() * 16;
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv, nrm = g.attributes.normal;
    for (let k = 0; k < uv.count; k++) {
      const side = Math.abs(nrm.getX(k)) > 0.5 ? d : w;
      if (Math.abs(nrm.getY(k)) > 0.5) uv.setXY(k, 0, 0); // roofs: no windows
      else uv.setXY(k, uv.getX(k) * side / WIN_W, uv.getY(k) * h / WIN_H);
    }
    g.rotateY((r() - 0.5) * 0.3);
    g.translate(x, h / 2 - 1, -560 - r() * 120);
    parts.push(g);
  }
  const city = new THREE.Mesh(mergeGeometries(parts), cityMat);
  parts.forEach((g) => g.dispose());
  scene.add(city);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.6);
  scene.add(sun, hemi, sun.target);

  const out = document.createElement('canvas');
  return { renderer, scene, camera, sky, skyU, cloudU, waterU, landMat, mountMat, cityMat, sun, hemi, out, imgTex: null, imgSrc: null };
}

const setC = (c, rgb, k = 1) => c.setRGB(Math.max(0, rgb[0] * k), Math.max(0, rgb[1] * k), Math.max(0, rgb[2] * k), THREE.SRGBColorSpace);

function scalar(sec, re, hour, fallback) {
  const p = (sec.scalars || []).find((x) => re.test(x.name));
  return p ? sample(p.values, hour) : fallback;
}

function render(canvas, sec, hour, opts) {
  if (!S) S = build();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(2, Math.round(rect.width * dpr)), H = Math.max(2, Math.round(rect.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const c = sceneColours(sec, hour);
  const dl = daylight(hour), tw = twilight(hour);
  const t = performance.now() / 1000;
  const U = S.skyU;

  // sun and moon on one arc: the sun is up 06:00-18:00 (east to west), the moon the other half
  const ang = ((hour - 6) / 12) * Math.PI;
  U.sunDir.value.set(Math.cos(ang) * 0.85, Math.sin(ang), -0.5).normalize();
  U.moonDir.value.set(-Math.cos(ang) * 0.85, -Math.sin(ang), -0.55).normalize();
  setC(U.zenith.value, c.zenith); setC(U.horizon.value, c.horizon);
  setC(U.azEast.value, c.azEast || c.horizon); setC(U.azWest.value, c.azWest || c.horizon);
  setC(U.sunCol.value, c.sunDisc || c.sun); setC(U.moonCol.value, c.moon || [0.8, 0.85, 1]); setC(U.fogCol.value, c.fog);
  U.sunSize.value = 0.012 + clamp01(scalar(sec, /sun_disc_size|sun_size/, hour, 1) / 12) * 0.05;
  U.moonSize.value = 0.01 + clamp01(scalar(sec, /moon_disc_size/, hour, 1) / 12) * 0.05;
  U.stars.value = clamp01(scalar(sec, /stars_iten/, hour, 1) / 2) * clamp01(1 - dl * 1.8) * 1.6;
  U.day.value = dl;
  U.sideMix.value = 0.15 + tw * 0.65; // the sunrise / sunset sides only show strongly around those hours
  U.time.value = t;
  // the sky picture
  if (opts && opts.image) {
    if (S.imgSrc !== opts.image) {
      // copied to a 2048 x 1024 canvas: power-of-two sizes work on every GPU
      const pc = document.createElement('canvas');
      pc.width = 2048; pc.height = 1024;
      pc.getContext('2d').drawImage(opts.image, 0, 0, 2048, 1024);
      if (S.imgTex) S.imgTex.dispose();
      S.imgTex = new THREE.CanvasTexture(pc);
      S.imgTex.colorSpace = THREE.SRGBColorSpace;
      S.imgTex.wrapS = S.imgTex.wrapT = THREE.ClampToEdgeWrapping;
      S.imgTex.anisotropy = 4;
      S.imgSrc = opts.image;
    }
    U.img.value = S.imgTex; U.hasImg.value = true;
    U.imgMix.value = opts.allDay ? 0.95 : clamp01(1 - dl * 1.6) * 0.95;
  } else { U.hasImg.value = false; U.imgMix.value = 0; }

  setC(S.cloudU.cloudCol.value, mix(c.cloud, [1, 1, 1], 0.15 * dl));
  setC(S.cloudU.shadeCol.value, mix(c.cloud, c.zenith, 0.55), 0.8);
  S.cloudU.cover.value = 0.35 + clamp01(scalar(sec, /cloud.*(dens|cover|amount)|cloudgen/, hour, 0.5)) * 0.4;

  setC(S.waterU.deep.value, mix(c.ambient, [0.02, 0.06, 0.08], 0.6), 0.5 + dl * 0.5);
  const fogD = scalar(sec, /^fog_density|fog_dens/, hour, 1);
  const fogFar = 2400 / (0.6 + Math.min(4, Math.max(0, fogD)) * 0.8);
  S.waterU.fogFar.value = fogFar;
  S.scene.fog.color.copy(U.fogCol.value);
  S.scene.fog.near = fogFar * 0.08; S.scene.fog.far = fogFar;

  const dir = c.dirLight || c.sun;
  const sunUp = U.sunDir.value.y > -0.05;
  setC(S.sun.color, sunUp ? dir : (c.moon || [0.6, 0.7, 1]));
  S.sun.intensity = sunUp ? 0.4 + dl * 2.6 + tw * 0.6 : 0.25;
  // light the side of the city that faces the camera (the sun in the sky sits behind it)
  S.sun.position.copy(sunUp ? U.sunDir.value : U.moonDir.value).setZ(0.6).normalize().multiplyScalar(500);
  setC(S.hemi.color, mix(c.ambient, c.zenith, 0.4));
  setC(S.hemi.groundColor, mix(c.ambient, [0, 0, 0], 0.5));
  S.hemi.intensity = 0.35 + dl * 0.8;
  setC(S.landMat.color, mix([0.28, 0.3, 0.22], c.fog, 0.1));
  setC(S.mountMat.color, mix([0.22, 0.24, 0.2], c.fog, 0.35));
  S.cityMat.emissiveIntensity = clamp01(1 - dl * 1.7) * 0.55;

  // a gentle camera drift so it never looks like a still
  S.camera.position.set(Math.sin(t * 0.05) * 6, 12 + Math.sin(t * 0.07) * 0.8, 70);
  S.camera.aspect = W / H;
  S.camera.updateProjectionMatrix();
  S.camera.lookAt(0, 70, -600);

  S.renderer.setSize(W, H, false);
  S.renderer.render(S.scene, S.camera);
  canvas.getContext('2d').drawImage(S.renderer.domElement, 0, 0);
}

/** Same call as the 2D preview. */
export function drawScene(canvas, sec, hour, opts = null) {
  if (!sec) return;
  if (THREE) {
    try { return render(canvas, sec, hour, opts); } catch (e) { console.error('[preview] 3D failed, using 2D:', e); THREE = false; }
  }
  if (THREE === false) return draw2d(canvas, sec, hour, opts);
  pending.set(canvas, [sec, hour, opts]);
  draw2d(canvas, sec, hour, opts);
  if (!loading) {
    loading = Promise.all([import('three'), import('three/addons/utils/BufferGeometryUtils.js')]).then(([mod, utils]) => {
      THREE = mod;
      mergeGeometries = utils.mergeGeometries;
      for (const [cv, args] of pending) drawScene(cv, ...args);
      pending.clear();
    }).catch((e) => { console.error('[preview] three.js not available:', e); THREE = false; });
  }
}
