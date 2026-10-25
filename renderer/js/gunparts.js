// 3D parts for the Gun Lab: extruded text, and a chain with a pendant (logo or
// text). Parts are real meshes. On export they are written into the gun's .ydr
// (src/core/ydrwrite.js), inside the model part they were placed on, so they
// use its shader and move with it.
//
// Colours: a weapon's shader takes its colour from the gun's texture, so each
// colour gets a small patch in an unused corner of that texture (found from the
// model's UVs) and the part's UVs point at it. The logo is painted into a
// bigger patch the same way. Sizes are in metres (GTA units).
import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const FINISH = {
  metal: { metalness: 0.85, roughness: 0.3, spec: '#c8c8c8' },
  chrome: { metalness: 1, roughness: 0.08, spec: '#ffffff' },
  gloss: { metalness: 0.1, roughness: 0.2, spec: '#e0e0e0' },
  matte: { metalness: 0, roughness: 0.85, spec: '#1c1c1c' },
};

// ---------- placement ----------

/** Basis for something sitting on a surface: z = surface normal, y = "up" along the surface (GTA is Z-up). */
export function surfaceBasis(normal, rotDeg = 0) {
  const n = new THREE.Vector3(...normal).normalize();
  let up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(n.dot(up)) > 0.95) up = new THREE.Vector3(1, 0, 0);
  const y = up.sub(n.clone().multiplyScalar(up.dot(n))).normalize();
  const x = new THREE.Vector3().crossVectors(y, n).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, n);
  if (rotDeg) m.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(rotDeg)));
  return m;
}

// ---------- geometry builders (all return non-indexed geometry with a "role" per vertex) ----------

function tagRole(geo, role) {
  const n = geo.attributes.position.count;
  geo.setAttribute('role', new THREE.BufferAttribute(new Uint8Array(n).fill(role), 1));
  return geo;
}

// roles: 0 front, 1 side, 2 chain, 3 rim, 4 logo
function rolesFromGroups(geo, capRole, sideRole) {
  const n = geo.attributes.position.count;
  const r = new Uint8Array(n).fill(sideRole);
  for (const g of geo.groups) if (g.materialIndex === 0) r.fill(capRole, g.start, g.start + g.count);
  geo.setAttribute('role', new THREE.BufferAttribute(r, 1));
  geo.clearGroups();
  return geo;
}

/** Extruded, bevelled text; its back face sits on z = 0. */
export function textGeometry(P, font) {
  const size = P.size / 100; // cm -> m
  const depth = Math.max(0.0003, P.depth / 1000); // mm -> m
  const bevel = (P.bevel / 100) * size;
  let geo = new TextGeometry(P.text || ' ', {
    font, size, height: depth, curveSegments: 4,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.7, bevelSegments: 1,
  });
  geo = geo.index ? geo.toNonIndexed() : geo;
  rolesFromGroups(geo, 0, 1);
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  if (P.mirror) geo.scale(-1, 1, 1);
  return geo;
}

function link(r, tube, stretch) {
  const g = new THREE.TorusGeometry(r, tube, 5, 12);
  g.scale(stretch, 1, 1);
  return tagRole(g.toNonIndexed(), 2);
}

function shapeFor(kind, R) {
  const s = new THREE.Shape();
  if (kind === 'square') {
    const r = R * 0.25, a = R;
    s.moveTo(-a + r, -a); s.lineTo(a - r, -a); s.quadraticCurveTo(a, -a, a, -a + r);
    s.lineTo(a, a - r); s.quadraticCurveTo(a, a, a - r, a); s.lineTo(-a + r, a);
    s.quadraticCurveTo(-a, a, -a, a - r); s.lineTo(-a, -a + r); s.quadraticCurveTo(-a, -a, -a + r, -a);
  } else if (kind === 'heart') {
    s.moveTo(0, -R);
    s.bezierCurveTo(R * 0.2, -R * 0.55, R, -R * 0.2, R, R * 0.3);
    s.bezierCurveTo(R, R * 0.9, R * 0.25, R * 1.05, 0, R * 0.55);
    s.bezierCurveTo(-R * 0.25, R * 1.05, -R, R * 0.9, -R, R * 0.3);
    s.bezierCurveTo(-R, -R * 0.2, -R * 0.2, -R * 0.55, 0, -R);
  } else {
    s.absarc(0, 0, R, 0, Math.PI * 2, false);
  }
  return s;
}

/** Chain hanging straight down (−Z) from z = 0, plus its pendant. Basis-free: caller places it. */
export function chainGeometry(P, font) {
  const parts = [];
  const r = P.linkSize / 1000; // mm -> m (link radius)
  const tube = Math.max(0.0004, r * P.linkThick / 100);
  const stretch = 1.45;
  const pitch = r * stretch * 2 - tube * 2.4;
  for (let i = 0; i < P.links; i++) {
    const g = link(r, tube, stretch);
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2); // long axis down
    if (i % 2) m.premultiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    m.premultiply(new THREE.Matrix4().makeTranslation(0, 0, -(r * stretch - tube) - i * pitch));
    g.applyMatrix4(m);
    parts.push(g);
  }
  const end = -(r * stretch - tube) - (P.links - 1) * pitch - r * stretch;
  if (P.pendant !== 'none') {
    const R = P.pendantSize / 200; // cm (diameter) -> m (radius)
    const thick = Math.max(0.0008, R * 0.18);
    let pend;
    if (P.pendant === 'text') {
      pend = textGeometry({ text: P.pendantText, size: P.pendantSize, depth: thick * 1000, bevel: 4 }, font);
      pend.computeBoundingBox();
      const top = pend.boundingBox.max.y;
      pend.translate(0, -top, -thick / 2);
    } else {
      pend = new THREE.ExtrudeGeometry(shapeFor(P.shape, R), { depth: thick, curveSegments: 24, bevelEnabled: true, bevelThickness: thick * 0.25, bevelSize: R * 0.06, bevelSegments: 2 });
      pend = pend.index ? pend.toNonIndexed() : pend;
      rolesFromGroups(pend, P.pendant === 'logo' ? 4 : 3, 3);
      pend.translate(0, -R * 1.02, -thick / 2);
      // logo UVs from the cap's x/y (0..1 across the shape)
      const pos = pend.attributes.position, uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / (2 * R) + 0.5; uv[i * 2 + 1] = 0.5 - (pos.getY(i) + R * 1.02) / (2 * R); }
      pend.setAttribute('luv', new THREE.BufferAttribute(uv, 2));
    }
    // stand it up and turn its front (+Z) outward (+Y in chain space), then hang it from the last link
    pend.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    pend.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI));
    pend.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, end + tube));
    parts.push(pend);
  }
  return mergeAll(parts);
}

function mergeAll(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), role = new Uint8Array(n), luv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    role.set(g.attributes.role.array, o);
    if (g.attributes.luv) luv.set(g.attributes.luv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('role', new THREE.BufferAttribute(role, 1));
  out.setAttribute('luv', new THREE.BufferAttribute(luv, 2));
  return out;
}

/** Chain hangs along −Z of the gun; it starts at the anchor, facing out along the surface normal. */
export function chainPlacement(point, normal) {
  const n = new THREE.Vector3(...normal);
  n.z = 0;
  if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
  n.normalize();
  const down = new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(n, down).normalize();
  // chain space: x -> x, y -> outward normal, z -> up
  const m = new THREE.Matrix4().makeBasis(x, n, down);
  const off = new THREE.Vector3(...normal).normalize().multiplyScalar(0.0015);
  m.setPosition(new THREE.Vector3(...point).add(off));
  return m;
}

// ---------- texture patches ----------

/** Which 4x4 blocks of a texture the model uses (from all meshes drawn with it). */
export function coverage(w, h, meshes) {
  const W = Math.max(1, w >> 2), H = Math.max(1, h >> 2);
  const used = new Uint8Array(W * H);
  const mark = (x, y) => { used[(((y % H) + H) % H) * W + (((x % W) + W) % W)] = 1; };
  for (const m of meshes) {
    const uv = m.uvs, idx = m.indices;
    if (!uv) continue;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const P = [[uv[a * 2] * W, uv[a * 2 + 1] * H], [uv[b * 2] * W, uv[b * 2 + 1] * H], [uv[c * 2] * W, uv[c * 2 + 1] * H]];
      if (P.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      const x0 = Math.floor(Math.min(P[0][0], P[1][0], P[2][0])), x1 = Math.ceil(Math.max(P[0][0], P[1][0], P[2][0]));
      const y0 = Math.floor(Math.min(P[0][1], P[1][1], P[2][1])), y1 = Math.ceil(Math.max(P[0][1], P[1][1], P[2][1]));
      if ((x1 - x0) * (y1 - y0) > W * H * 4) continue; // broken UVs
      for (const p of P) mark(Math.floor(p[0]), Math.floor(p[1]));
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          // cell overlaps the triangle if its centre is inside, or any corner is (good enough at block scale)
          for (const [cx, cy] of [[x + 0.5, y + 0.5], [x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
            const w0 = ((P[1][0] - cx) * (P[2][1] - cy) - (P[2][0] - cx) * (P[1][1] - cy)) / area;
            const w1 = ((P[2][0] - cx) * (P[0][1] - cy) - (P[0][0] - cx) * (P[2][1] - cy)) / area;
            if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) { mark(x, y); break; }
          }
        }
      }
    }
  }
  // keep a one-block gap around everything the gun uses
  const grown = new Uint8Array(used);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!used[y * W + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) grown[Y * W + X] = 1;
    }
  }
  return { W, H, used: grown };
}

/** Take a free square of `size` blocks (in texels: 4*size). Returns {x,y,w,h} in texels or null. */
export function takeSquare(cov, size) {
  const { W, H, used } = cov;
  if (size > W || size > H) return null;
  const S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) S[(y + 1) * (W + 1) + x + 1] = used[y * W + x] + S[y * (W + 1) + x + 1] + S[(y + 1) * (W + 1) + x] - S[y * (W + 1) + x];
  const sum = (x, y, s) => S[(y + s) * (W + 1) + x + s] - S[y * (W + 1) + x + s] - S[(y + s) * (W + 1) + x] + S[y * (W + 1) + x];
  // prefer squares aligned to their own size (cleaner mip levels), then any position
  for (const step of [size, Math.max(1, size >> 1), 1]) {
    for (let y = H - size; y >= 0; y -= step) {
      for (let x = W - size; x >= 0; x -= step) {
        if (sum(x, y, size) === 0) {
          for (let yy = y; yy < y + size; yy++) used.fill(1, yy * W + x, yy * W + x + size);
          return { x: x * 4, y: y * 4, w: size * 4, h: size * 4 };
        }
      }
    }
  }
  return null;
}

// ---------- final per-vertex data ----------

/** Turn a part geometry (roles + local placement) into indexed arrays with UVs pointing at its patches.
 *  patchOf(role) -> {u0,v0,u1,v1} (0..1 texture space) or null (use the fallback UV). */
export function bake(geo, matrix, patchOf, fallbackUv) {
  const g = geo.clone();
  g.applyMatrix4(matrix);
  const pos = g.attributes.position, role = g.attributes.role, luv = g.attributes.luv;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const p = patchOf(role.getX(i));
    if (!p) { uv[i * 2] = fallbackUv[0]; uv[i * 2 + 1] = fallbackUv[1]; continue; }
    if (role.getX(i) === 4 && luv) {
      uv[i * 2] = p.u0 + (p.u1 - p.u0) * Math.min(1, Math.max(0, luv.getX(i)));
      uv[i * 2 + 1] = p.v0 + (p.v1 - p.v0) * Math.min(1, Math.max(0, luv.getY(i)));
    } else {
      uv[i * 2] = (p.u0 + p.u1) / 2; uv[i * 2 + 1] = (p.v0 + p.v1) / 2;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.deleteAttribute('role');
  if (g.attributes.luv) g.deleteAttribute('luv');
  const merged = mergeVertices(g, 1e-6);
  if (!merged.attributes.normal) merged.computeVertexNormals();
  return merged;
}
