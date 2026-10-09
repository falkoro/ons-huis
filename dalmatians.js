// dalmatians.js - Logan & Gemma: two skinned, procedurally textured dalmatians that live in the house.
// Standalone ES module, imports nothing: THREE (0.170.0) is passed in.
//
//   import { addDalmatians, pet } from './dalmatians.js';
//   const dogs = addDalmatians(THREE, scene, { onTick });   // -> { dogs:[{group,name,...}], bed, beds, addBed, removeBed, rest, place, pet, call(name), dispose, update }
//   HOUSE.dogs = dogs;  // raycast dogs.dogs[i].group -> pet(hit.object); dogs.call('Logan')
//   dogs.addBed({ id: 'kussen', x, z, y: 0.12, r: 0.42, heading, room: 'zitkamer' }); dogs.rest('Gemma', 'kussen'); // rest spots
//   dogs.place('Logan', { bed: 'kussen' })  // or { x, z, heading, pose: 'donut' | 'side' | 'curl' | 'lie' | 'sit' | 'stand' }
//
// Uses window.HOUSE when present (walker, colliders, doors, rooms, state.time, ui.toast, mode, camera) and degrades
// gracefully without it. Coordinates: metres, Y up, X 0..9 left->right, Z 0 back facade .. 12.25 front facade.
// Each dog's local forward is +Z; group.rotation.y = heading (forward = (sin h, 0, cos h)).

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const LOWQ = COARSE || (typeof innerWidth === 'number' && innerWidth <= 760);

// ================================================================ SKINNED TUBE GEOMETRY
// A dog is one SkinnedMesh built from "tubes": rings of (centre, half-width, top/bottom half-height) swept along a
// path, each ring carrying bone weights. The body (tail base -> nose), four legs, tail and ears are separate tubes
// in one BufferGeometry; eyes and nose are tiny extra meshes parented to the head bone. The hand-placed key rings are
// refined with a Catmull-Rom spline (positions, radii and bone weights), so joints and the head read as smooth flesh.
const RING_F = ['w', 'ht', 'hb', 'pinch', 'jaw', 'sq', 'toes'];
function refine(rings, sub) {
  if (sub <= 1) return rings;
  const n = rings.length, out = [], at = (i) => rings[clamp(i, 0, n - 1)], g = (i, k) => (k === 'sq' ? at(i).sq ?? 2 : at(i)[k] || 0);
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < sub; j++) {
    const t = j / sub, r = { p: [0, 0, 0], b: null };
    for (let ax = 0; ax < 3; ax++) r.p[ax] = cr(at(i - 1).p[ax], at(i).p[ax], at(i + 1).p[ax], at(i + 2).p[ax], t);
    for (const k of RING_F) r[k] = cr(g(i - 1, k), g(i, k), g(i + 1, k), g(i + 2, k), t);
    r.w = Math.max(r.w, 0.002); r.ht = Math.max(r.ht, 0.002); r.hb = Math.max(r.hb, 0.002); r.sq = Math.max(r.sq, 1.6);
    const m = new Map(); // bone weights: linear blend of the two key rings, best four kept
    for (const [bn, wt] of at(i).b) m.set(bn, (m.get(bn) || 0) + wt * (1 - t));
    for (const [bn, wt] of at(i + 1).b) m.set(bn, (m.get(bn) || 0) + wt * t);
    r.b = [...m].sort((a, b) => b[1] - a[1]).slice(0, 4);
    out.push(r);
  }
  out.push({ ...rings[n - 1] });
  return out;
}
class MeshBuilder {
  constructor() { this.pos = []; this.uv = []; this.si = []; this.sw = []; this.idx = []; this.seams = []; this.regions = []; }
  // rings: [{ p:[x,y,z], w, ht, hb, pinch, sq (superellipse power, 2 = ellipse), toes (lobes on top), b:[[bone,wt],...] }]
  // region { u0,u1,v0,v1, seam (angle of seam), id, sub (spline refinement) }
  tube(rings, region, seg, bones) {
    rings = refine(rings, region.sub || 1);
    const P = this.pos, base = P.length / 3, n = rings.length;
    const T = [], S = [], U = [], L = [0];
    for (let i = 0; i < n; i++) {
      const a = rings[Math.max(0, i - 1)].p, b = rings[Math.min(n - 1, i + 1)].p;
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // side = cross(ref, t), up = cross(t, side); ref = Y unless the tube runs vertically (then Z)
      let sx = 0, sy = 0, sz = 0;
      if (i > 0) { // parallel transport of the previous side vector: no frame flips around bends
        const px = S[3 * i - 3], py = S[3 * i - 2], pz = S[3 * i - 1], dd = px * tx + py * ty + pz * tz;
        sx = px - tx * dd; sy = py - ty * dd; sz = pz - tz * dd;
      }
      if (i === 0 || Math.hypot(sx, sy, sz) < 1e-4) {
        if (Math.abs(ty) < 0.9) { sx = tz; sy = 0; sz = -tx; } else { sx = -ty; sy = tx; sz = 0; }
        if (sx < -1e-3) { sx = -sx; sy = -sy; sz = -sz; } // +X side first, so U runs the same way on every tube
      }
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const ux = ty * sz - tz * sy, uy = tz * sx - tx * sz, uz = tx * sy - ty * sx;
      T.push(tx, ty, tz); S.push(sx, sy, sz); U.push(ux, uy, uz);
      if (i > 0) { const q = rings[i - 1].p, r = rings[i].p; L.push(L[i - 1] + Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2])); }
    }
    const len = L[n - 1] || 1, circ = [], vs = [];
    const seam = region.seam == null ? -Math.PI / 2 : region.seam;
    for (let i = 0; i < n; i++) {
      const r = rings[i], v = region.v0 + (region.v1 - region.v0) * (L[i] / len);
      vs.push(v); circ.push(Math.PI * (r.w + (r.ht + r.hb) / 2)); // approx circumference, for spot scaling
      const pinch = r.pinch || 0, sq = r.sq || 2, toes = r.toes || 0;
      for (let k = 0; k <= seg; k++) {
        const th = seam + (k / seg) * TAU, c = Math.cos(th), s = Math.sin(th);
        let kk = sq === 2 ? 1 : Math.pow(Math.pow(Math.abs(c), sq) + Math.pow(Math.abs(s), sq), -1 / sq); // squarer muzzle
        if (toes && s > 0) kk *= 1 + toes * 0.5 * (1 + Math.cos(8 * (th - seam))) * s;                      // toe lobes across the top of a paw
        const h = s >= 0 ? r.ht : r.hb, wx = r.w * c * kk * (s < 0 ? 1 - pinch * -s : 1), hy = h * s * kk;
        P.push(r.p[0] + S[3 * i] * wx + U[3 * i] * hy, r.p[1] + S[3 * i + 1] * wx + U[3 * i + 1] * hy, r.p[2] + S[3 * i + 2] * wx + U[3 * i + 2] * hy);
        this.uv.push(region.u0 + (region.u1 - region.u0) * (k / seg), v);
        if (r.jaw) { const m = clamp((-s - 0.1) / 0.5, 0, 1) * r.jaw; this.si.push(bones.head, bones.jaw, 0, 0); this.sw.push(1 - m, m, 0, 0); }
        else this.pushWeights(r.b, bones);
      }
      this.seams.push(base + i * (seg + 1), base + i * (seg + 1) + seg);
    }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * (seg + 1) + k, b = a + seg + 1;
      this.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    // caps: a fan to a centre point just beyond the end ring
    const cap = (i, dir) => {
      const r = rings[i], c = P.length / 3, ext = Math.min(r.w, (r.ht + r.hb) / 2) * 0.9 * dir;
      P.push(r.p[0] + T[3 * i] * ext, r.p[1] + T[3 * i + 1] * ext, r.p[2] + T[3 * i + 2] * ext);
      this.uv.push((region.u0 + region.u1) / 2, vs[i]); this.pushWeights(r.b, bones);
      const ring = base + i * (seg + 1);
      for (let k = 0; k < seg; k++) dir > 0 ? this.idx.push(ring + k, ring + k + 1, c) : this.idx.push(ring + k + 1, ring + k, c);
    };
    if (region.capStart !== false) cap(0, -1);
    if (region.capEnd !== false) cap(n - 1, 1);
    const info = { id: region.id, u0: region.u0, u1: region.u1, v0: region.v0, v1: region.v1, len, vs, circ, rings, seam, sub: region.sub || 1 };
    info.circAt = (v) => { for (let i = 1; i < n; i++) if (v <= vs[i]) return lerp(circ[i - 1], circ[i], clamp((v - vs[i - 1]) / (vs[i] - vs[i - 1] || 1), 0, 1)); return circ[n - 1]; };
    this.regions.push(info);
    return info;
  }
  pushWeights(b, bones) {
    let s = 0; for (let i = 0; i < b.length; i++) s += b[i][1]; s = s || 1;
    for (let i = 0; i < 4; i++) { const e = b[i]; this.si.push(e ? bones[e[0]] : 0); this.sw.push(e ? e[1] / s : 0); }
  }
  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const nr = g.attributes.normal; // weld the seam normals so the UV seam is invisible
    for (let i = 0; i < this.seams.length; i += 2) {
      const a = this.seams[i], b = this.seams[i + 1];
      let x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b);
      const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      nr.setXYZ(a, x, y, z); nr.setXYZ(b, x, y, z);
    }
    g.computeBoundingSphere();
    return g;
  }
}

// ---- rig: bone rest positions (dog local space, scale 1 = Logan). All rest rotations are identity.
const BONES = [
  ['root', null, 0, 0.49, -0.22], ['spine', 'root', 0, 0.515, -0.03], ['chest', 'spine', 0, 0.52, 0.17], ['ribs', 'chest', 0, 0.44, 0.08],
  ['neck', 'chest', 0, 0.54, 0.31], ['neck2', 'neck', 0, 0.62, 0.38], ['head', 'neck2', 0, 0.665, 0.43], ['jaw', 'head', 0, 0.64, 0.51],
  ['earL', 'head', 0.055, 0.72, 0.47], ['earR', 'head', -0.055, 0.72, 0.47],
  ['armL', 'chest', 0.066, 0.47, 0.215], ['foreL', 'armL', 0.067, 0.305, 0.205], ['pawL', 'foreL', 0.067, 0.07, 0.205],
  ['armR', 'chest', -0.066, 0.47, 0.215], ['foreR', 'armR', -0.067, 0.305, 0.205], ['pawR', 'foreR', -0.067, 0.07, 0.205],
  ['thighL', 'root', 0.06, 0.465, -0.26], ['shinL', 'thighL', 0.064, 0.27, -0.20], ['footL', 'shinL', 0.064, 0.15, -0.32],
  ['thighR', 'root', -0.06, 0.465, -0.26], ['shinR', 'thighR', -0.064, 0.27, -0.20], ['footR', 'shinR', -0.064, 0.15, -0.32],
  ['tail1', 'root', 0, 0.515, -0.34], ['tail2', 'tail1', 0, 0.5, -0.41], ['tail3', 'tail2', 0, 0.475, -0.48], ['tail4', 'tail3', 0, 0.445, -0.545], ['tail5', 'tail4', 0, 0.41, -0.605],
];
const BI = {}; BONES.forEach((b, i) => { BI[b[0]] = i; });

// Body tube from the buttocks to the nose. ht/hb = top/bottom half heights, pinch narrows the underside (keel), sq squares
// the section (muzzle). Proportions of a 58 cm dalmatian: deep brisket to the elbow, tucked loin, level topline, long muzzle.
function bodyRings(f) {
  const R = (z, y, w, ht, hb, b, pinch = 0.1, jaw = 0, sq = 2) => ({ p: [0, y, z], w: w * f.wide, ht, hb, pinch, b, jaw, sq });
  return [
    R(-0.36, 0.45, 0.035, 0.045, 0.045, [['root', 1]], 0),
    R(-0.335, 0.455, 0.088, 0.08, 0.075, [['root', 1]], 0),
    R(-0.26, 0.468, 0.112, 0.1, 0.09, [['root', 1]], 0.1),                          // hips, broad croup, wraps the thighs
    R(-0.17, 0.478, 0.092, 0.095, 0.082, [['root', 0.5], ['spine', 0.5]], 0.2),      // loin, tucked
    R(-0.08, 0.476, 0.1, 0.1, 0.118, [['spine', 0.8], ['ribs', 0.2]], 0.25),
    R(0.02, 0.47, 0.107, 0.11, 0.16, [['ribs', 0.7], ['spine', 0.3]], 0.3),          // ribcage, deepest
    R(0.13, 0.465, 0.107, 0.115, 0.165, [['ribs', 0.6], ['chest', 0.4]], 0.32),      // brisket at the elbow
    R(0.23, 0.46, 0.098, 0.125, 0.15, [['chest', 1]], 0.3),                          // withers / shoulder
    R(0.3, 0.47, 0.082, 0.11, 0.12, [['chest', 0.5], ['neck', 0.5]], 0.25),          // forechest, base of neck
    R(0.345, 0.53, 0.068, 0.082, 0.09, [['neck', 0.8], ['neck2', 0.2]], 0.15),
    R(0.385, 0.6, 0.06, 0.066, 0.07, [['neck2', 0.75], ['neck', 0.25]], 0.1),
    R(0.42, 0.655, 0.057, 0.058, 0.06, [['neck2', 0.4], ['head', 0.6]], 0),          // throat
    R(0.455, 0.685, 0.062, 0.056, 0.056, [['head', 1]], 0),                          // occiput
    R(0.49, 0.69, 0.064, 0.054, 0.052, [['head', 1]], 0, 0, 2.4),                    // skull, flat on top
    R(0.52, 0.685, 0.06, 0.049, 0.05, [['head', 1]], 0, 0, 2.4),                     // brow
    R(0.545, 0.672, 0.05, 0.04, 0.046, [['head', 1]], 0, 0.3, 2.6),                  // stop
    R(0.58, 0.66, 0.042, 0.034, 0.042, [['head', 1]], 0.05, 0.7, 3),                 // muzzle, square
    R(0.625, 0.65, 0.037, 0.03, 0.036, [['head', 1]], 0.1, 0.85, 3),
    R(0.66, 0.645, 0.03, 0.026, 0.028, [['head', 1]], 0.1, 0.8, 2.6),                // nose
  ];
}
function frontLegRings(s, f) {
  const x = s * 0.054 * f.wide, R = (y, z, w, ht, hb, b, toes = 0) => ({ p: [x, y, z], w, ht, hb, b, toes });
  const a = 'arm' + (s > 0 ? 'L' : 'R'), fo = 'fore' + (s > 0 ? 'L' : 'R'), pw = 'paw' + (s > 0 ? 'L' : 'R');
  return [
    R(0.5, 0.205, 0.02, 0.04, 0.034, [['chest', 1]]),              // starts inside the chest
    R(0.46, 0.21, 0.03, 0.05, 0.044, [[a, 0.6], ['chest', 0.4]]),  // upper arm, muscled
    R(0.41, 0.215, 0.032, 0.048, 0.042, [[a, 1]]),
    R(0.34, 0.21, 0.03, 0.038, 0.034, [[a, 0.7], [fo, 0.3]]),
    R(0.3, 0.205, 0.028, 0.033, 0.031, [[a, 0.4], [fo, 0.6]]),      // elbow
    R(0.22, 0.2, 0.026, 0.03, 0.027, [[fo, 1]]),
    R(0.14, 0.2, 0.024, 0.026, 0.024, [[fo, 1]]),
    R(0.085, 0.2, 0.023, 0.025, 0.023, [[fo, 0.6], [pw, 0.4]]),     // pastern
    R(0.05, 0.208, 0.026, 0.026, 0.022, [[pw, 1]]),
    R(0.028, 0.235, 0.031, 0.024, 0.02, [[pw, 1]], 0.08),           // paw, toes
    R(0.016, 0.268, 0.03, 0.017, 0.014, [[pw, 1]], 0.1),
    R(0.012, 0.285, 0.024, 0.012, 0.01, [[pw, 1]]),
  ];
}
function hindLegRings(s, f) {
  const x = s * 0.06 * f.wide, R = (y, z, w, ht, hb, b, toes = 0) => ({ p: [x, y, z], w, ht, hb, b, toes });
  const t = 'thigh' + (s > 0 ? 'L' : 'R'), sh = 'shin' + (s > 0 ? 'L' : 'R'), ft = 'foot' + (s > 0 ? 'L' : 'R');
  return [
    R(0.49, -0.22, 0.02, 0.04, 0.03, [['root', 1]]),                // starts inside the croup
    R(0.45, -0.225, 0.034, 0.07, 0.04, [[t, 0.5], ['root', 0.5]]),
    R(0.41, -0.225, 0.042, 0.082, 0.048, [[t, 1]]),                 // upper thigh, broad front-back, inside the body outline
    R(0.35, -0.218, 0.038, 0.066, 0.046, [[t, 1]]),
    R(0.3, -0.21, 0.033, 0.05, 0.04, [[t, 0.65], [sh, 0.35]]),
    R(0.265, -0.21, 0.03, 0.04, 0.036, [[t, 0.35], [sh, 0.65]]),    // stifle
    R(0.215, -0.255, 0.027, 0.033, 0.034, [[sh, 1]]),
    R(0.17, -0.305, 0.025, 0.028, 0.032, [[sh, 0.55], [ft, 0.45]]), // hock
    R(0.12, -0.31, 0.022, 0.025, 0.026, [[ft, 1]]),
    R(0.065, -0.3, 0.023, 0.026, 0.024, [[ft, 1]]),
    R(0.035, -0.272, 0.028, 0.027, 0.021, [[ft, 1]]),
    R(0.022, -0.235, 0.031, 0.022, 0.019, [[ft, 1]], 0.08),         // paw, toes
    R(0.014, -0.205, 0.027, 0.014, 0.012, [[ft, 1]], 0.1),
    R(0.011, -0.192, 0.02, 0.01, 0.008, [[ft, 1]]),
  ];
}
function tailRings() {
  const R = (y, z, r, b) => ({ p: [0, y, z], w: r, ht: r, hb: r, b });
  return [
    R(0.515, -0.335, 0.028, [['tail1', 1]]), R(0.5, -0.41, 0.023, [['tail1', 0.4], ['tail2', 0.6]]),
    R(0.475, -0.48, 0.019, [['tail2', 0.4], ['tail3', 0.6]]), R(0.445, -0.545, 0.015, [['tail3', 0.4], ['tail4', 0.6]]),
    R(0.41, -0.605, 0.012, [['tail4', 0.4], ['tail5', 0.6]]), R(0.375, -0.645, 0.009, [['tail5', 1]]), R(0.35, -0.668, 0.006, [['tail5', 1]]),
  ];
}
// ear: a thin flat tube hanging from the high ear set, draped forward against the cheek (w = thickness, h = half width)
function earRings(s, f) {
  const e = 'ear' + (s > 0 ? 'L' : 'R'), R = (dx, dy, dz, w, h, b) => ({ p: [s * (0.055 + dx) * f.wide, 0.72 + dy, 0.47 + dz], w, ht: h, hb: h, b });
  return [
    R(0.0, 0.008, 0.0, 0.012, 0.028, [['head', 0.5], [e, 0.5]]),
    R(0.012, -0.018, -0.004, 0.008, 0.04, [[e, 1]]),
    R(0.016, -0.05, -0.002, 0.006, 0.046, [[e, 1]]),
    R(0.016, -0.085, 0.006, 0.005, 0.04, [[e, 1]]),
    R(0.013, -0.115, 0.014, 0.004, 0.028, [[e, 1]]),
    R(0.01, -0.135, 0.021, 0.003, 0.012, [[e, 1]]),
  ];
}

// Texture atlas regions (uv space). The body spans the full width so U wraps seamlessly under the belly.
const ATLAS = {
  body: { u0: 0, u1: 1, v0: 0.52, v1: 1.0 },
  legFL: { u0: 0, u1: 0.25, v0: 0.22, v1: 0.49 }, legFR: { u0: 0.25, u1: 0.5, v0: 0.22, v1: 0.49 },
  legHL: { u0: 0.5, u1: 0.75, v0: 0.22, v1: 0.49 }, legHR: { u0: 0.75, u1: 1, v0: 0.22, v1: 0.49 },
  tail: { u0: 0, u1: 0.28, v0: 0.1, v1: 0.19 },
  earL: { u0: 0.3, u1: 0.44, v0: 0.04, v1: 0.19 }, earR: { u0: 0.46, u1: 0.6, v0: 0.04, v1: 0.19 },
  collar: { u0: 0.63, u1: 0.72, v0: 0.11, v1: 0.19 }, tongue: { u0: 0.75, u1: 0.84, v0: 0.11, v1: 0.19 }, black: { u0: 0.87, u1: 1, v0: 0.11, v1: 0.19 },
};

function buildDogGeometry(THREE, f) {
  const mb = new MeshBuilder(), seg = LOWQ ? 20 : 32, lseg = LOWQ ? 10 : 14, sub = LOWQ ? 2 : 3;
  const body = mb.tube(bodyRings(f), { ...ATLAS.body, id: 'body', seam: -Math.PI / 2, sub }, seg, BI);
  const legs = [
    mb.tube(frontLegRings(1, f), { ...ATLAS.legFL, id: 'legFL', seam: Math.PI, sub }, lseg, BI),
    mb.tube(frontLegRings(-1, f), { ...ATLAS.legFR, id: 'legFR', seam: 0, sub }, lseg, BI),
    mb.tube(hindLegRings(1, f), { ...ATLAS.legHL, id: 'legHL', seam: Math.PI, sub }, lseg, BI),
    mb.tube(hindLegRings(-1, f), { ...ATLAS.legHR, id: 'legHR', seam: 0, sub }, lseg, BI),
  ];
  const tail = mb.tube(tailRings(), { ...ATLAS.tail, id: 'tail', capStart: false, sub: 2 }, 8, BI);
  const ears = [
    mb.tube(earRings(1, f), { ...ATLAS.earL, id: 'earL', seam: Math.PI / 2, sub }, 10, BI),
    mb.tube(earRings(-1, f), { ...ATLAS.earR, id: 'earR', seam: Math.PI / 2, sub }, 10, BI),
  ];
  // collar: a flat ring around the neck, solid colour from the atlas
  {
    const rings = [], N = 16;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU, cx = Math.cos(a) * 0.068 * f.wide, sy = Math.sin(a);
      rings.push({ p: [cx, 0.572 + sy * 0.078 * 0.35 - 0.0, 0.355 - sy * 0.078 * 0.94], w: 0.006, ht: 0.011, hb: 0.011, b: [['neck', 1]] });
    }
    mb.tube(rings, { ...ATLAS.collar, id: 'collar', capStart: false, capEnd: false }, 6, BI);
  }
  const geo = mb.build(THREE);
  return { geo, body, legs, tail, ears };
}

// ================================================================ TEXTURES
function blobPath(g, cx, cy, p) {
  const n = p.length / 2;
  g.beginPath();
  g.moveTo(cx + (p[2 * n - 2] + p[0]) / 2, cy + (p[2 * n - 1] + p[1]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    g.quadraticCurveTo(cx + p[2 * i], cy + p[2 * i + 1], cx + (p[2 * i] + p[2 * j]) / 2, cy + (p[2 * i + 1] + p[2 * j + 1]) / 2);
  }
  g.closePath();
}
// Spots are placed in metres on the tube surface and projected into the atlas region, using each ring's
// circumference so a spot is round on the dog although the regions are far from square.
function spotRegion(g, W, H, rand, reg, o) {
  const x0 = reg.u0 * W, x1 = reg.u1 * W, y0 = (1 - reg.v1) * H, y1 = (1 - reg.v0) * H, rw = x1 - x0, rh = y1 - y0;
  const circAt = reg.circAt, spots = []; // metres around the tube at atlas v
  const n = Math.round(o.count * (1 + (rand() - 0.5) * 0.3));
  for (let tries = 0; spots.length < n && tries < n * 60; tries++) {
    const v = reg.v0 + (reg.v1 - reg.v0) * (o.vlo + (o.vhi - o.vlo) * rand());
    const sz = o.size ? o.size(v) : 1;
    const r = (o.rMin + (o.rMax - o.rMin) * Math.pow(rand(), 1.5)) * sz; // metres
    const circ = circAt(v), px = x0 + rw * rand(), py = (1 - v) * H;
    const rx = (r / circ) * rw, ry = (r / reg.len) * rh;
    let ok = true;
    for (const s of spots) {
      let dx = Math.abs(s.x - px); dx = Math.min(dx, rw - dx);
      const dy = Math.abs(s.y - py), m = (s.rx + rx) * o.gap, k = (s.ry + ry) * o.gap;
      if ((dx * dx) / (m * m) + (dy * dy) / (k * k) < 1) { ok = false; break; }
    }
    if (!ok) continue;
    const np = 8 + ((rand() * 4) | 0), pts = [], stretch = 0.85 + rand() * 0.3, rot = rand() * Math.PI;
    for (let i = 0; i < np; i++) {
      const a = (i / np) * TAU, rr = 0.8 + rand() * 0.35;
      const ex = Math.cos(a) * rr * stretch, ey = (Math.sin(a) * rr) / stretch;
      pts.push((ex * Math.cos(rot) - ey * Math.sin(rot)) * rx, (ex * Math.sin(rot) + ey * Math.cos(rot)) * ry);
    }
    spots.push({ x: px, y: py, rx, ry, pts });
  }
  g.save(); g.beginPath(); g.rect(x0, y0, rw, rh); g.clip();
  for (const s of spots) for (const ox of [-rw, 0, rw]) {
    if (s.x + ox + s.rx * 1.3 < x0 || s.x + ox - s.rx * 1.3 > x1) continue;
    blobPath(g, s.x + ox, s.y, s.pts); g.fill();
  }
  g.restore();
}
// the grain is painted once into a 256 px tile (same stroke density) and laid over the atlas as a pattern: ~1k strokes per
// boot instead of ~70k per dog. The dog's own random stream is still advanced as before, so its spots stay where they were.
let GRAIN = null;
function furGrain(g, W, H, rand) {
  if (!GRAIN) {
    const s = 256, c = makeCanvas(s, s), q = c.getContext('2d'), r = mulberry32(4242), n = Math.round((s * s) / 60);
    q.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const x = r() * s, y = r() * s, l = 1 + r() * 3;
      q.strokeStyle = r() < 0.5 ? 'rgba(150,140,125,0.09)' : 'rgba(255,255,255,0.35)';
      q.beginPath(); q.moveTo(x, y); q.lineTo(x + (r() - 0.5) * 1.5, y + l); q.stroke();
    }
    GRAIN = c;
  }
  g.fillStyle = g.createPattern(GRAIN, 'repeat'); g.fillRect(0, 0, W, H);
  for (let i = 5 * Math.round((W * H) / 60); i > 0; i--) rand();
}
function fillRegion(g, W, H, reg, color) { g.fillStyle = color; g.fillRect(reg.u0 * W, (1 - reg.v1) * H, (reg.u1 - reg.u0) * W, (reg.v1 - reg.v0) * H); }

// Paint the atlas for one dog: coat, spots per region, black nose, eye sockets and rims, lip line, pink skin hints, collar /
// tongue patches. Spots are warm near-black (the photos: dense, crisp, 2-5 cm on the trunk, small on head and legs).
const SPOT = '#1a1513';
function coatTexture(THREE, parts, spec) {
  const W = LOWQ ? 1024 : 2048, H = W, rand = mulberry32(spec.seed);
  const c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#f5f3ef'; g.fillRect(0, 0, W, H);
  furGrain(g, W, H, rand);
  const body = parts.body, sub = body.sub, kv = (i, t = 0) => lerp(body.vs[i * sub], body.vs[Math.min(i + 1, 18) * sub], t); // v at key ring i
  const vTrunk0 = kv(1), vTrunk1 = kv(8), vNeck = kv(8), vHead = kv(12), vEye = kv(14, 0.6), vNose = kv(17, 0.4);
  const uvAt = (v, th) => [((th - body.seam) / TAU) * W, (1 - v) * H];
  const pxU = (v) => W / body.circAt(v), pxV = H * (body.v1 - body.v0) / body.len; // pixels per metre around / along the body
  // pink skin: belly (the seam runs under the belly) and the groin, under the spots
  {
    const y0 = (1 - vTrunk1) * H, y1 = (1 - vTrunk0) * H, bw = W * 0.055;
    for (const x of [0, W]) { const lg = g.createLinearGradient(x - bw, 0, x + bw, 0); lg.addColorStop(0, 'rgba(236,196,190,0)'); lg.addColorStop(0.5, 'rgba(236,196,190,0.5)'); lg.addColorStop(1, 'rgba(236,196,190,0)'); g.fillStyle = lg; g.fillRect(x - bw, y0, 2 * bw, y1 - y0); }
  }
  for (const [k, e] of [[0, parts.ears[0]], [1, parts.ears[1]]]) { // inner ear face (toward the head: u .25 left ear, u 0/1 right) blushes pink
    const x0 = e.u0 * W, rw = (e.u1 - e.u0) * W, y = (1 - e.v1) * H, h = (e.v1 - e.v0) * H;
    for (const cx of k === 0 ? [x0 + rw * 0.25] : [x0, x0 + rw]) {
      const lg = g.createLinearGradient(cx - rw * 0.2, 0, cx + rw * 0.2, 0);
      lg.addColorStop(0, 'rgba(232,178,172,0)'); lg.addColorStop(0.5, 'rgba(232,178,172,0.55)'); lg.addColorStop(1, 'rgba(232,178,172,0)');
      g.save(); g.beginPath(); g.rect(x0, y, rw, h); g.clip(); g.fillStyle = lg; g.fillRect(cx - rw * 0.2, y, rw * 0.4, h); g.restore();
    }
  }
  g.fillStyle = SPOT;
  const bodySize = (v) => (v < vNeck ? 1 : v < vHead ? 0.75 : 0.48);
  if ('filter' in g) g.filter = `blur(${W / 1600}px)`;
  // body: round spots on the trunk, smaller and denser on neck and head; some merge into patches like real coats
  spotRegion(g, W, H, rand, body, { count: spec.bodySpots, rMin: 0.011, rMax: 0.024, gap: 1.12, vlo: 0.0, vhi: 0.96, size: bodySize });
  spotRegion(g, W, H, rand, body, { count: Math.round(spec.bodySpots * 0.5), rMin: 0.006, rMax: 0.013, gap: 1.1, vlo: 0.55, vhi: 0.97, size: bodySize });
  for (const l of parts.legs) spotRegion(g, W, H, rand, l, { count: 16, rMin: 0.005, rMax: 0.013, gap: 1.2, vlo: 0.0, vhi: 0.97 });
  spotRegion(g, W, H, rand, parts.tail, { count: 9, rMin: 0.005, rMax: 0.011, gap: 1.15, vlo: 0.0, vhi: 0.95 });
  spotRegion(g, W, H, rand, parts.ears[0], { count: spec.earSpots[0], rMin: 0.009, rMax: 0.02, gap: spec.earGap[0], vlo: 0, vhi: 1 });
  spotRegion(g, W, H, rand, parts.ears[1], { count: spec.earSpots[1], rMin: 0.009, rMax: 0.02, gap: spec.earGap[1], vlo: 0, vhi: 1 });
  // eye patch: a ragged black patch over one eye (Logan, like the photo)
  for (let s = 0; s < 2; s++) if (spec.eyePatch && spec.eyePatch[s]) {
    const [ex, ey] = uvAt(vEye, s === 0 ? 0.12 : Math.PI - 0.12), np = 10, pts = [];
    for (let i = 0; i < np; i++) { const a = (i / np) * TAU, rr = (0.028 + rand() * 0.012) * spec.eyePatch[s]; pts.push(Math.cos(a) * rr * pxU(vEye), Math.sin(a) * rr * pxV); }
    blobPath(g, ex, ey, pts); g.fill();
  }
  if ('filter' in g) g.filter = 'none';
  // nose leather: the last ~1.5 cm of the muzzle, all round
  g.fillStyle = '#121113';
  g.fillRect(0, 0, W, (1 - (vNose - 0.004)) * H);
  // eyes: a soft socket shadow, a dark almond lid rim (the eyeball sits inside it) and a thin brow crease
  for (const s of [1, -1]) {
    const [ex, ey] = uvAt(vEye, s > 0 ? 0.12 : Math.PI - 0.12), ru = pxU(vEye), rot = s * 0.35;
    const rg = g.createRadialGradient(ex, ey, 0, ex, ey, 0.022 * ru);
    rg.addColorStop(0, 'rgba(60,48,44,0.55)'); rg.addColorStop(1, 'rgba(60,48,44,0)');
    g.fillStyle = rg; g.beginPath(); g.ellipse(ex, ey, 0.022 * ru, 0.016 * pxV, rot, 0, TAU); g.fill();
    g.fillStyle = '#14100f'; g.beginPath(); g.ellipse(ex, ey, 0.0125 * ru, 0.0085 * pxV, rot, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(40,32,30,0.45)'; g.lineWidth = Math.max(1, W / 1100); g.beginPath(); g.ellipse(ex, ey - 0.012 * pxV, 0.014 * ru, 0.005 * pxV, rot, Math.PI, TAU); g.stroke();
  }
  { // lip line along the lower muzzle (u = 0 is the belly seam, so the chin sits at u = 0 / 1)
    const [x0, y0] = uvAt(kv(15, 0.1), -Math.PI / 2 + 0.55), [x1, y1] = uvAt(kv(17, 0.3), -Math.PI / 2 + 0.2);
    g.strokeStyle = 'rgba(30,26,28,0.7)'; g.lineWidth = Math.max(1, W / 900); g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const [x2, y2] = uvAt(kv(15, 0.1), -Math.PI / 2 - 0.55), [x3, y3] = uvAt(kv(17, 0.3), -Math.PI / 2 - 0.2);
    g.beginPath(); g.moveTo(x2 + W, y2); g.lineTo(x3 + W, y3); g.stroke(); // wraps past u=1
  }
  // paw pads: dark undersides of the four paws (the leg seam faces outward, u = 0.5 of a leg region is the inner side; the sole is the end cap area)
  for (const l of parts.legs) { const x0 = l.u0 * W, rw = (l.u1 - l.u0) * W, y = (1 - l.v1) * H; g.fillStyle = 'rgba(40,34,32,0.8)'; g.fillRect(x0, y, rw, 0.004 * pxV); }
  fillRegion(g, W, H, ATLAS.collar, spec.collar);
  fillRegion(g, W, H, ATLAS.tongue, '#d9707f');
  fillRegion(g, W, H, ATLAS.black, '#121113');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = LOWQ ? 2 : 8;
  return tex;
}
function furBump(THREE) {
  const s = 256, c = makeCanvas(s, s), g = c.getContext('2d'), rand = mulberry32(99);
  g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 9000; i++) {
    const x = rand() * s, y = rand() * s, l = 2 + rand() * 4;
    g.strokeStyle = rand() < 0.5 ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 2, y + l); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6);
  return t;
}
// roughness variation: short coat is glossier along the back, duller on the belly and legs (greyscale, tiled)
function furRough(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d'), rand = mulberry32(5);
  g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 2500; i++) { const v = 150 + ((rand() * 70) | 0); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(rand() * s, rand() * s, 1 + rand() * 3, 1); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 5);
  return t;
}
// Eye sphere texture: a dark brown eyeball with a warmer iris ring and a large pupil (dogs show almost no white).
function eyeTexture(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#17100d'; g.fillRect(0, 0, s, s);
  for (const cx of [0.25, 0.75]) { // the left eye looks along +u, the right along -u
    const rg = g.createRadialGradient(s * cx, s * 0.5, s * 0.05, s * cx, s * 0.5, s * 0.17);
    rg.addColorStop(0, '#080504'); rg.addColorStop(0.45, '#0c0806'); rg.addColorStop(0.6, '#4a2d18'); rg.addColorStop(0.9, '#3a2213'); rg.addColorStop(1, '#17100d');
    g.fillStyle = rg; g.beginPath(); g.ellipse(s * cx, s * 0.5, s * 0.14, s * 0.2, 0, 0, TAU); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function shadowTexture(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d');
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, 'rgba(0,0,0,0.75)'); rg.addColorStop(0.45, 'rgba(0,0,0,0.45)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
function fabricTexture(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d'), rand = mulberry32(77);
  g.fillStyle = '#d6d6d6'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 2) { g.fillStyle = y % 4 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.18)'; g.fillRect(0, y, s, 1); }
  for (let x = 0; x < s; x += 2) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(x, 0, 1, s); }
  for (let i = 0; i < 1400; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.14)'; g.fillRect(rand() * s, rand() * s, 1 + rand() * 2.5, 1); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ================================================================ DOG ASSEMBLY
function buildDog(THREE, spec, shared) {
  const f = { wide: spec.wide };
  const parts = buildDogGeometry(THREE, f);
  const coat = coatTexture(THREE, parts, spec);
  const mat = new THREE.MeshPhysicalMaterial({
    map: coat, roughness: 0.74, metalness: 0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xfff3e6),
    bumpMap: shared.bump, bumpScale: 0.0007, roughnessMap: shared.rough,
    side: THREE.DoubleSide, // a deep bend can turn a few faces; never show the inside through them
  });
  const bones = [], byName = {};
  for (const [name, parent, x, y, z] of BONES) {
    const b = new THREE.Bone(); b.name = name;
    if (parent) { const p = byName[parent]; b.position.set(x - p.userData.wx, y - p.userData.wy, z - p.userData.wz); p.add(b); }
    else b.position.set(x, y, z);
    b.userData.wx = x; b.userData.wy = y; b.userData.wz = z;
    bones.push(b); byName[name] = b;
  }
  const mesh = new THREE.SkinnedMesh(parts.geo, mat);
  mesh.add(bones[0]);
  bones[0].updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false; // the group handles LOD / culling; skinned bounds would lag behind the pose
  mesh.name = spec.name + '-body';

  // eyes + nose: tiny meshes on the head bone (3 draw calls, one shared material). The eyeballs sit mostly inside the
  // painted sockets at the stop, each looking ~30 degrees outward like a dog's.
  const head = byName.head, eyes = [];
  for (const s of [1, -1]) {
    const e = new THREE.Mesh(shared.eyeGeo, shared.eyeMat);
    e.position.set(s * 0.0455 * spec.wide, 0.681 - 0.665, 0.536 - 0.43);
    e.rotation.order = 'YXZ'; e.rotation.y = s * 0.55 + (s > 0 ? 0 : Math.PI);
    e.scale.setScalar(0.0092); e.name = 'eye';
    head.add(e); eyes.push(e);
  }
  const nose = new THREE.Mesh(shared.noseGeo, shared.noseMat);
  nose.position.set(0, 0.651 - 0.665, 0.672 - 0.43); nose.scale.set(0.021, 0.017, 0.016); nose.name = 'nose';
  head.add(nose);

  const root = new THREE.Group(); root.name = spec.name; root.scale.setScalar(spec.scale);
  root.add(mesh);
  const shadow = new THREE.Mesh(shared.shadowGeo, shared.shadowMat);
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.006; shadow.scale.set(0.95, 0.5, 1); shadow.renderOrder = 2; shadow.name = 'contact-shadow';
  root.add(shadow);
  return { root, mesh, bones, byName, eyes, nose, shadow, mat, coat, parts };
}

function buildBed(THREE, mats, geos, x, z, y) {
  const grp = new THREE.Group(); grp.name = 'dalmatian-dog-bed';
  // sized for a curled-up dalmatian (~0.8 m across inside); the dogs read its height from the drawn mesh
  const rim = [[0.50, 0.0], [0.535, 0.03], [0.55, 0.09], [0.54, 0.14], [0.51, 0.17], [0.47, 0.18], [0.44, 0.165], [0.425, 0.13], [0.415, 0.09], [0.41, 0.05]];
  const cushion = [[0.42, 0.02], [0.43, 0.05], [0.42, 0.08], [0.36, 0.095], [0.2, 0.1], [0.0, 0.1]];
  const v2 = (p) => new THREE.Vector2(p[0], p[1]);
  const rimGeo = new THREE.LatheGeometry(rim.map(v2), 36), cushGeo = new THREE.LatheGeometry(cushion.map(v2), 36);
  geos.push(rimGeo, cushGeo);
  for (const [geo, mat] of [[rimGeo, mats.rim], [cushGeo, mats.cushion]]) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; grp.add(m); }
  grp.position.set(x, y, z);
  return grp;
}
function buildBowls(THREE, mats, geos, x, z, y) {
  const grp = new THREE.Group(); grp.name = 'dog-bowls';
  const bowl = new THREE.LatheGeometry([[0.0, 0.0], [0.07, 0.0], [0.085, 0.02], [0.09, 0.06], [0.082, 0.065], [0.075, 0.062], [0.065, 0.025], [0.0, 0.022]].map((p) => new THREE.Vector2(p[0], p[1])), 20);
  const mat2 = new THREE.CylinderGeometry(0.17, 0.17, 0.008, 24);
  geos.push(bowl, mat2);
  const m = new THREE.Mesh(mat2, mats.mat); m.position.y = 0.004; m.receiveShadow = true; grp.add(m);
  for (const [dx, k] of [[-0.085, 'steel'], [0.085, 'steel']]) { const b = new THREE.Mesh(bowl, mats[k]); b.position.set(dx, 0.008, 0); b.castShadow = true; grp.add(b); }
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.062, 20), mats.water); geos.push(water.geometry);
  water.rotation.x = -Math.PI / 2; water.position.set(-0.085, 0.052, 0); grp.add(water);
  const kibble = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), mats.kibble); geos.push(kibble.geometry);
  kibble.rotation.x = -Math.PI / 2; kibble.position.set(0.085, 0.048, 0); grp.add(kibble);
  grp.position.set(x, y, z);
  return grp;
}


// ================================================================ WORLD + NAVIGATION (ground floor)
// The dogs see the house as it is drawn. Every visible mesh of the ground floor (walls, kitchen, furniture, the office corner,
// the mand and the bowls; not the dogs, door leaves or helpers) is rasterised into a 5 cm height grid: per cell the lowest and
// highest triangle between 3 and 95 cm. Moved, hidden, added or restyled furniture changes the grid on the next frame (the
// level's top-level groups are watched), so nothing is kept by hand. On top of the grid: HOUSE.colliders[0] (walls and the
// office blocks), the door jambs, shut doors and every hinged leaf at its live angle (leaf geometry mirrors buildDoor: hinge
// 5.3 cm in from the opening's low end at the wall centre, length = opening - 10.6 cm, 4.2 cm thick).
// Navigation: a distance field over the solid cells gives clearance; points of interest, door passages (gap centre + an
// approach node either side) and the rest spots form a small waypoint graph; a door is only routed through when it is open.
const GC = 0.05, GX0 = -0.5, GZ0 = -0.5, GNX = 210, GNZ = 270, GN = GNX * GNZ;
const G_Y0 = 0.03, G_Y1 = 0.95, G_LOW = 0.04, G_TOP = 0.85; // band that is rasterised; a cell under 4 cm is floor (rugs, sills)
const DOG_R = 0.17, DOOR_PASS = 1.2, DOOR_OPEN_ANG = 1.45, LEAF_T = 0.021;
const gCell = (x, z) => { const i = Math.floor((x - GX0) / GC), j = Math.floor((z - GZ0) / GC); return i < 0 || j < 0 || i >= GNX || j >= GNZ ? -1 : j * GNX + i; };
const doorShut = (d) => (d.slide ? d.angle < DOOR_OPEN_ANG * 0.8 : d.angle < 0.3);
const poseDoorLeaf = (d) => { if (!d.pivot) return; if (d.slide) d.pivot.position.x = -d.slide * d.angle / DOOR_OPEN_ANG; else d.pivot.rotation.y = d.base + d.dir * d.angle; };
// the woonkamer mand (built here); the host adds more beds with dogs.addBed() (the bean bag in the office corner)
const MAND = { id: 'mand', x: 3.85, z: 7.0, r: 0.55, heading: -Math.PI / 2 - 0.4, room: 'woonkamer' };
// points of interest: [id, x, z, facing heading, room, kind]; each snaps to the nearest free floor within 60 cm
const POIS = [
  ['window', 5.2, 11.7, 0, 'woonkamer', 'look'],
  ['rug', 4.6, 9.0, Math.PI / 2, 'woonkamer', 'spot'],
  ['dining', 5.15, 3.0, Math.PI, 'woonkamer', 'sniff'],
  ['bookshelf', 4.1, 5.4, -Math.PI / 2, 'woonkamer', 'sniff'],
  ['reading', 7.8, 6.3, 0.6, 'woonkamer', 'spot'],
  ['mid', 5.6, 6.2, 0, 'woonkamer', 'spot'],
  ['bowls', 8.05, 0.85, Math.PI, 'keuken', 'bowls'],
  ['kitchen', 7.3, 2.3, 0.5, 'keuken', 'sniff'],
  ['frontdoor', 7.6, 11.5, 0, 'entree', 'look'],
  ['stairs', 7.65, 10.7, Math.PI / 2, 'entree', 'spot'],
  ['zitkamer', 2.3, 3.2, Math.PI, 'zitkamer', 'sniff'],
  ['zitrug', 2.05, 5.45, Math.PI, 'zitkamer', 'spot'],
  // corridor points (not destinations); door passages are generated from HOUSE.doors
  ['w-mid2', 6.3, 4.6, 0, null, 'via'], ['w-entree', 7.65, 9.0, 0, null, 'via'], ['w-zit', 2.6, 2.6, 0, null, 'via'],
  ['w-sofa', 5.85, 10.6, 0, null, 'via'], ['w-win', 5.0, 9.9, 0, null, 'via'],
];
// leaf geometry of a host door; posts = the two jambs, openRect = the fully open leaf as a box
function doorGeom(d) {
  const c = d.col, ax = c[1] - c[0] > c[3] - c[2] ? 'x' : 'z', a = ax === 'x' ? c[0] : c[2], b = ax === 'x' ? c[1] : c[3];
  const c0 = (ax === 'x' ? c[2] : c[0]) + 0.03, c1 = (ax === 'x' ? c[3] : c[1]) - 0.03, cm = (c0 + c1) / 2, W = b - a - 0.106;
  const hx = ax === 'x' ? a + 0.053 : cm, hz = ax === 'x' ? cm : a + 0.053;
  const posts = ax === 'x' ? [[a, a + 0.05, c0 - 0.01, c1 + 0.01], [b - 0.05, b, c0 - 0.01, c1 + 0.01]] : [[c0 - 0.01, c1 + 0.01, a, a + 0.05], [c0 - 0.01, c1 + 0.01, b - 0.05, b]];
  const th = d.base + d.dir * DOOR_OPEN_ANG, ex = hx + Math.cos(th) * W, ez = hz - Math.sin(th) * W;
  const openRect = [Math.min(hx, ex) - 0.03, Math.max(hx, ex) + 0.03, Math.min(hz, ez) - 0.03, Math.max(hz, ez) + 0.03];
  const mid = ax === 'x' ? [(a + b) / 2, cm] : [cm, (a + b) / 2], nrm = ax === 'x' ? [0, 1] : [1, 0];
  return { d, ax, hx, hz, W, posts, openRect: d.slide ? null : openRect, mid, nrm, col: c };
}
// distance from (x,z) to a leaf's centre line at its live angle, and the push direction out of it
function leafDist(x, z, g, out) {
  const th = g.d.base + g.d.dir * g.d.angle, dx = Math.cos(th), dz = -Math.sin(th), ex = x - g.hx, ez = z - g.hz;
  const t = clamp(ex * dx + ez * dz, 0, g.W), px = ex - dx * t, pz = ez - dz * t, l = Math.hypot(px, pz);
  if (out) { if (l > 1e-6) { out[0] = px / l; out[1] = pz / l; } else { out[0] = -dz; out[1] = dx; } }
  return l;
}
// does the segment cross the open rectangle c shrunk by e? (Liang-Barsky)
function segRect(x0, z0, x1, z1, c, e) {
  let t0 = 0, t1 = 1; const dx = x1 - x0, dz = z1 - z0;
  const edge = (p, q) => { if (Math.abs(p) < 1e-12) return q > 0; const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } return true; };
  return edge(-dx, x0 - c[0] - e) && edge(dx, c[1] - e - x0) && edge(-dz, z0 - c[2] - e) && edge(dz, c[3] - e - z0) && t0 < t1;
}

function makeWorld(THREE, home, H) {
  const lo = new Float32Array(GN).fill(9), hi = new Float32Array(GN).fill(-9);
  const slo = new Float32Array(GN).fill(9), shi = new Float32Array(GN).fill(-9), touched = [];
  const parts = new Map(), pivots = new Set(), box = new THREE.Box3();
  let root = null, deepT = 0, buf = new Float32Array(3 * 4096);
  const skip = (o) => { const u = o.userData; return !!(u && (u.dalmatian || u.door || u.helper)) || pivots.has(o) || o.isSkinnedMesh || o.isInstancedMesh || (typeof o.name === 'string' && o.name.startsWith('carry:')); };
  function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    let y0 = Math.min(ay, by, cy), y1 = Math.max(ay, by, cy);
    if (y1 < G_Y0 || y0 > G_Y1) return;
    y0 = Math.max(y0, G_Y0); y1 = Math.min(y1, G_Y1);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - GX0) / GC)), i1 = Math.min(GNX - 1, Math.floor((Math.max(ax, bx, cx) - GX0) / GC));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - GZ0) / GC)), j1 = Math.min(GNZ - 1, Math.floor((Math.max(az, bz, cz) - GZ0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * GNX + i;
      if (shi[k] < -1) touched.push(k);
      if (y0 < slo[k]) slo[k] = y0;
      if (y1 > shi[k]) shi[k] = y1;
    }
  }
  function mesh(o) {
    const g = o.geometry, pa = g && g.attributes && g.attributes.position; if (!pa) return;
    const m = o.material; if (Array.isArray(m) ? !m.some((q) => q.visible) : m && m.visible === false) return;
    if (!g.boundingBox) g.computeBoundingBox();
    box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    if (box.max.y < G_Y0 || box.min.y > G_Y1 || box.max.x < GX0 || box.max.z < GZ0 || box.min.x > GX0 + GNX * GC || box.min.z > GZ0 + GNZ * GC) return;
    const n = pa.count; if (buf.length < 3 * n) buf = new Float32Array(3 * n);
    const e = o.matrixWorld.elements, P = buf;
    for (let i = 0; i < n; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      P[3 * i] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[3 * i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[3 * i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const ix = g.index ? g.index.array : null, cnt = ix ? g.index.count : n, s0 = g.drawRange.start, s1 = Math.min(cnt, s0 + g.drawRange.count);
    for (let t = s0; t + 2 < s1; t += 3) {
      const a = 3 * (ix ? ix[t] : t), b = 3 * (ix ? ix[t + 1] : t + 1), c = 3 * (ix ? ix[t + 2] : t + 2);
      tri(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
    }
  }
  // signature of what a top-level group shows: its visible meshes and their geometries (a model that finished loading,
  // a restyled piece and a hidden item all change it)
  function sig(top) {
    let s = 0;
    const go = (o, isTop) => { if (skip(o) || (!isTop && !o.visible)) return; if (o.isMesh) s = (s * 31 + o.geometry.id + 1) | 0; for (const c of o.children) go(c, false); };
    go(top, true);
    return s;
  }
  // rasterising runs as a queue of groups with a time budget per frame (a few ms), so loading and a pick-up never stall
  const queue = [], mark = new Uint8Array(GN), dirty = [];
  let job = null, first = true;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function startJob(top) {
    touched.length = 0; top.updateWorldMatrix(true, true);
    const list = [], go = (o, isTop) => { if (skip(o) || (!isTop && !o.visible)) return; if (o.isMesh) list.push(o); for (const c of o.children) go(c, false); };
    go(top, true);
    job = { top, list, i: 0, vis: top.visible, sig: sig(top) };
  }
  const markPart = (p) => { if (p) for (let q = 0; q < p.idx.length; q++) { const k = p.idx[q]; if (!mark[k]) { mark[k] = 1; dirty.push(k); } } };
  function finishJob() {
    const n = touched.length, idx = new Int32Array(n), l = new Float32Array(n), h = new Float32Array(n);
    for (let q = 0; q < n; q++) { const k = touched[q]; idx[q] = k; l[q] = slo[k]; h[q] = shi[k]; slo[k] = 9; shi[k] = -9; }
    const p = { idx, lo: l, hi: h, vis: job.vis, sig: job.sig };
    markPart(parts.get(job.top)); markPart(p); parts.set(job.top, p); job = null;
  }
  // only the cells of groups that changed are recombined
  function combine() {
    for (const k of dirty) { lo[k] = 9; hi[k] = -9; }
    for (const p of parts.values()) if (p.vis) for (let q = 0; q < p.idx.length; q++) { const k = p.idx[q]; if (!mark[k]) continue; if (p.lo[q] < lo[k]) lo[k] = p.lo[q]; if (p.hi[q] > hi[k]) hi[k] = p.hi[q]; }
    for (const k of dirty) mark[k] = 0;
    dirty.length = 0;
  }
  const enqueue = (c) => { if (!queue.includes(c) && (!job || job.top !== c)) queue.push(c); };
  // per frame: new / removed / shown / hidden top-level groups; every 30 frames (or deep) also what they contain.
  // budget: ms of rasterising this frame (Infinity = finish now). Returns true when the grid changed.
  function sync(deep, budget = 3) {
    if (!root) { root = home.parent; if (!root) return false; deep = true; }
    pivots.clear(); if (H && H.doors) for (const d of H.doors) if (d.pivot) pivots.add(d.pivot);
    if (++deepT >= 30) { deepT = 0; deep = true; }
    let changed = false; const seen = new Set();
    for (const c of root.children) {
      seen.add(c);
      if (skip(c)) continue;
      const p = parts.get(c);
      if (!p || (c.visible && !p.vis) || (deep && c.visible && sig(c) !== p.sig)) enqueue(c);
      else if (p.vis && !c.visible) { p.vis = false; markPart(p); changed = true; }
    }
    for (const c of [...parts.keys()]) if (!seen.has(c)) { markPart(parts.get(c)); parts.delete(c); changed = true; }
    const t0 = now();
    while (job || queue.length) {
      if (!job) { const c = queue.shift(); if (c.parent !== root) continue; startJob(c); }
      while (job.i < job.list.length && now() - t0 < budget) mesh(job.list[job.i++]);
      if (job.i < job.list.length) break;
      finishJob(); changed = true;
    }
    if (!job && !queue.length) first = false;
    if (changed && !first) combine();
    return changed && !first;
  }
  return { lo, hi, sync, ready: () => !!root && !first, parts, busy: () => !!job || queue.length > 0 };
}

function makeNav(H, W) {
  const walls = (H && H.colliders && H.colliders[0]) || []; // live list: the kitchen toggle and office.js splice it in place
  const roomOf = (x, z) => (H && H.roomAt ? H.roomAt(0, x, z) : 'woonkamer');
  const doors = [], posts = [], doorCols = [];
  function readDoors() {
    doors.length = posts.length = doorCols.length = 0;
    for (const d of H && H.doors ? H.doors.filter((d) => d.l === 0 && d.col) : []) doors.push(doorGeom(d));
    for (const g of doors) { posts.push(...g.posts); doorCols.push(g.col); }
  }
  // clearance: distance to the nearest solid cell (grid, walls, jambs, open leaves), two-pass chamfer
  const clear = new Float32Array(GN), occ = new Uint8Array(GN);
  const fill = (c) => {
    const i0 = Math.max(0, Math.floor((c[0] - GX0) / GC)), i1 = Math.min(GNX - 1, Math.floor((c[1] - GX0) / GC)), j0 = Math.max(0, Math.floor((c[2] - GZ0) / GC)), j1 = Math.min(GNZ - 1, Math.floor((c[3] - GZ0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) occ[j * GNX + i] = 1;
  };
  function buildClearance() {
    for (let k = 0; k < GN; k++) occ[k] = W.hi[k] > G_LOW && W.lo[k] < G_TOP ? 1 : 0;
    for (const c of walls) fill(c);
    for (const g of doors) { for (const p of g.posts) fill(p); if (g.openRect) fill(g.openRect); }
    const D = clear, S2 = Math.SQRT2;
    for (let k = 0; k < GN; k++) D[k] = occ[k] ? 0 : 1e6;
    for (let j = 0; j < GNZ; j++) for (let i = 0; i < GNX; i++) {
      const k = j * GNX + i; let v = D[k]; if (!v) continue;
      if (i > 0) v = Math.min(v, D[k - 1] + 1);
      if (j > 0) { v = Math.min(v, D[k - GNX] + 1); if (i > 0) v = Math.min(v, D[k - GNX - 1] + S2); if (i < GNX - 1) v = Math.min(v, D[k - GNX + 1] + S2); }
      D[k] = v;
    }
    for (let j = GNZ - 1; j >= 0; j--) for (let i = GNX - 1; i >= 0; i--) {
      const k = j * GNX + i; let v = D[k]; if (!v) continue;
      if (i < GNX - 1) v = Math.min(v, D[k + 1] + 1);
      if (j < GNZ - 1) { v = Math.min(v, D[k + GNX] + 1); if (i < GNX - 1) v = Math.min(v, D[k + GNX + 1] + S2); if (i > 0) v = Math.min(v, D[k + GNX - 1] + S2); }
      D[k] = v;
    }
    for (let k = 0; k < GN; k++) D[k] = D[k] * GC - GC / 2;
  }
  const clearAt = (x, z) => { const k = gCell(x, z); return k < 0 ? 0 : clear[k]; };
  const hits = (x, z, r, rects) => { for (let i = 0; i < rects.length; i++) { const c = rects[i]; if (x > c[0] - r && x < c[1] + r && z > c[2] - r && z < c[3] + r) return true; } return false; };
  const blocked = (x, z, r) => clearAt(x, z) < r;
  const blockedRoute = (x, z, r) => blocked(x, z, r) || hits(x, z, r, doorCols); // generic edges never cross a doorway
  const segFree = (x0, z0, x1, z1, r, fn) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.08));
    for (let i = 0; i <= n; i++) if (fn(lerp(x0, x1, i / n), lerp(z0, z1, i / n), r)) return false;
    return true;
  };
  const segmentFree = (x0, z0, x1, z1, r) => segFree(x0, z0, x1, z1, r, blockedRoute);

  const nodes = POIS.map((p, i) => ({ i, id: p[0], ox: p[1], oz: p[2], x: p[1], z: p[2], h: p[3], room: p[4], kind: p[5], door: null, spot: null, off: false, edges: [] }));
  // a dead slot (removed bed, door of the other kitchen) is reused, so node indexes stay valid and the graph stays small
  const addNode = (n) => { const k = nodes.findIndex((m) => m.kind === 'dead'); n.i = k >= 0 ? k : nodes.length; n.edges = []; n.off = !!n.off; nodes[n.i] = n; return n; };
  const kill = (n) => { n.kind = 'dead'; n.door = null; n.spot = null; n.off = true; n.edges.length = 0; };
  const usable = (n) => n.kind !== 'walker' && n.kind !== 'dead' && !n.off;
  // points of interest stay where they are unless furniture stands there: then the nearest free floor in the same room
  function snapPOIs() {
    for (const n of nodes) {
      if (n.ox === undefined) continue;
      const room = n.room || roomOf(n.ox, n.oz);
      n.x = n.ox; n.z = n.oz; n.off = false;
      if (clearAt(n.ox, n.oz) >= 0.22) continue;
      let bd = 1e9;
      for (let dz = -0.6; dz <= 0.6; dz += GC) for (let dx = -0.6; dx <= 0.6; dx += GC) {
        const d2 = dx * dx + dz * dz; if (d2 > 0.36 || d2 >= bd) continue;
        if (clearAt(n.ox + dx, n.oz + dz) >= 0.22 && roomOf(n.ox + dx, n.oz + dz) === room) { bd = d2; n.x = n.ox + dx; n.z = n.oz + dz; }
      }
      n.off = bd >= 1e9;
    }
  }
  // door passages: a node in the gap centre, one approach node ~0.75 m into each room, linked only to the gap node
  function doorNodes() {
    for (const n of nodes) if (n.kind === 'door' || (n.kind === 'via' && n.id.startsWith('a-'))) kill(n);
    for (const g of doors) {
      const [mx, mz] = g.mid, [nx, nz] = g.nrm, side = [];
      for (const s of [1, -1]) for (const r of [0.75, 0.6, 0.9, 1.1]) { const x = mx + nx * r * s, z = mz + nz * r * s; if (!blocked(x, z, DOG_R) && roomOf(x, z)) { side.push([x, z, s]); break; } }
      g.node = null;
      if (side.length < 2) continue; // one side is outside or furnished shut: no passage
      const inner = side.map(([x, z, s]) => addNode({ id: 'a-' + g.hx.toFixed(1) + '/' + g.hz.toFixed(1) + (s > 0 ? '+' : '-'), x, z, h: 0, room: null, kind: 'via', door: null, spot: null }));
      g.node = addNode({ id: 'd-' + g.hx.toFixed(1) + '/' + g.hz.toFixed(1), x: mx, z: mz, h: 0, room: null, kind: 'door', door: g.d, geom: g, spot: null, near: inner.map((n) => n.i) });
    }
  }
  function edges() {
    for (const n of nodes) n.edges.length = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (!usable(a) || !usable(b) || a.kind === 'door' || b.kind === 'door') continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 4.5 && segmentFree(a.x, a.z, b.x, b.z, DOG_R - 0.02)) { a.edges.push(j); b.edges.push(i); }
    }
    for (const n of nodes) if (n.kind === 'door') for (const j of n.near) { n.edges.push(j); nodes[j].edges.push(n.i); }
  }
  // can a dog standing at (x, z) walk onto the graph?
  const reachable = (x, z) => nodes.some((n) => usable(n) && n.kind !== 'door' && !n.spot && Math.hypot(n.x - x, n.z - z) < 4 && segmentFree(x, z, n.x, n.z, DOG_R - 0.02));
  const beds = [], sofas = [];
  // a doorway can be walked through when the leaf is open wide and not on its way shut
  const passable = (door) => !door || (door.open !== false && door.angle >= DOOR_PASS);
  const doorOpen = (n) => !n.door || passable(n.door);
  // Dijkstra over the small graph. ignoreDoors routes through shut doors too (the dog then waits at the first one).
  let dist = new Float32Array(64), prev = new Int16Array(64), done = new Uint8Array(64);
  function route(from, to, out, ignoreDoors) { // out: Int16Array, returns length (path from -> ... -> to), 0 when unreachable
    const N = nodes.length;
    if (dist.length < N) { dist = new Float32Array(N + 16); prev = new Int16Array(N + 16); done = new Uint8Array(N + 16); }
    dist.fill(1e9); prev.fill(-1); done.fill(0); dist[from] = 0;
    for (;;) {
      let u = -1, best = 1e9;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === to) break;
      done[u] = 1;
      const e = nodes[u].edges;
      for (let k = 0; k < e.length; k++) {
        const v = e[k]; if (done[v] || (!ignoreDoors && !doorOpen(nodes[v]))) continue;
        const nd = best + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].z - nodes[v].z) + (nodes[v].kind === 'door' && !doorOpen(nodes[v]) ? 3 : 0);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
      }
    }
    if (dist[to] >= 1e9) return 0;
    let n = 0, c = to;
    while (c >= 0 && n < out.length) { out[n++] = c; c = prev[c]; }
    for (let i = 0, j = n - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
    return n;
  }
  // nearest node reachable in a straight line (a dog standing in a doorway may cross it; a wedged dog takes the nearest)
  function nearestNode(x, z, r) {
    for (const [fn, rr] of [[blockedRoute, r], [blocked, r], [blocked, 0.06], [() => false, 0]]) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]; if (!usable(n) || (n.kind === 'door' && fn === blockedRoute)) continue;
        const d = Math.hypot(n.x - x, n.z - z); if (d < bd && segFree(x, z, n.x, n.z, rr, fn)) { bd = d; best = i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  // the furniture as the dogs see it: row runs of solid cells, [x0, x1, z0, z1]
  function furniture() {
    const out = [];
    for (let j = 0; j < GNZ; j++) {
      let i0 = -1;
      for (let i = 0; i <= GNX; i++) {
        const k = j * GNX + i, on = i < GNX && W.hi[k] > G_LOW && W.lo[k] < G_TOP;
        if (on && i0 < 0) i0 = i;
        else if (!on && i0 >= 0) { out.push([GX0 + i0 * GC - 1e-3, GX0 + i * GC + 1e-3, GZ0 + j * GC - 1e-3, GZ0 + (j + 1) * GC + 1e-3]); i0 = -1; }
      }
    }
    return out;
  }
  return { nodes, beds, sofas, doors, walls, doorCols, readDoors, buildClearance, snapPOIs, doorNodes, edges, addNode, kill, usable, reachable, route, nearestNode, blocked, blockedRoute, segmentFree, clearAt, roomOf, doorOpen, passable, furniture };
}

// ================================================================ SOUND (synthesised bark / whine, quiet, after a user gesture)
let audioCtx = null;
function audio() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audioCtx = new AC(); }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function whine(pitch = 1) { // a soft rising-falling whimper with vibrato
  try {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime, osc = ac.createOscillator(), vib = ac.createOscillator(), vg = ac.createGain(), g = ac.createGain(), lp = ac.createBiquadFilter();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(900 * pitch, t); osc.frequency.exponentialRampToValueAtTime(1500 * pitch, t + 0.35); osc.frequency.exponentialRampToValueAtTime(1000 * pitch, t + 0.8);
    vib.frequency.value = 9; vg.gain.value = 40; vib.connect(vg); vg.connect(osc.frequency);
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035, t + 0.12); g.gain.setValueAtTime(0.035, t + 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    osc.connect(lp); lp.connect(g); g.connect(ac.destination);
    osc.start(t); vib.start(t); osc.stop(t + 0.9); vib.stop(t + 0.9);
  } catch (e) { /* no audio: fine */ }
}
function bark(pitch = 1, n = 2) {
  try {
    if (!audio()) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.22, osc = audioCtx.createOscillator(), g = audioCtx.createGain(), bp = audioCtx.createBiquadFilter();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(520 * pitch, t); osc.frequency.exponentialRampToValueAtTime(260 * pitch, t + 0.09); osc.frequency.exponentialRampToValueAtTime(200 * pitch, t + 0.16);
      bp.type = 'bandpass'; bp.frequency.setValueAtTime(900 * pitch, t); bp.frequency.exponentialRampToValueAtTime(450 * pitch, t + 0.14); bp.Q.value = 2.5;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      osc.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.2);
    }
  } catch (e) { /* no audio: fine */ }
}

// ================================================================ POSES (bone euler targets, radians; root.y = height of the pelvis above the ground)
// Each pose lists [rx, ry, rz] per bone; unlisted bones are 0. Leg bones: rx > 0 swings the limb backward (about +X).
const POSES = {
  stand: { rootY: 0.49, rootP: 0 },
  sit: { // bottom down, hocks flat, forelegs straight, head up a little
    rootY: 0.2, rootP: 0.6, spine: [0.05, 0, 0], chest: [0.05, 0, 0], neck: [0.25, 0, 0], neck2: [0.08, 0, 0], head: [0.05, 0, 0],
    thighL: [-1.05, 0, 0.12], shinL: [1.95, 0, 0], footL: [-2.4, 0, 0], thighR: [-1.05, 0, -0.12], shinR: [1.95, 0, 0], footR: [-2.4, 0, 0],
    armL: [0.1, 0, 0], foreL: [-0.15, 0, 0], pawL: [0.05, 0, 0], armR: [0.1, 0, 0], foreR: [-0.15, 0, 0], pawR: [0.05, 0, 0], tail1: [-0.3, 0.3, 0], tail2: [-0.1, 0.35, 0],
  },
  lie: { // sphinx: elbows down, forearms forward, hind legs tucked beside the body
    rootY: 0.19, rootP: 0.06, spine: [-0.04, 0, 0], chest: [-0.04, 0, 0], neck: [-0.05, 0, 0],
    thighL: [-1.2, 0, 0.22], shinL: [2.15, 0, 0], footL: [-2.45, 0, 0], thighR: [-1.2, 0, -0.22], shinR: [2.15, 0, 0], footR: [-2.45, 0, 0],
    armL: [0.3, 0, 0.04], foreL: [-1.85, 0, 0], pawL: [0.1, 0, 0], armR: [0.3, 0, -0.04], foreR: [-1.85, 0, 0], pawR: [0.1, 0, 0], tail1: [-0.3, 0.5, 0], tail2: [-0.1, 0.5, 0], tail3: [0, 0.5, 0],
  },
  curl: { // dozing: sphinx body, spine bent round to the left, head down on the forepaws, tail along the left flank
    rootY: 0.175, rootP: 0.05, spine: [0, 0.32, 0], chest: [0, 0.28, 0], neck: [0.5, 0.42, 0], neck2: [0.35, 0.3, 0], head: [0.2, 0.15, 0.08],
    thighL: [-1.2, 0, 0.2], shinL: [2.15, 0, 0], footL: [-2.45, 0, 0], thighR: [-1.2, 0, -0.2], shinR: [2.15, 0, 0], footR: [-2.45, 0, 0],
    armL: [0.35, 0.15, 0.05], foreL: [-1.95, 0, 0], pawL: [0.3, 0, 0], armR: [0.35, -0.15, -0.05], foreR: [-1.95, 0, 0], pawR: [0.3, 0, 0],
    tail1: [-0.3, -0.9, 0], tail2: [0, -0.9, 0], tail3: [0, -0.8, 0], tail4: [0, -0.6, 0], tail5: [0, -0.4, 0], earL: [0, 0, 0.25], earR: [0, 0, -0.25],
  },
  donut: { // asleep in a ring (the photo): flat on the floor, spine bent round to the left until the nose rests by the
    // thigh, legs folded in under the belly, tail curled along the flank. The curl stays level: only a hint of hip roll.
    rootY: 0.17, rootP: 0.03, rootR: 0.2,
    spine: [0.02, 0.42, 0.05], chest: [0.02, 0.45, 0.05], neck: [0.65, 0.5, 0.05], neck2: [0.4, 0.45, 0], head: [0.25, 0.35, 0.3],
    thighL: [-1.3, 0.2, 0.45], shinL: [2.2, 0, 0], footL: [-2.3, 0, 0], thighR: [-1.3, -0.1, -0.2], shinR: [2.2, 0, 0], footR: [-2.4, 0, 0],
    armL: [0.5, 0.3, 0.3], foreL: [-2.2, 0, 0], pawL: [0.4, 0, 0], armR: [0.45, 0.1, -0.15], foreR: [-2.1, 0, 0], pawR: [0.4, 0, 0],
    tail1: [-0.2, -0.75, 0], tail2: [0, -0.7, 0], tail3: [0, -0.65, 0], tail4: [0, -0.55, 0], tail5: [0, -0.4, 0], earL: [0, 0, -0.1], earR: [0, 0, -0.2],
  },
  side: { // flat out on the right side, legs loosely stretched, head on the floor
    rootY: 0.125, rootP: 0, rootR: 1.35,
    spine: [-0.05, 0.08, 0], chest: [-0.05, 0.05, 0], neck: [0.15, 0.1, -0.25], neck2: [0.05, 0.05, -0.25], head: [0.05, 0, -0.35],
    thighL: [-0.35, 0, 0.4], shinL: [0.9, 0, 0], footL: [-0.5, 0, 0], thighR: [-0.55, 0, -0.1], shinR: [1.0, 0, 0], footR: [-0.5, 0, 0],
    armL: [0.5, 0, 0.35], foreL: [-0.6, 0, 0], pawL: [0.1, 0, 0], armR: [0.4, 0, -0.1], foreR: [-0.5, 0, 0], pawR: [0.1, 0, 0],
    tail1: [-0.4, -0.2, 0], tail2: [0, -0.2, 0], tail3: [0, -0.1, 0], earL: [0, 0, -0.45], earR: [0, 0, -0.3],
  },
  stretch: { // waking up: forelegs out in front, chest down, bum up, head low
    rootY: 0.45, rootP: -0.55, spine: [-0.1, 0, 0], neck: [0.6, 0, 0], neck2: [0.2, 0, 0], head: [0.1, 0, 0],
    armL: [-0.8, 0, 0.08], foreL: [-0.7, 0, 0], pawL: [0.1, 0, 0], armR: [-0.8, 0, -0.08], foreR: [-0.7, 0, 0], pawR: [0.1, 0, 0],
    thighL: [-0.25, 0, 0], shinL: [0.5, 0, 0], footL: [-0.25, 0, 0], thighR: [-0.25, 0, 0], shinR: [0.5, 0, 0], footR: [-0.25, 0, 0], tail1: [0.4, 0, 0],
  },
  bow: { // play bow: chest down, forelegs stretched out in front, bum up
    rootY: 0.45, rootP: -0.5, spine: [-0.1, 0, 0], neck: [0.3, 0, 0], neck2: [0.15, 0, 0],
    armL: [-0.75, 0, 0.1], foreL: [-0.85, 0, 0], pawL: [0.1, 0, 0], armR: [-0.75, 0, -0.1], foreR: [-0.85, 0, 0], pawR: [0.1, 0, 0],
    thighL: [-0.3, 0, 0], shinL: [0.6, 0, 0], footL: [-0.3, 0, 0], thighR: [-0.3, 0, 0], shinR: [0.6, 0, 0], footR: [-0.3, 0, 0], tail1: [0.7, 0, 0], tail2: [0.2, 0, 0],
  },
  scratch: { // sitting, right hind leg up at the ear
    rootY: 0.21, rootP: 0.55, spine: [0.0, 0, 0.12], chest: [0.0, 0, 0.1], neck: [0.1, 0, 0.35], neck2: [0.1, 0, 0.25], head: [0.2, -0.3, 0.35],
    thighL: [-1.05, 0, 0.12], shinL: [1.95, 0, 0], footL: [-2.4, 0, 0], thighR: [-0.9, 0, -1.0], shinR: [0.4, 0, 0], footR: [-0.3, 0, 0],
    armL: [0.1, 0, 0], foreL: [-0.15, 0, 0], armR: [0.05, 0, 0.25], foreR: [-0.1, 0, 0], tail1: [-0.3, 0.3, 0], tail2: [-0.1, 0.35, 0],
  },
};
const POSE_NAMES = Object.keys(POSES);
const POSE_BONES = ['spine', 'chest', 'neck', 'neck2', 'head', 'armL', 'foreL', 'pawL', 'armR', 'foreR', 'pawR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'earL', 'earR'];

// ================================================================ PUBLIC API
const ALL_DOGS = new Set();

/** Pet a dog: accepts a dog object, its group or any mesh inside it. */
export function pet(target) {
  let o = target;
  if (o && typeof o.pet === 'function' && ALL_DOGS.has(o)) return o.pet();
  while (o) {
    if (o.userData && o.userData.dalmatian) return o.userData.dalmatian.pet();
    o = o.parent;
  }
  return false;
}

const PET_LINES = {
  Logan: ['Logan kwispelt als een gek', 'Logan leunt tegen je aan', 'Logan wil nog veel meer aaien', 'Logan geeft je een lik'],
  Gemma: ['Gemma kwispelt blij', 'Gemma duwt haar kop in je hand', 'Gemma vindt dit heerlijk', 'Gemma doet een speelbuiging'],
};

// ---- body shape: after every pose the skinned vertices are measured (the same skinning the GPU does) into 6 cm slots of
// the dog's own frame; each filled slot becomes a bin [x, z, radius, y-low, y-high]. Collision, support and fit tests use
// these bins, so the walls, doors, furniture and the other dog are kept out of the body as it is drawn, not out of a circle.
const SLX = 20, SLZ = 32, SL = SLX * SLZ, SW = 0.06, SX0 = -0.6, SZ0 = -0.9;
const sAcc = new Float32Array(SL * 6);
const newBody = () => ({ bins: new Float32Array(SL * 10), nb: 0, footLo: 0, trunk: new Float32Array(6) });
// canonical shape of a pose: the union over head turns, nods and tail positions the dog may show in it
const SAMPLES = [[0, 0, 0, 0], [0.6, 0, 0, 0], [-0.6, 0, 0, 0], [0, -0.8, 0, 0], [0, 1.0, 0, 0], [0, 0, 1, 0.7], [0, 0, -1, 0.7], [0, 0, 1, -0.3], [0, 0, -1, -0.3]];
// a pose that does not fit where the dog is falls back along these
const FALLBACK = { donut: ['curl', 'lie', 'sit'], curl: ['donut', 'lie', 'sit'], side: ['donut', 'curl', 'lie', 'sit'], lie: ['sit'], sit: [], bow: ['sit'], stretch: ['sit'], scratch: ['sit'], stand: [] };
const LEGS = ['armL', 'armR', 'thighL', 'thighR'], PAW_REST = [[0.067, 0.205], [-0.067, 0.205], [0.064, -0.32], [-0.064, -0.32]];
const PARENT = BONES.map((b) => (b[1] ? BI[b[1]] : -1));

export function addDalmatians(THREE, scene, opts = {}) {
  const H = (typeof window !== 'undefined' && window.HOUSE) || opts.house || null;
  const onTick = opts.onTick || (H && H.onTick);
  const toast = (msg) => { try { if (H && H.ui && H.ui.toast) H.ui.toast(msg); } catch (e) { /* ignore */ } };
  const geos = [], mats = [], texs = [];
  const std = (p) => { const m = new THREE.MeshStandardMaterial(p); mats.push(m); return m; };

  // ---- shared resources
  const shared = {
    bump: furBump(THREE), rough: furRough(THREE), eyeGeo: new THREE.SphereGeometry(1, 16, 12), noseGeo: new THREE.SphereGeometry(1, 12, 9),
    eyeMat: new THREE.MeshPhysicalMaterial({ map: eyeTexture(THREE), roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 }),
    noseMat: new THREE.MeshPhysicalMaterial({ color: 0x141217, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.35 }),
    shadowGeo: new THREE.PlaneGeometry(1, 1), shadowMat: new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  texs.push(shared.bump, shared.rough, shared.eyeMat.map, shared.shadowMat.map); geos.push(shared.eyeGeo, shared.noseGeo, shared.shadowGeo); mats.push(shared.eyeMat, shared.noseMat, shared.shadowMat);
  const fab = fabricTexture(THREE), fab2 = fab.clone(); fab.repeat.set(10, 2); fab2.repeat.set(8, 1); texs.push(fab, fab2);
  const bedMats = { rim: std({ color: 0x8e8577, map: fab, roughness: 0.95 }), cushion: std({ color: 0xd9ccb2, map: fab2, roughness: 0.95 }) };
  const bowlMats = { steel: std({ color: 0xcfd2d6, metalness: 0.9, roughness: 0.3 }), mat: std({ color: 0x4a4f55, roughness: 0.95 }), water: std({ color: 0x9fc4d8, roughness: 0.05, metalness: 0.1 }), kibble: std({ color: 0x8a5a2b, roughness: 1 }) };
  const bed = buildBed(THREE, bedMats, geos, MAND.x, MAND.z, 0); scene.add(bed);
  const bowls = buildBowls(THREE, bowlMats, geos, 8.07, 0.35, 0); scene.add(bowls);
  const W = makeWorld(THREE, scene, H), nav = makeNav(H, W), beds = nav.beds, sofas = nav.sofas;

  const specs = [
    { name: 'Logan', seed: 4101, scale: 1.0, wide: 1.0, collar: '#2a4fbf', bodySpots: 105, earSpots: [5, 26], earGap: [1.0, 0.22], eyePatch: [0, 1], speed: 0.72, trot: 1.45, pitch: 0.85 },
    { name: 'Gemma', seed: 7207, scale: 0.92, wide: 0.95, collar: '#c4262e', bodySpots: 125, earSpots: [9, 8], earGap: [0.6, 0.7], eyePatch: null, speed: 0.78, trot: 1.55, pitch: 1.1 },
  ];
  const dogs = specs.map((spec, index) => {
    const P = buildDog(THREE, spec, shared);
    geos.push(P.parts.geo); mats.push(P.mat); texs.push(P.coat);
    const d = {
      name: spec.name, index, spec, group: P.root, P, scale: spec.scale, other: null, placed: false,
      x: 0, z: 0, heading: 0, speed: 0, lift: 0, ox: 0, oz: 0, oh: 0, vx: 0, vz: 0, om: 0, ue: 0, pushX: 0, pushZ: 0,
      spot: null, target: null, onSofa: false, sofa: null, bed: null, hop: null, room: 'woonkamer', faceH: null,
      state: 'idle', timer: 2, pose: 'stand', poseReq: '', poseUse: 'stand', poseT: 0, poseW: Object.fromEntries(POSE_NAMES.map((k) => [k, k === 'stand' ? 1 : 0])),
      body: newBody(), canon: {}, paw: new Float32Array(16), pawSt: [1, 1, 1, 1], escT: 0, way: 0, wayX: 0, wayZ: 0, jumpT: 0,
      waitT: 0, waitNode: null, toasted: false, shakeT: 0,
      goal: -1, goalKind: null, path: new Int16Array(32), pathLen: 0, pathIdx: 0, stuckT: 0, lastProg: 0,
      phase: Math.random(), walkBlend: 0, trotBlend: 0, breath: Math.random() * TAU,
      wag: 0.15, wagPhase: 0, tailUp: 0,
      lookMode: 'random', lookYaw: 0, lookPitch: 0, lookTilt: 0, lookT: 1, hy: 0, hp: 0, ht: 0,
      blinkT: 2 + Math.random() * 3, blink: 0, sleepy: 0,
      earFlickT: 3, earFlick: 0, earSide: 1, earBack: 0,
      jaw: 0, pant: 0, yawnT: 0, sniff: 0,
      petT: 0, petCool: 0, greetCool: 10 + index * 15, followT: 0, follow: false, happy: 0, bowT: 0, circleDir: 1,
      sleepT: 0, stir: 0, bedCool: 0, sofaCool: 20 * index, lodAcc: 0, dist: 0, visible: true,
      nextDecision: null, pet: null,
    };
    d.pet = () => doPet(d);
    P.root.userData.dalmatian = d;
    P.root.traverse((o) => { o.userData.dalmatian = d; });
    P.root.visible = false; // shown once the house is there and the dog has a place
    scene.add(P.root);
    ALL_DOGS.add(d);
    return d;
  });
  dogs[0].other = dogs[1]; dogs[1].other = dogs[0];
  const byName = (n) => dogs.find((d) => d.name.toLowerCase() === String(n || '').toLowerCase()) || null;

  // ---------------------------------------------------------------- body measurement
  const LMs = BONES.map(() => new THREE.Matrix4()), BMe = new Float32Array(BONES.length * 16), M4 = new THREE.Matrix4();
  function accReset() { for (let k = 0; k < SL; k++) { const o = 6 * k; sAcc[o] = sAcc[o + 2] = sAcc[o + 4] = 9; sAcc[o + 1] = sAcc[o + 3] = sAcc[o + 5] = -9; } }
  // skin every vertex of the current bone pose into the slots (dog frame, metres); returns the lowest y
  function skinAcc(d) {
    const mesh = d.P.mesh, bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses, s = d.scale;
    for (let b = 0; b < bones.length; b++) {
      bones[b].updateMatrix();
      if (PARENT[b] < 0) LMs[b].copy(bones[b].matrix); else LMs[b].multiplyMatrices(LMs[PARENT[b]], bones[b].matrix);
      BMe.set(M4.multiplyMatrices(LMs[b], inv[b]).elements, b * 16);
    }
    const A = mesh.geometry.attributes, pos = A.position.array, si = A.skinIndex.array, sw = A.skinWeight.array, n = pos.length / 3;
    let foot = 9;
    for (let i = 0; i < n; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      let X = 0, Y = 0, Z = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw[4 * i + k]; if (!w) continue;
        const e = si[4 * i + k] * 16;
        X += w * (BMe[e] * x + BMe[e + 4] * y + BMe[e + 8] * z + BMe[e + 12]);
        Y += w * (BMe[e + 1] * x + BMe[e + 5] * y + BMe[e + 9] * z + BMe[e + 13]);
        Z += w * (BMe[e + 2] * x + BMe[e + 6] * y + BMe[e + 10] * z + BMe[e + 14]);
      }
      X *= s; Y *= s; Z *= s;
      if (Y < foot) foot = Y;
      const ix = clamp(Math.floor((X - SX0) / SW), 0, SLX - 1), iz = clamp(Math.floor((Z - SZ0) / SW), 0, SLZ - 1), o = 6 * (iz * SLX + ix);
      if (X < sAcc[o]) sAcc[o] = X; if (X > sAcc[o + 1]) sAcc[o + 1] = X;
      if (Z < sAcc[o + 2]) sAcc[o + 2] = Z; if (Z > sAcc[o + 3]) sAcc[o + 3] = Z;
      if (Y < sAcc[o + 4]) sAcc[o + 4] = Y; if (Y > sAcc[o + 5]) sAcc[o + 5] = Y;
    }
    return foot;
  }
  function binsOut(d, body, foot) {
    let nb = 0; const B = body.bins;
    for (let k = 0; k < SL; k++) {
      const o = 6 * k; if (sAcc[o + 1] < sAcc[o]) continue;
      const hx = (sAcc[o + 1] - sAcc[o]) / 2, hz = (sAcc[o + 3] - sAcc[o + 2]) / 2, q = 5 * nb++;
      B[q] = sAcc[o] + hx; B[q + 1] = sAcc[o + 2] + hz; B[q + 2] = Math.hypot(hx, hz) + 0.01; B[q + 3] = sAcc[o + 4]; B[q + 4] = sAcc[o + 5];
    }
    body.nb = nb; body.footLo = foot;
    const s = d.scale, a = LMs[0].elements, c = LMs[BI.chest].elements, t = body.trunk; // root -> chest, the dog's core
    t[0] = a[12] * s; t[1] = a[13] * s; t[2] = a[14] * s; t[3] = c[12] * s; t[4] = c[13] * s; t[5] = c[14] * s;
  }
  // the dog also keeps room for the pose it is going to (canonical shape, every head turn / nod and tail included): it is
  // added to the measured shape, so a turn, a look or the rest of a pose change (sit / bow when petted) never ends in a wall
  function measure(d) {
    const st = !d.spot ? canon(d, d.poseUse) : null;
    accReset(); binsOut(d, d.body, skinAcc(d));
    if (st) { d.body.bins.set(st.bins.subarray(0, st.nb * 5), d.body.nb * 5); d.body.nb += st.nb; }
  }
  const SAVE = new Float32Array(POSE_BONES.length * 3 + 6);
  function canonBones(d, name, yaw, pitch, wag, up) { // the static pose as pose() applies it, plus a look / tail sample
    const B = d.P.byName, p = POSES[name], lying = name === 'lie' || name === 'curl' || name === 'donut' || name === 'side' ? 1 : 0, rp = p.rootP;
    for (const b of POSE_BONES) { const r = p[b]; B[b].rotation.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0); }
    for (const b of ['armL', 'armR', 'thighL', 'thighR', 'tail1']) B[b].rotation.x += rp;
    B.neck2.rotation.y += yaw * 0.4; B.head.rotation.y += yaw * 0.6; B.neck2.rotation.x += pitch * 0.45; B.head.rotation.x += pitch * 0.55;
    for (let i = 0; i < 5; i++) { const t = B['tail' + (i + 1)], a = wag * (i === 0 ? 0.45 : 0.3); t.rotation.y += a; t.rotation.z += a * 0.35; t.rotation.x += i === 0 ? up * 0.9 : up * 0.22 - 0.05 * lying; }
    B.earL.rotation.z += 0.15; B.earR.rotation.z -= 0.15;
    B.root.position.set(0, p.rootY, -0.22); B.root.rotation.set(-rp, 0, p.rootR || 0);
  }
  function canon(d, name) {
    if (d.canon[name]) return d.canon[name];
    const B = d.P.byName, R = B.root; let k = 0;
    for (const b of POSE_BONES) { const r = B[b].rotation; SAVE[k++] = r.x; SAVE[k++] = r.y; SAVE[k++] = r.z; }
    SAVE[k++] = R.position.x; SAVE[k++] = R.position.y; SAVE[k++] = R.position.z; SAVE[k++] = R.rotation.x; SAVE[k++] = R.rotation.y; SAVE[k++] = R.rotation.z;
    accReset(); let foot = 9;
    for (const s of SAMPLES) { canonBones(d, name, s[0], s[1], s[2], s[3]); foot = Math.min(foot, skinAcc(d)); }
    const body = newBody(); binsOut(d, body, foot); d.canon[name] = body;
    k = 0;
    for (const b of POSE_BONES) { B[b].rotation.set(SAVE[k], SAVE[k + 1], SAVE[k + 2]); k += 3; }
    R.position.set(SAVE[k], SAVE[k + 1], SAVE[k + 2]); R.rotation.set(SAVE[k + 3], SAVE[k + 4], SAVE[k + 5]);
    for (const b of d.P.mesh.skeleton.bones) b.updateMatrix();
    return body;
  }

  // ---------------------------------------------------------------- collision: how deep is a body at (x, z, h, lift) in things
  // mode bits: 1 the drawn world (grid), 2 walls + jambs + shut / outside doors, 4 door leaves at their live angle, 8 the other dog
  const NR = [], NL = [], PEN = { max: 0, px: 0, pz: 0 }, tmpN = [0, 0], MARGIN = 0.01, DOG_GAP = 0.2; // DOG_GAP: extra room kept around the other dog (~0.5 m between the bodies)
  function setNear(x, z, R) {
    NR.length = 0; NL.length = 0;
    for (const c of nav.walls) if (c[1] > x - R && c[0] < x + R && c[3] > z - R && c[2] < z + R) NR.push(c);
    for (const g of nav.doors) {
      if (Math.hypot(g.mid[0] - x, g.mid[1] - z) > R + g.W + 0.3) continue;
      NR.push(g.posts[0], g.posts[1]);
      if (g.ext || doorShut(g.d)) NR.push(g.col);
      if (!g.d.slide) NL.push(g);
    }
  }
  function circleBox(x, z, r, x0, x1, z0, z1) {
    const px = x < x0 ? x0 : x > x1 ? x1 : x, pz = z < z0 ? z0 : z > z1 ? z1 : z, dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return 0;
    if (d2 > 1e-12) { const l = Math.sqrt(d2); tmpN[0] = dx / l; tmpN[1] = dz / l; return r - l; }
    const e0 = x - x0, e1 = x1 - x, e2 = z - z0, e3 = z1 - z, m = Math.min(e0, e1, e2, e3);
    if (m === e0) { tmpN[0] = -1; tmpN[1] = 0; } else if (m === e1) { tmpN[0] = 1; tmpN[1] = 0; } else if (m === e2) { tmpN[0] = 0; tmpN[1] = -1; } else { tmpN[0] = 0; tmpN[1] = 1; }
    return r + m;
  }
  function segDist(x, z, ax, az, bx, bz) { // 2D distance to a segment; the push direction (away from it) in tmpN
    const ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz, t = l2 > 1e-12 ? clamp(((x - ax) * ux + (z - az) * uz) / l2, 0, 1) : 0;
    const ex = x - ax - ux * t, ez = z - az - uz * t, l = Math.hypot(ex, ez);
    if (l > 1e-9) { tmpN[0] = ex / l; tmpN[1] = ez / l; } else { tmpN[0] = -uz; tmpN[1] = ux; const q = Math.hypot(ux, uz) || 1; tmpN[0] /= q; tmpN[1] /= q; }
    return l;
  }
  const TR = new Float32Array(12);
  function trunkAt(t, x, z, h, lift, out, o) { const c = Math.cos(h), s = Math.sin(h); for (let i = 0; i < 2; i++) { const lx = t[3 * i], lz = t[3 * i + 2]; out[o + 3 * i] = x + lx * c + lz * s; out[o + 3 * i + 1] = lift + t[3 * i + 1]; out[o + 3 * i + 2] = z - lx * s + lz * c; } }
  function pen(d, x, z, h, lift, body, mode, limit) {
    const c = Math.cos(h), s = Math.sin(h), B = body.bins, o = d.other, withDog = (mode & 8) && o.placed;
    let tot = 0, mx = 0, px = 0, pz = 0, dep = 0;
    const add = () => { tot += dep; px += tmpN[0] * dep; pz += tmpN[1] * dep; if (dep > mx) mx = dep; };
    if (withDog) { trunkAt(o.body.trunk, o.x, o.z, o.heading, o.lift, TR, 0); trunkAt(body.trunk, x, z, h, lift, TR, 6); }
    const rO = 0.09 * o.scale + DOG_GAP, rM = 0.09 * d.scale + DOG_GAP;
    for (let i = 0; i < body.nb; i++) {
      const q = 5 * i, lx = B[q], lz = B[q + 1], r = B[q + 2] + MARGIN, y0 = lift + B[q + 3], y1 = lift + B[q + 4];
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      if (mode & 1) {
        const i0 = Math.max(0, Math.floor((wx - r - GX0) / GC)), i1 = Math.min(GNX - 1, Math.floor((wx + r - GX0) / GC));
        const j0 = Math.max(0, Math.floor((wz - r - GZ0) / GC)), j1 = Math.min(GNZ - 1, Math.floor((wz + r - GZ0) / GC));
        for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
          const kk = j * GNX + k, top = W.hi[kk]; if (top < G_LOW) continue;
          const lo = W.lo[kk], bot = lo <= G_Y0 + 1e-3 ? -1 : lo, tol = Math.min(0.02, (top - lo) * 0.45); // standing on the floor: solid from the floor up
          if (!(y0 < top - tol && y1 > bot + tol)) continue;
          const bx = GX0 + k * GC, bz = GZ0 + j * GC;
          dep = circleBox(wx, wz, r, bx, bx + GC, bz, bz + GC); if (dep > 0) { add(); if (tot > limit) return tot; }
        }
      }
      if (mode & 2) for (let k = 0; k < NR.length; k++) { const R = NR[k]; dep = circleBox(wx, wz, r, R[0], R[1], R[2], R[3]); if (dep > 0) { add(); if (tot > limit) return tot; } }
      if (mode & 4) for (let k = 0; k < NL.length; k++) { const rr = r + LEAF_T + 0.01, l = leafDist(wx, wz, NL[k], tmpN); if (l < rr) { dep = rr - l; add(); if (tot > limit) return tot; } }
      if (withDog && y1 > Math.min(TR[1], TR[4]) - rO && y0 < Math.max(TR[1], TR[4]) + rO) {
        const l = segDist(wx, wz, TR[0], TR[2], TR[3], TR[5]); if (l < r + rO) { dep = r + rO - l; add(); if (tot > limit) return tot; }
      }
    }
    if (withDog) { // the other dog's body against my core
      const OB = o.body.bins, oc = Math.cos(o.heading), os = Math.sin(o.heading), ylo = Math.min(TR[7], TR[10]) - rM, yhi = Math.max(TR[7], TR[10]) + rM;
      for (let i = 0; i < o.body.nb; i++) {
        const q = 5 * i, r = OB[q + 2] + MARGIN; if (o.lift + OB[q + 4] < ylo || o.lift + OB[q + 3] > yhi) continue;
        const wx = o.x + OB[q] * oc + OB[q + 1] * os, wz = o.z - OB[q] * os + OB[q + 1] * oc, l = segDist(wx, wz, TR[6], TR[8], TR[9], TR[11]);
        if (l < r + rM) { dep = r + rM - l; tmpN[0] = -tmpN[0]; tmpN[1] = -tmpN[1]; add(); if (tot > limit) return tot; }
      }
    }
    PEN.max = mx; PEN.px = px; PEN.pz = pz;
    return tot;
  }
  // the straight line between two points crosses a wall or a shut / outside door (the dog's centre never does)
  function segBlocked(x0, z0, x1, z1) {
    setNear((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 0.1);
    for (const c of NR) if (segRect(x0, z0, x1, z1, c, 0)) return true;
    return false;
  }
  // a hop from (x0, z0, h0) to (x1, z1, h1) keeps the body out of walls, door leaves and the other dog on the way
  function hopPathClear(d, x0, z0, h0, x1, z1, h1, body) {
    if (segBlocked(x0, z0, x1, z1)) return false;
    const dh = wrapAngle(h1 - h0), n = Math.max(4, Math.ceil(Math.max(Math.hypot(x1 - x0, z1 - z0) / 0.04, Math.abs(dh) / 0.12)));
    for (let i = 1; i < n; i++) { // every 4 cm / 7 degrees along the way: no thin wall or door leaf slips between samples
      const t = i / n, e = t * t * (3 - 2 * t), x = lerp(x0, x1, e), z = lerp(z0, z1, e);
      setNear(x, z, 1.4); if (pen(d, x, z, h0 + dh * e, 0, body, 14, 1e-4) > 1e-4) return false;
    }
    return true;
  }
  // nearest free floor (standing, clear of everything and the other dog) the dog can hop to from (x0, z0)
  function findFree(d, x0, z0, h0, maxR) {
    const st = canon(d, 'stand'), lift = -st.footLo;
    for (let R = 0.08; R <= maxR + 1e-6; R += 0.08) for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU, x = x0 + Math.sin(a) * R, z = z0 + Math.cos(a) * R;
      if (!nav.roomOf(x, z) || nav.clearAt(x, z) < 0.08) continue;
      for (const dh of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        const th = wrapAngle(h0 + dh);
        setNear(x, z, 1.4);
        if (pen(d, x, z, th, lift, st, 15, 1e-4) > 1e-4) continue;
        if (hopPathClear(d, x0, z0, h0, x, z, th, st)) return [x, z, th];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- rest spots (dog beds, sofas)
  // a spot is fitted on the drawn world: the seat height is the most common cell top on it, the dog's place (px, pz, ph) is
  // the first lattice point near the hint where it can stand and lie (canonical shapes, its lower body over the flat seat),
  // and the jump point (jx, jz) is free floor next to it in the same room, reachable from the walking graph
  function newSpot(kind, id, x, z, r, hint, room) {
    return { kind, id, x, z, r, hint, room, box: null, ry: 0, host: false, seatY: 0, y: 0, heading: hint, ok: false, px: x, pz: z, ph: hint, poses: [], jx: x, jz: z, jh: 0, node: -1, claim: null };
  }
  function spotCells(sp, fn) {
    if (sp.kind === 'bed') {
      const R = sp.r; for (let z = sp.z - R; z <= sp.z + R + 1e-6; z += GC) for (let x = sp.x - R; x <= sp.x + R + 1e-6; x += GC) { const k = gCell(x, z); if (k >= 0) fn(k, x, z, Math.hypot(x - sp.x, z - sp.z)); }
    } else {
      const b = sp.box; for (let z = b[2] + GC / 2; z < b[3]; z += GC) for (let x = b[0] + GC / 2; x < b[1]; x += GC) { const k = gCell(x, z); if (k >= 0) fn(k, x, z, 0); }
    }
  }
  function seatHeight(sp) {
    const y0 = sp.kind === 'bed' ? 0.04 : 0.25, y1 = sp.kind === 'bed' ? 0.35 : 0.62, cnt = new Map();
    spotCells(sp, (k, x, z, r) => { const h = W.hi[k]; if (h < y0 || h > y1 || (sp.kind === 'bed' && r > sp.r * 0.5)) return; const q = Math.round(h * 100), e = cnt.get(q) || [0, 0]; e[0]++; e[1] += h; cnt.set(q, e); });
    let best = null; for (const e of cnt.values()) if (!best || e[0] > best[0]) best = e;
    return best && best[0] >= 4 ? best[1] / best[0] : null;
  }
  // canonical body at (x, z, h) on a seat at seatY: nothing in the way, the low parts resting on the flat seat
  function fitsOn(d, body, x, z, h, seatY) {
    const lift = seatY - body.footLo;
    setNear(x, z, 1.4);
    if (pen(d, x, z, h, lift, body, 7, 1e-4) > 1e-4) return false;
    const c = Math.cos(h), s = Math.sin(h), B = body.bins;
    for (let i = 0; i < body.nb; i++) {
      const q = 5 * i; if (B[q + 3] - body.footLo > 0.04) continue;
      const wx = x + B[q] * c + B[q + 1] * s, wz = z - B[q] * s + B[q + 1] * c, r = B[q + 2];
      for (let zz = wz - r; zz <= wz + r + 1e-6; zz += GC) for (let xx = wx - r; xx <= wx + r + 1e-6; xx += GC) { const k = gCell(xx, zz); if (k < 0 || Math.abs(W.hi[k] - seatY) > 0.025) return false; }
    }
    return true;
  }
  function jumpPoint(sp) {
    const L = dogs[0], st = canon(L, 'stand');
    for (const R of [0.6, 0.75, 0.9, 1.05, 1.2]) for (let k = 0; k < 16; k++) {
      const a = sp.ph + Math.PI / 2 + (k / 16) * TAU, jx = sp.px + Math.sin(a) * R, jz = sp.pz + Math.cos(a) * R;
      if (nav.roomOf(jx, jz) !== sp.room || nav.clearAt(jx, jz) < 0.1) continue;
      const jh = Math.atan2(sp.px - jx, sp.pz - jz);
      setNear(jx, jz, 1.4);
      if (pen(L, jx, jz, jh, -st.footLo, st, 7, 1e-4) > 1e-4) continue;
      if (segBlocked(jx, jz, sp.px, sp.pz)) continue;
      let ok = true;
      for (const t of [0.25, 0.5, 0.75]) { const e = t * t * (3 - 2 * t), x = lerp(jx, sp.px, e), z = lerp(jz, sp.pz, e); setNear(x, z, 1.4); if (pen(L, x, z, jh + wrapAngle(sp.ph - jh) * e, 0, st, 6, 1e-4) > 1e-4) { ok = false; break; } }
      if (!ok || !nav.reachable(jx, jz)) continue;
      sp.jx = jx; sp.jz = jz; sp.jh = jh; return true;
    }
    return false;
  }
  // what a fit depends on: the spot itself and the world within reach of it (grid, rooms, walls, doors and their leaves).
  // A rebuild elsewhere (the kitchen toggle re-reads the whole house) then keeps the fit instead of searching again.
  // ponytail: nav.reachable (nodes up to 4 m away) is not in the key; a new wall that cuts a jump point off its floor is
  // inside the box anyway
  function fitKey(sp) {
    const E = 2.7, b = sp.box || [sp.x - sp.r, sp.x + sp.r, sp.z - sp.r, sp.z + sp.r], x0 = b[0] - E, x1 = b[1] + E, z0 = b[2] - E, z1 = b[3] + E;
    let h = 0; const mix = (v) => { h = (Math.imul(h, 31) + Math.round(v * 1000)) | 0; };
    [sp.x, sp.z, sp.r, sp.hint, sp.ry, ...b].forEach(mix);
    const i0 = Math.max(0, Math.floor((x0 - GX0) / GC)), i1 = Math.min(GNX - 1, Math.floor((x1 - GX0) / GC));
    const j0 = Math.max(0, Math.floor((z0 - GZ0) / GC)), j1 = Math.min(GNZ - 1, Math.floor((z1 - GZ0) / GC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * GNX + i; mix(W.hi[k]); mix(W.lo[k]); }
    for (let z = z0; z <= z1; z += 0.25) for (let x = x0; x <= x1; x += 0.25) { const rm = nav.roomOf(x, z) || ''; for (let q = 0; q < rm.length; q++) h = (Math.imul(h, 31) + rm.charCodeAt(q)) | 0; }
    for (const c of nav.walls) if (c[1] > x0 && c[0] < x1 && c[3] > z0 && c[2] < z1) for (let q = 0; q < 4; q++) mix(c[q]);
    for (const g of nav.doors) if (g.mid[0] > x0 - g.W && g.mid[0] < x1 + g.W && g.mid[1] > z0 - g.W && g.mid[1] < z1 + g.W) { mix(g.mid[0]); mix(g.mid[1]); mix(g.d.angle); mix(g.ext ? 1 : 0); }
    return h;
  }
  function fitSpot(sp) {
    const key = fitKey(sp); if (key === sp.fitKey) return; // nothing near it changed: the last fit stands
    sp.fitKey = key;
    sp.ok = false; sp.poses = [];
    const seat = seatHeight(sp); if (seat == null) return;
    sp.seatY = sp.y = seat;
    const L = dogs[0], st = canon(L, 'stand'), list = sp.kind === 'bed' ? ['donut', 'curl', 'lie', 'side'] : ['lie', 'curl', 'donut', 'sit'];
    const step = sp.kind === 'bed' ? Math.PI / 4 : Math.PI / 2, base = sp.kind === 'bed' ? sp.hint : sp.ry, heads = [];
    for (let k = 0; k < TAU / step - 1e-6; k++) heads.push(wrapAngle(base + k * step));
    heads.sort((a, b) => Math.abs(wrapAngle(a - sp.hint)) - Math.abs(wrapAngle(b - sp.hint)));
    const pts = [];
    spotCells(sp, (k, x, z) => { if (Math.abs(W.hi[k] - seat) < 0.015) pts.push([x, z, Math.hypot(x - sp.x, z - sp.z)]); });
    pts.sort((a, b) => a[2] - b[2]);
    // a dog bed is only lain in (it lands and lies down; its standing shape, nose down sniffing included, would hang over the
    // rim), a sofa is also stood on
    for (const [x, z] of pts) for (const h of heads) {
      if (sp.kind === 'sofa' && !fitsOn(L, st, x, z, h, seat)) continue;
      const poses = list.filter((p) => fitsOn(L, canon(L, p), x, z, h, seat));
      if (!poses.length) continue;
      sp.px = x; sp.pz = z; sp.ph = sp.heading = h; sp.poses = poses;
      if (jumpPoint(sp)) { sp.ok = true; return; }
    }
  }
  function spotNode(sp) {
    if (sp.node < 0) sp.node = nav.addNode({ id: 'n-' + sp.id, x: sp.jx, z: sp.jz, h: sp.jh, room: sp.room, kind: sp.kind, door: null, spot: sp }).i;
    const n = nav.nodes[sp.node]; n.x = sp.jx; n.z = sp.jz; n.h = sp.jh; n.room = sp.room; n.kind = sp.kind; n.spot = sp; n.off = !sp.ok;
  }
  // a dog on a spot stays when its pose and standing still fit where it is; otherwise it hops off
  function stillFits(d, sp) { return sp.ok && Math.abs(sp.seatY - d.spotY) < 0.01 && (sp.kind === 'bed' || fitsOn(d, canon(d, 'stand'), d.x, d.z, d.heading, sp.seatY)) && fitsOn(d, canon(d, sp.kind === 'bed' && d.poseUse === 'stand' ? sp.poses[0] : d.poseUse), d.x, d.z, d.heading, sp.seatY); }
  function refit(sp) {
    fitSpot(sp); spotNode(sp);
    for (const d of dogs) {
      if (d.spot === sp && !stillFits(d, sp)) leaveSpot(d);
      if (d.target === sp && !sp.ok) { d.target = null; if (sp.claim === d) sp.claim = null; if (d.state !== 'hop') idle(d, 0.5); }
    }
  }
  function dropSpot(sp) {
    sp.ok = false; sp.fitKey = null;
    for (const d of dogs) { if (d.spot === sp) leaveSpot(d); if (d.target === sp) { d.target = null; if (d.state !== 'hop') idle(d, 0.5); } }
    if (sp.node >= 0) nav.kill(nav.nodes[sp.node]); sp.node = -1; sp.claim = null;
  }
  // sofas: every ground-floor 'bank' piece big enough to lie on (the host's furniture list, so moved, hidden and restyled
  // sofas follow); the host's hint (opts.sofa) marks the corner where Gemma likes to lie
  function syncSofas() {
    const seen = new Set(), hs = opts.sofa, pieces = H && H.furniture && H.furniture.pieces ? [...H.furniture.pieces.values()] : [];
    for (const p of pieces) {
      const f = p.foot; if (p.l !== 0 || p.iid !== 'bank' || !f || !(f.max.x - f.min.x >= 0.7 && f.max.z - f.min.z >= 0.7)) continue;
      seen.add(p.key);
      const box = [f.min.x, f.max.x, f.min.z, f.max.z], host = !!(hs && hs.x > box[0] && hs.x < box[1] && hs.z > box[2] && hs.z < box[3]);
      let sp = sofas.find((s) => s.id === p.key);
      if (!sp) { sp = newSpot('sofa', p.key, 0, 0, 0, 0, p.room || nav.roomOf((box[0] + box[1]) / 2, (box[2] + box[3]) / 2)); sofas.push(sp); }
      sp.box = box; sp.ry = p.ry || 0; sp.host = host;
      sp.x = host ? hs.x : (box[0] + box[1]) / 2; sp.z = host ? hs.z : (box[2] + box[3]) / 2;
      sp.hint = host && Number.isFinite(hs.heading) ? hs.heading : sp.ry + Math.PI / 2;
    }
    for (let i = sofas.length - 1; i >= 0; i--) if (!seen.has(sofas[i].id)) { const sp = sofas[i]; sofas.splice(i, 1); dropSpot(sp); }
  }
  function addBed(b) {
    if (!b || ![b.x, b.z].every(Number.isFinite)) return null;
    const id = String(b.id || 'bed' + beds.length), r = Number.isFinite(b.r) ? b.r : 0.45, old = beds.find((q) => q.id === id);
    if (old && Math.abs(old.x - b.x) < 1e-3 && Math.abs(old.z - b.z) < 1e-3 && Math.abs(old.r - r) < 1e-3) return old; // the host re-sends it on every change
    if (old) removeBed(id);
    const sp = newSpot('bed', id, b.x, b.z, r, Number.isFinite(b.heading) ? b.heading : 0, b.room || nav.roomOf(b.x, b.z));
    beds.push(sp);
    if (ready) { refit(sp); nav.edges(); }
    return sp;
  }
  function removeBed(id) {
    const k = beds.findIndex((b) => b.id === String(id)); if (k < 0) return null;
    const sp = beds[k]; beds.splice(k, 1); dropSpot(sp);
    if (ready) nav.edges();
    return sp;
  }

  // ---------------------------------------------------------------- world sync
  let ready = false, lastColSig = '', rebuilds = 0;
  const pending = {};
  addBed(MAND);
  const colSig = () => { let s = 0; for (const c of nav.walls) s += c[0] * 3 + c[1] * 5 + c[2] * 7 + c[3] * 11; return nav.walls.length + ':' + s.toFixed(3) + ':' + (H && H.doors ? H.doors.length : 0); };
  function rebuildAll() {
    rebuilds++;
    nav.readDoors(); nav.buildClearance(); nav.snapPOIs(); nav.doorNodes();
    syncSofas();
    for (const sp of [...beds, ...sofas]) refit(sp);
    nav.edges();
    lastColSig = colSig();
    for (const d of dogs) if (d.state === 'walk' || d.state === 'waitdoor') { // routes may have changed: plan again
      const kind = d.goalKind, goal = d.goal, sp = goal >= 0 ? nav.nodes[goal].spot : null;
      if (kind === 'walker' || kind === 'come' || kind === 'follow') { if (!goToWalker(d, kind)) idle(d, 0.5); }
      else if (goal >= 0 && nav.usable(nav.nodes[goal]) && (!sp || sp.ok) && planTo(d, goal, kind)) { /* same goal, new path */ }
      else { releaseClaims(d); idle(d, 0.5); }
    }
  }
  function syncWorld(deep, budget) { if (ready && (W.sync(deep, budget) || colSig() !== lastColSig)) rebuildAll(); }
  function ensureWorld() {
    if (ready) return true;
    W.sync(false); if (!W.ready()) return false;
    ready = true; rebuildAll();
    // one dog lounges on the host's sofa (Gemma), Logan where the host put him (the office bean bag) or on the woonkamer bank
    const [log, gem] = dogs, hostSofa = sofas.find((s) => s.host && s.ok);
    if (hostSofa) putOnSpot(gem, hostSofa, 'lie', 10 + Math.random() * 12);
    if (pending.Logan) place('Logan', pending.Logan);
    else { const bank = sofas.find((s) => s.ok && !s.claim); if (bank && !hostSofa) putOnSpot(log, bank, 'curl', 25 + Math.random() * 20); }
    if (pending.Gemma) place('Gemma', pending.Gemma);
    if (!log.placed) putFree(log, 5.4, 6.3, 2.6);
    if (!gem.placed) putFree(gem, 4.6, 9.0, 1.2);
    return true;
  }

  // ---------------------------------------------------------------- behaviour
  const walker = () => (H && H.walker) || null;
  const walkMode = () => !H || H.mode === 'walk';
  const hour = () => (H && H.state && typeof H.state.time === 'number' ? H.state.time : 13);
  const evening = () => { const h = hour(); return h >= 18.5 || h < 7; };
  const nodeIdx = (id) => nav.nodes.findIndex((n) => n.id === id);
  const N_STAIRS = nodeIdx('stairs');
  const N_WALKER = nav.addNode({ id: 'walker', x: 0, z: 0, h: 0, room: null, kind: 'walker', door: null, spot: null }).i;
  function releaseClaims(d) { for (const sp of [...beds, ...sofas]) if (sp.claim === d && d.spot !== sp) sp.claim = null; if (d.target && d.target.claim !== d) d.target = null; }

  // a hop is never cut short: a call, a pet or a door that wants the dog mid-air waits until it has landed (cutting it left the
  // height frozen mid-arc while the dog walked on, floating)
  function setState(d, s, t) { if (d.hop && s !== 'hop') return; d.state = s; d.timer = t; }
  function idle(d, t) { setState(d, 'idle', t == null ? 1.5 + Math.random() * 3 : t); d.pose = 'stand'; d.goalKind = null; }
  function planTo(d, nodeIdx, kind, ignoreDoors) {
    const from = nav.nearestNode(d.x, d.z, DOG_R - 0.03);
    if (from < 0) return false;
    const n = nav.route(from, nodeIdx, d.path, ignoreDoors);
    if (!n) return false;
    d.pathLen = n; d.pathIdx = 0; d.goal = nodeIdx; d.goalKind = kind; d.stuckT = 0; d.lastProg = 1e9;
    setState(d, 'walk', 8 + n * 5); d.pose = 'stand';
    return true;
  }
  function wander(d) {
    const w = walker(), room = w && w.l === 0 ? nav.roomOf(w.x, w.z) : null;
    for (let k = 0; k < 8; k++) {
      const i = (Math.random() * nav.nodes.length) | 0, n = nav.nodes[i];
      if (!n.room || n.spot || !nav.usable(n) || i === d.goal) continue;
      if (Math.hypot(n.x - d.x, n.z - d.z) < 1.0) continue;
      if (n.room === 'wc1' || n.room === 'wc2') continue;
      if (room && n.room !== room && Math.random() < 0.4) continue; // prefer the room you are in
      if (n.room === 'achterhal' && Math.random() < 0.6) continue;
      if (planTo(d, i, n.kind)) return true;
    }
    return false;
  }
  function goSpot(d, sp, kind) { if (!sp.ok || (sp.claim && sp.claim !== d) || sp.node < 0) return false; if (planTo(d, sp.node, kind)) { sp.claim = d; d.target = sp; return true; } return false; }
  function goSleepSpot(d) {
    if (d.sofaCool <= 0 && Math.random() < (evening() ? 0.55 : 0.4)) {
      const k0 = (Math.random() * sofas.length) | 0;
      for (let k = 0; k < sofas.length; k++) if (goSpot(d, sofas[(k0 + k) % sofas.length], 'sofa')) return true;
    }
    if (d.bedCool <= 0) for (const b of beds.filter((b) => b.ok && !b.claim).sort((a, b) => Math.hypot(a.x - d.x, a.z - d.z) - Math.hypot(b.x - d.x, b.z - d.z))) if (goSpot(d, b, 'bed')) return true;
    return false;
  }
  function goToBed(d, b) { // rest(): walk to a bed and sleep there (a dog on another spot hops off first)
    if (!b || !b.ok || (b.claim && b.claim !== d)) return false;
    if (d.spot === b) { startSleep(d, 60 + Math.random() * 60); return true; }
    d.bedCool = 0; d.sleepy = 0; d.stir = 0;
    if (d.spot) { const go = () => { if (!goSpot(d, b, 'bed')) idle(d, 1); }; return leaveSpot(d, go); }
    if (d.state === 'hop') return false;
    return goSpot(d, b, 'bed');
  }
  function decide(d) {
    const r = Math.random(), w = walker();
    if (r < (evening() ? 0.3 : 0.1) && goSleepSpot(d)) return;
    const walkerNear = w && w.l === 0 && walkMode() && Math.hypot(w.x - d.x, w.z - d.z) < 7;
    if (walkerNear && Math.random() < 0.35) { d.follow = true; d.followT = 15 + Math.random() * 25; return idle(d, 0.5); }
    if (r < 0.45) { if (wander(d)) return; }
    if (r < 0.6) return startSniff(d);
    if (r < 0.78) return startSit(d, 4 + Math.random() * 6);
    if (r < 0.9) return startLie(d, 6 + Math.random() * 10);
    idle(d, 2 + Math.random() * 3);
  }
  function startSniff(d) { setState(d, 'sniff', 2.5 + Math.random() * 3); d.pose = 'stand'; d.sniff = 1; d.circleDir = Math.random() < 0.5 ? -1 : 1; }
  function startSit(d, t) { setState(d, 'sit', t); d.pose = 'sit'; }
  function startLie(d, t) { setState(d, 'lie', t); d.pose = 'lie'; }
  function startSleep(d, t, pose) { // real dalmatians spend most of the day curled in a ring; now and then flat out on a side
    const r = Math.random();
    setState(d, 'sleep', t); d.pose = pose || (r < 0.62 ? 'donut' : r < 0.85 ? 'curl' : 'side'); d.sleepT = 0;
  }
  // hops: on and off beds and sofas, and out of a squeeze. Position and heading ease along a straight line (checked clear
  // of walls and doors), the height arcs from the start support to the landing support.
  function startHop(d, tx, tz, th, s0, s1, then, arc = 0.28, dur0 = 0.6) {
    const dh = wrapAngle(th - d.heading), dist = Math.hypot(tx - d.x, tz - d.z);
    const dur = Math.max(dur0, (1.5 * Math.abs(dh)) / 6, (1.5 * dist) / 3.8);
    d.hop = { x0: d.x, z0: d.z, h0: d.heading, x1: tx, z1: tz, dh, s0, s1, arc, dur, t: 0, then: then || null };
    setState(d, 'hop', dur + 1); d.pose = 'stand'; d.speed = 0; d.faceH = null; d.escT = 0; d.way = 0;
  }
  function land(d, sp) {
    d.target = null; d.spot = sp; d.spotY = sp.seatY; sp.claim = d;
    if (sp.kind === 'sofa') { d.onSofa = true; d.sofa = sp; } else d.bed = sp;
    if (!stillFits(d, sp)) { leaveSpot(d); return; } // the spot changed while we were in the air
    startLie(d, 6 + Math.random() * 8); d.nextDecision = () => startSleep(d, (evening() ? 60 : 30) + Math.random() * 45);
  }
  function hopOnto(d, sp) {
    const st = canon(d, 'stand'), lb = canon(d, sp.kind === 'bed' ? sp.poses[0] : 'stand');
    setNear(sp.px, sp.pz, 1.4);
    if (pen(d, sp.px, sp.pz, sp.ph, sp.seatY - lb.footLo, lb, 8, 1e-4) > 1e-4) return false; // the other dog lies there
    if (!hopPathClear(d, d.x, d.z, d.heading, sp.px, sp.pz, sp.ph, st)) return false;
    startHop(d, sp.px, sp.pz, sp.ph, 0, sp.seatY, () => land(d, sp));
    return true;
  }
  function leaveSpot(d, then) {
    const sp = d.spot; if (!sp) return false;
    const st = canon(d, 'stand'), k = gCell(d.x, d.z); let f = null;
    if (k >= 0 && Math.max(0, W.hi[k]) < sp.seatY - 0.05) { // the seat is gone from under the dog: it stands on the floor where it is
      setNear(d.x, d.z, 1.4);
      if (pen(d, d.x, d.z, d.heading, -st.footLo, st, 15, 1e-4) <= 1e-4) {
        if (sp.claim === d) sp.claim = null;
        d.spot = null; d.onSofa = false; d.sofa = null; d.bed = null;
        if (sp.kind === 'sofa') d.sofaCool = 60 + Math.random() * 90; else d.bedCool = 40 + Math.random() * 60;
        startHop(d, d.x, d.z, d.heading, sp.seatY, 0, then, 0, 0.3);
        return true;
      }
    }
    if (sp.ok && Math.hypot(sp.px - d.x, sp.pz - d.z) < 0.05) {
      const th = Math.atan2(sp.jx - d.x, sp.jz - d.z);
      setNear(sp.jx, sp.jz, 1.4);
      if (pen(d, sp.jx, sp.jz, th, -st.footLo, st, 15, 1e-4) <= 1e-4 && hopPathClear(d, d.x, d.z, d.heading, sp.jx, sp.jz, th, st)) f = [sp.jx, sp.jz, th];
    }
    if (!f) f = findFree(d, d.x, d.z, d.heading, 2.4);
    if (!f) return false;
    if (sp.claim === d) sp.claim = null;
    d.spot = null; d.onSofa = false; d.sofa = null; d.bed = null;
    if (sp.kind === 'sofa') d.sofaCool = 60 + Math.random() * 90; else d.bedCool = 40 + Math.random() * 60;
    startHop(d, f[0], f[1], f[2], sp.seatY, 0, then);
    return true;
  }
  function escape(d) {
    const f = findFree(d, d.x, d.z, d.heading, 2.4); if (!f) return false;
    releaseClaims(d); d.goal = -1;
    startHop(d, f[0], f[1], f[2], 0, 0, () => idle(d, 0.8));
    return true;
  }
  // a door leaf (or a door shutting) ran into a dog: the door waits, the dog gets out of its way
  function makeWay(d, g) {
    if (d.spot) { leaveSpot(d); return; }
    const s = Math.sign((d.x - g.mid[0]) * g.nrm[0] + (d.z - g.mid[1]) * g.nrm[1]) || 1;
    d.wayX = g.nrm[0] * s; d.wayZ = g.nrm[1] * s; d.way = 0.7;
    if (d.state === 'sleep' || d.state === 'lie' || d.state === 'sit' || d.state === 'sniff' || d.state === 'scratch' || d.state === 'yawn') { d.sleepy = 0; idle(d, 1); }
  }
  function arrive(d) {
    const n = nav.nodes[d.goal], kind = d.goalKind;
    d.goal = -1;
    if ((kind === 'bed' || kind === 'sofa') && n && n.spot) {
      const sp = n.spot;
      if (!sp.ok || (sp.claim && sp.claim !== d)) { d.target = null; return idle(d, 1); }
      sp.claim = d; d.target = sp; d.jumpT = 0; return setState(d, 'prejump', 0.6);
    }
    if (kind === 'bowls') { d.faceH = n.h; return setState(d, 'drink', 3 + Math.random() * 3); }
    if (kind === 'look') { d.faceH = n.h; return startSit(d, 5 + Math.random() * 8); }
    if (kind === 'sniff') return startSniff(d);
    if (kind === 'walker' || kind === 'come') { d.lookMode = 'walker'; return setState(d, 'happy', kind === 'come' ? 3.5 : 2.6); }
    if (kind === 'wait') { d.faceH = n.h; return startLie(d, 20 + Math.random() * 20); }
    idle(d, 1 + Math.random() * 3);
  }
  function doPet(d) {
    if (d.petCool > 0) return true;
    d.petCool = 0.6; d.petT = 3.2; d.happy = 1; d.lookMode = 'walker'; d.follow = false;
    d.sleepy = 0; d.stir = 1;
    if (d.state === 'sleep' || d.state === 'lie') { setState(d, 'wake', 1.2); d.pose = 'sit'; d.nextDecision = () => { setState(d, 'petted', 3); d.pose = 'sit'; }; }
    else if (d.state === 'hop') { /* let it land */ }
    else { setState(d, 'petted', 3.2); d.pose = d.spot ? 'sit' : (Math.random() < 0.3 ? 'bow' : 'sit'); d.bowT = d.pose === 'bow' ? 1.3 : 0; }
    const lines = PET_LINES[d.name] || [d.name + ' kwispelt'];
    toast(lines[(Math.random() * lines.length) | 0]);
    if (Math.random() < 0.6) bark(d.spec.pitch, 1 + (Math.random() < 0.4 ? 1 : 0));
    return true;
  }
  function call(name) {
    const d = byName(name) || dogs[0], w = walker();
    if (!w || w.l !== 0) { toast(d.name + ' kan je daar niet vinden'); return false; }
    d.follow = true; d.followT = 30;
    if (d.spot) { if (leaveSpot(d, () => { if (!goToWalker(d, 'come')) idle(d, 1); })) { toast(d.name + ' komt eraan'); return true; } }
    else if (d.state !== 'hop' && goToWalker(d, 'come')) { toast(d.name + ' komt eraan'); if (Math.random() < 0.5) bark(d.spec.pitch, 1); return true; }
    toast(d.name + ' kan niet bij je komen'); return false;
  }
  // walk to a point ~1.1 m from the walker, on the dog's side; behind a shut door the dog comes as far as the door and waits
  function goToWalker(d, kind) {
    const w = walker(); if (!w || w.l !== 0) return false;
    let dx = d.x - w.x, dz = d.z - w.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const tx = w.x + dx * 1.1, tz = w.z + dz * 1.1;
    if (nav.blocked(tx, tz, DOG_R)) { // fall back to the nearest node to the walker
      const n = nav.nearestNode(w.x, w.z, DOG_R - 0.03); if (n < 0) return false; return planTo(d, n, kind) || planTo(d, n, kind, true);
    }
    const wn = nav.nodes[N_WALKER]; // temporary node: the walker slot is a moving target
    wn.x = tx; wn.z = tz; wn.h = Math.atan2(w.x - tx, w.z - tz);
    const from = nav.nearestNode(d.x, d.z, DOG_R - 0.03), to = nav.nearestNode(tx, tz, DOG_R - 0.03);
    if (from < 0 || to < 0) return false;
    const n = nav.route(from, to, d.path) || nav.route(from, to, d.path, true); if (!n) return false;
    d.pathLen = n; d.pathIdx = 0; d.goal = N_WALKER; d.goalKind = kind; d.stuckT = 0; d.lastProg = 1e9;
    if (n < d.path.length) { d.path[n] = N_WALKER; d.pathLen = n + 1; }
    setState(d, 'walk', 10 + n * 4); d.pose = 'stand';
    return true;
  }

  // ---- events: greet when you walk into a dog's room
  const unsubs = [];
  if (H && H.on) {
    unsubs.push(H.on('room', (id, ev) => {
      const w = walker();
      if (!id || !ev || ev.source !== 'walk' || ev.level !== 0 || !w) return;
      let best = null, bd = 1e9;
      for (const d of dogs) { if (d.room !== id || d.greetCool > 0 || d.state === 'hop') continue; const dd = Math.hypot(d.x - w.x, d.z - w.z); if (dd < bd) { bd = dd; best = d; } }
      if (!best) return;
      best.greetCool = 45 + Math.random() * 30;
      if (best.state === 'sleep') { best.stir = 1; best.sleepy = 0.3; best.timer = Math.min(best.timer, 6); best.lookMode = 'walker'; return; }
      if (best.spot) { best.lookMode = 'walker'; best.happy = 0.6; return; }
      if (goToWalker(best, 'walker')) { best.happy = 1; best.speed = 0; }
    }));
    // the host swapped walls and doors (the kitchen toggle): new grid, new graph, plan again
    unsubs.push(H.on('kitchen', () => refreshNav()));
  }
  // (clicks, taps and the E key reach pet() through the app's own picker: HOUSE.dogs.pet(hit.object))

  // ---- behaviour (per frame): sets the wanted heading / speed; move() turns that into motion that keeps the body free
  const TURN = 4.0;
  function steer(d, tx, tz, dt, maxSpeed) { // returns distance to target
    const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz), err = wrapAngle(want - d.heading);
    d.heading = wrapAngle(d.heading + clamp(err, -TURN * dt, TURN * dt));
    const c = Math.max(0, Math.cos(err));
    d.speed = damp(d.speed, maxSpeed * c * c * clamp(dist / 0.45, 0.25, 1), 5, dt);
    return dist;
  }
  function behave(d, dt) {
    d.timer -= dt; d.petCool -= dt; d.greetCool -= dt; d.bedCool -= dt; d.sofaCool -= dt;
    if (d.petT > 0) d.petT -= dt;
    const w = walker(), wd = w && w.l === 0 ? Math.hypot(w.x - d.x, w.z - d.z) : 99;
    let moving = false;
    switch (d.state) {
      case 'idle':
        if (d.follow && w && w.l === 0 && walkMode()) {
          d.followT -= dt; if (d.followT <= 0) d.follow = false;
          if (wd > 2.6 && d.timer <= 0) { if (!goToWalker(d, 'follow')) idle(d, 2); break; }
          if (wd < 6) d.lookMode = 'walker';
        } else if (d.follow && w && w.l > 0 && d.timer <= 0) { d.follow = false; if (Math.random() < 0.5 && planTo(d, N_STAIRS, 'wait')) break; }
        if (d.timer <= 0) { if (d.spot) { if (!leaveSpot(d)) startLie(d, 5); } else decide(d); }
        break;
      case 'walk': {
        if (d.pathIdx >= d.pathLen) { arrive(d); break; }
        const n = nav.nodes[d.path[d.pathIdx]], last = d.pathIdx === d.pathLen - 1;
        if (!n || n.kind === 'dead') { releaseClaims(d); idle(d, 0.5); break; }
        // the next waypoint is a doorway that is shut (or shutting): stop short of the leaf and wait
        if (n.kind === 'door' && !nav.passable(n.door) && Math.hypot(n.x - d.x, n.z - d.z) < 1.05) { setState(d, 'waitdoor', 0); d.pose = 'stand'; d.waitT = 0; d.waitNode = n; d.toasted = false; d.speed = 0; break; }
        const spd = d.goalKind === 'walker' || d.goalKind === 'come' ? d.spec.trot : d.goalKind === 'follow' ? d.spec.speed * 1.3 : d.spec.speed;
        const dist = steer(d, n.x, n.z, dt, spd);
        moving = true;
        if (dist < (last ? 0.1 : 0.3)) { d.pathIdx++; d.stuckT = 0; d.lastProg = 1e9; if (last) { d.speed *= 0.5; } }
        if (d.goalKind === 'follow' && wd < 1.4) { d.speed = 0; idle(d, 1 + Math.random()); d.lookMode = 'walker'; break; }
        if ((d.goalKind === 'walker' || d.goalKind === 'come') && wd < 1.25) { arrive(d); break; }
        if (dist < d.lastProg - 0.02) { d.lastProg = dist; d.stuckT = 0; } else { d.stuckT += dt; if (d.stuckT > 1.6) { releaseClaims(d); idle(d, 1); } }
        if (d.timer <= 0) { releaseClaims(d); idle(d, 1); }
        break;
      }
      case 'waitdoor': { // at a shut door: face it, sit down after a moment, whine now and then, carry on once it opens
        const n = d.waitNode, wt0 = d.waitT; d.waitT += dt;
        if (!n || n.kind !== 'door') { idle(d, 1); break; }
        d.faceH = Math.atan2(n.x - d.x, n.z - d.z);
        if (nav.passable(n.door)) { setState(d, 'walk', 8 + (d.pathLen - d.pathIdx) * 5); d.pose = 'stand'; d.stuckT = 0; d.lastProg = 1e9; break; }
        if (wt0 < 1 && d.waitT >= 1 && d.goal >= 0 && d.goal !== N_WALKER && planTo(d, d.goal, d.goalKind)) break; // another way round
        if (d.waitT > 1.6 && d.pose !== 'sit') d.pose = 'sit';
        if (d.waitT > 2.2 && !d.toasted && wd < 6) { d.toasted = true; toast(d.name + ' wacht bij de deur'); }
        if (d.waitT > 3 && Math.random() < dt * 0.1) { whine(d.spec.pitch); d.lookMode = wd < 7 ? 'walker' : 'random'; d.lookT = 2; }
        if (d.waitT > 16 + 6 * Math.random()) { // nobody comes: give up on this route
          releaseClaims(d); d.goal = -1;
          if (d.goalKind === 'come' || d.goalKind === 'walker' || d.goalKind === 'follow' || !wander(d)) startLie(d, 12 + Math.random() * 15);
        }
        break;
      }
      case 'sniff':
        d.heading = wrapAngle(d.heading + d.circleDir * 0.35 * dt * (0.5 + 0.5 * Math.sin(d.timer * 1.3)));
        d.speed = damp(d.speed, 0.16, 3, dt); moving = true;
        if (d.timer <= 0) { d.sniff = 0; idle(d, 1 + Math.random() * 2); }
        break;
      case 'sit':
        if (d.timer <= 0) {
          const r = Math.random();
          if (r < 0.22) { setState(d, 'scratch', 1.6 + Math.random()); d.pose = 'scratch'; }
          else if (r < 0.4) { setState(d, 'yawn', 1.8); d.yawnT = 0; }
          else if (r < 0.6) startLie(d, 6 + Math.random() * 10);
          else idle(d, 1);
        }
        break;
      case 'scratch': if (d.timer <= 0) startSit(d, 1.5 + Math.random() * 3); break;
      case 'yawn': d.yawnT += dt; if (d.timer <= 0) { if (d.pose === 'sit') startSit(d, 1 + Math.random() * 3); else idle(d, 1); } break;
      case 'lie':
        if (d.timer <= 0) {
          if (d.nextDecision) { const f = d.nextDecision; d.nextDecision = null; f(); break; }
          if (d.spot || Math.random() < (evening() ? 0.6 : 0.35)) startSleep(d, (evening() ? 45 : 20) + Math.random() * 30);
          else if (Math.random() < 0.5) startSit(d, 2 + Math.random() * 3);
          else idle(d, 1);
        }
        break;
      case 'sleep':
        d.sleepT += dt;
        if (d.timer > 10 && d.sleepT > 15 && Math.random() < dt * 0.012) { d.pose = d.pose === 'donut' ? (Math.random() < 0.6 ? 'side' : 'curl') : 'donut'; d.stir = 0.6; d.sleepT = 0; } // shift in your sleep
        if (d.timer <= 0) { d.sleepy = 0; setState(d, 'wake', 2.5); d.pose = 'sit'; d.nextDecision = null; }
        break;
      case 'wake':
        if (d.timer <= 0) {
          if (d.nextDecision) { const f = d.nextDecision; d.nextDecision = null; f(); break; }
          if (d.onSofa && Math.random() < 0.5) { startSit(d, 4 + Math.random() * 6); break; }
          if (d.spot && leaveSpot(d)) break;
          if (!d.spot && Math.random() < 0.75) { setState(d, 'stretch', 1.8); d.pose = 'stretch'; break; }
          idle(d, 0.5);
        }
        break;
      case 'stretch': // a long bow after a nap, then a shake
        if (d.timer <= 0) { if (Math.random() < 0.7) { setState(d, 'shake', 1.1); d.pose = 'stand'; d.shakeT = 0; } else idle(d, 0.5); }
        break;
      case 'shake': d.shakeT += dt; if (d.timer <= 0) idle(d, 1); break;
      case 'prejump': { // at the jump point: face the bed / seat, then hop up (waits a moment if the way is not clear)
        const sp = d.target;
        if (!sp || !sp.ok || (sp.claim && sp.claim !== d)) { d.target = null; idle(d, 1); break; }
        d.faceH = Math.atan2(sp.px - d.x, sp.pz - d.z);
        if (d.timer <= 0 && Math.abs(wrapAngle(d.faceH - d.heading)) < 0.2) {
          if (hopOnto(d, sp)) break;
          if ((d.jumpT += dt) > 3) { sp.claim = null; d.target = null; idle(d, 1); }
        }
        break;
      }
      case 'hop': {
        const hp = d.hop; if (!hp) { idle(d, 0.5); break; }
        hp.t = Math.min(hp.dur, hp.t + dt);
        const t = hp.t / hp.dur, e = t * t * (3 - 2 * t);
        d.x = lerp(hp.x0, hp.x1, e); d.z = lerp(hp.z0, hp.z1, e); d.heading = wrapAngle(hp.h0 + hp.dh * e);
        if (hp.t >= hp.dur) { d.hop = null; d.hopEnd = hp; const f = hp.then; if (f) f(); else idle(d, 0.8); if (d.state === 'hop' && !d.hop) idle(d, 0.8); }
        break;
      }
      case 'drink':
        if (d.timer <= 0) { if (Math.random() < 0.5) startSniff(d); else idle(d, 1); }
        break;
      case 'happy': // arrived at the walker: wag, maybe a play bow, then sit and look up
        d.lookMode = 'walker'; d.happy = 1;
        if (d.bowT <= 0 && d.timer > 1.2 && d.pose === 'stand' && Math.random() < dt * 1.5) { d.pose = 'bow'; d.bowT = 1.2; }
        if (d.bowT > 0) { d.bowT -= dt; if (d.bowT <= 0) d.pose = 'sit'; }
        if (w && wd > 0.45) d.faceH = Math.atan2(w.x - d.x, w.z - d.z);
        if (d.timer <= 0) { d.pose = 'stand'; idle(d, 1.5); d.follow = Math.random() < 0.6; d.followT = 20 + Math.random() * 20; }
        break;
      case 'petted':
        d.lookMode = 'walker'; d.happy = 1;
        if (d.bowT > 0) { d.bowT -= dt; if (d.bowT <= 0) d.pose = 'sit'; }
        if (!d.spot && w && wd > 0.4) d.faceH = Math.atan2(w.x - d.x, w.z - d.z);
        if (d.timer <= 0) { if (d.spot) { startLie(d, 4 + Math.random() * 6); } else { startSit(d, 1 + Math.random() * 2); d.follow = true; d.followT = 20; } }
        break;
      default: idle(d, 1);
    }
    if (!moving && d.state !== 'hop') d.speed = damp(d.speed, 0, 9, dt);
    if (d.state === 'hop' || d.spot) { d.faceH = null; return; }
    if (d.faceH != null && d.state !== 'walk') { const err = wrapAngle(d.faceH - d.heading); d.heading = wrapAngle(d.heading + clamp(err, -TURN * dt, TURN * dt)); if (Math.abs(err) < 0.03) d.faceH = null; }
    // make way for the walker: never stand in their path; wake up when stepped over
    const standing = d.state === 'idle' || d.state === 'sit' || d.state === 'sniff' || d.state === 'happy' || d.state === 'walk' || d.state === 'waitdoor' || d.state === 'drink';
    if (w && w.l === 0 && wd < 0.62 && wd > 1e-3 && standing) {
      const k = (0.62 - wd) * 3.5; d.pushX += ((d.x - w.x) / wd) * k; d.pushZ += ((d.z - w.z) / wd) * k;
      if (d.state === 'sit' && wd < 0.45) idle(d, 0.8);
    } else if (w && w.l === 0 && wd < 0.5 && (d.state === 'lie' || d.state === 'sleep')) { d.sleepy = 0; setState(d, 'wake', 0.6); d.pose = 'sit'; }
    if (d.way > 0) { d.way -= dt; d.pushX += d.wayX * 0.6; d.pushZ += d.wayZ * 0.6; }
  }
  // motion: the wanted step is tried whole, then sliding along x or z, then only moving or only turning; whatever keeps the
  // body out of everything (or at least no deeper in than it was) wins. Then an eased push out of anything it is in.
  const CAND = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  function move(d, dt) {
    const ox = d.ox, oz = d.oz, oh = d.oh, body = d.body, lift = d.lift;
    let nh = d.heading; const dh = wrapAngle(nh - oh), mh = 6.5 * dt; if (Math.abs(dh) > mh) nh = wrapAngle(oh + Math.sign(dh) * mh);
    let mx = (Math.sin(nh) * d.speed + d.pushX) * dt, mz = (Math.cos(nh) * d.speed + d.pushZ) * dt;
    const ml = Math.hypot(mx, mz), cap = 2.2 * dt; if (ml > cap) { mx *= cap / ml; mz *= cap / ml; }
    setNear(ox, oz, 1.6);
    const p0 = pen(d, ox, oz, oh, lift, body, 15, 1e9), lim = p0 + 1e-4;
    let ax = ox, az = oz, ah = oh, ap = p0;
    if (ml > 1e-7 || nh !== oh) {
      const nx = ox + mx, nz = oz + mz, C = CAND;
      C[0][0] = nx; C[0][1] = nz; C[0][2] = nh; C[1][0] = nx; C[1][1] = oz; C[1][2] = nh; C[2][0] = ox; C[2][1] = nz; C[2][2] = nh; C[3][0] = nx; C[3][1] = nz; C[3][2] = oh;
      C[4][0] = ox; C[4][1] = oz; C[4][2] = nh; C[5][0] = nx; C[5][1] = oz; C[5][2] = oh; C[6][0] = ox; C[6][1] = nz; C[6][2] = oh;
      C[7][0] = ox - Math.sin(oh) * 0.15 * dt; C[7][1] = oz - Math.cos(oh) * 0.15 * dt; C[7][2] = oh; // back off a little
      for (let i = 0; i < 8; i++) {
        const c = C[i]; if ((c[0] === ox && c[1] === oz && c[2] === oh) || (i === 7 && d.state !== 'walk')) continue;
        const p = pen(d, c[0], c[1], c[2], lift, body, 15, lim);
        if (p <= lim) { ax = c[0]; az = c[1]; ah = c[2]; ap = p; break; }
      }
    }
    if (ap > 1e-4) {
      pen(d, ax, az, ah, lift, body, 15, 1e9);
      const pl = Math.hypot(PEN.px, PEN.pz), room = 2.3 * dt - Math.hypot(ax - ox, az - oz);
      if (pl > 1e-9 && room > 0) {
        const st = Math.min(PEN.max + 0.002, 1.2 * dt, room), tx = ax + (PEN.px / pl) * st, tz = az + (PEN.pz / pl) * st;
        const p = pen(d, tx, tz, ah, lift, body, 15, 1e9); if (p < ap) { ax = tx; az = tz; ap = p; }
      }
    }
    d.x = ax; d.z = az; d.heading = ah;
    // wedged (a door shut on it, furniture put down on top of it): hop out to the nearest free floor
    const pw = ap > 1e-4 ? pen(d, ax, az, ah, lift, body, 7, 1e9) : 0;
    if (pw > 1e-4 && (PEN.max > 0.05 || (pw > 0.005 && (d.escT += dt) > 1))) { d.escT = 0; escape(d); }
    else if (pw <= 0.005) d.escT = 0;
  }

  // ---- door watch: a door that would swing (or shut) into a dog stops where it is until the dog has moved out of the way
  const lastAng = new Map();
  function blocksDoor(d, g) {
    if (!d.placed || Math.hypot(g.mid[0] - d.x, g.mid[1] - d.z) > g.W + 1.4) return false;
    const b = d.body, B = b.bins, c = Math.cos(d.heading), s = Math.sin(d.heading), shut = doorShut(g.d), col = g.col;
    for (let i = 0; i < b.nb; i++) {
      const q = 5 * i, r = B[q + 2], wx = d.x + B[q] * c + B[q + 1] * s, wz = d.z - B[q] * s + B[q + 1] * c;
      if (!g.d.slide && leafDist(wx, wz, g, null) < r + LEAF_T + 0.005) return true;
      if (shut && circleBox(wx, wz, r, col[0], col[1], col[2], col[3]) > 0) return true;
    }
    return false;
  }
  function doorWatch() {
    for (const g of nav.doors) {
      const dd = g.d, a0 = lastAng.get(dd);
      if (a0 === undefined || a0 === dd.angle) { lastAng.set(dd, dd.angle); continue; }
      const hit = dogs.find((d) => blocksDoor(d, g));
      if (hit) { dd.angle = a0; poseDoorLeaf(dd); makeWay(hit, g); } else lastAng.set(dd, dd.angle);
    }
  }

  // ---- placement
  function choosePose(d, want) {
    const list = [want, ...(FALLBACK[want] || []), 'stand'];
    if (d.spot) { for (const p of list) if (p === 'stand' || d.spot.poses.includes(p)) return p; return 'stand'; }
    if (!d.placed) return want;
    setNear(d.x, d.z, 1.6);
    for (const p of list) { if (p === 'stand') return p; const b = canon(d, p); if (pen(d, d.x, d.z, d.heading, -b.footLo, b, 15, 1e-3) <= 1e-3) return p; }
    return 'stand';
  }
  function snapPose(d) { d.poseReq = d.pose; d.poseUse = choosePose(d, d.pose); for (const k of POSE_NAMES) d.poseW[k] = k === d.poseUse ? 1 : 0; }
  function settle(d) { // pose, measure, height and transform now (a dog put somewhere appears there correctly)
    pose(d, 0); measure(d); d.lift = (d.spot ? d.spot.seatY : 0) - d.body.footLo;
    d.ox = d.x; d.oz = d.z; d.oh = d.heading; d.vx = d.vz = d.om = 0;
    d.group.position.set(d.x, d.lift, d.z); d.group.rotation.y = d.heading; d.group.visible = true;
    d.room = nav.roomOf(d.x, d.z) || d.room;
  }
  function putOnSpot(d, sp, want, t) {
    if (!sp.ok || (sp.claim && sp.claim !== d)) return false;
    d.x = sp.px; d.z = sp.pz; d.heading = sp.ph; d.spot = sp; d.spotY = sp.seatY; sp.claim = d;
    if (sp.kind === 'sofa') { d.onSofa = true; d.sofa = sp; } else d.bed = sp;
    if (want === 'lie') { startLie(d, t); d.nextDecision = () => startSleep(d, 30 + Math.random() * 30); }
    else if (want === 'sit') startSit(d, t);
    else if (want === 'stand') idle(d, 1);
    else { startSleep(d, t, want); d.sleepy = 1; }
    d.placed = true; snapPose(d); settle(d);
    return true;
  }
  function putFree(d, x, z, h) {
    d.x = x; d.z = z; d.heading = h; d.placed = true; idle(d, 1 + Math.random());
    snapPose(d); settle(d);
    setNear(x, z, 1.6);
    if (pen(d, x, z, h, d.lift, d.body, 15, 1e-4) > 1e-4) { const f = findFree(d, x, z, h, 3); if (f) { d.x = f[0]; d.z = f[1]; d.heading = f[2]; settle(d); } }
  }
  // rest('Gemma', 'id') sends a dog to a bed; place('Logan', { bed: 'id' } | { sofa: 'room/bank' } | { x, z, heading, pose,
  // snap, time }) puts it somewhere at once (pose: stand, sit, lie, curl, donut, side)
  function place(name, o = {}) {
    const d = byName(name); if (!d) return false;
    if (!ready) { pending[d.name] = o; return true; }
    delete pending[d.name];
    if (d.spot && d.spot.claim === d) d.spot.claim = null;
    d.spot = null; d.onSofa = false; d.sofa = null; d.bed = null; d.hop = null; releaseClaims(d); d.target = null;
    d.goal = -1; d.goalKind = null; d.follow = false; d.nextDecision = null; d.speed = 0; d.faceH = null; d.way = 0; d.escT = 0;
    const t = Number.isFinite(o.time) ? o.time : 40 + Math.random() * 40;
    const sp = o.bed != null ? beds.find((b) => b.id === String(o.bed)) : o.sofa != null ? sofas.find((s) => s.id === String(o.sofa)) : null;
    if (sp) { if (putOnSpot(d, sp, o.pose || (sp.kind === 'bed' ? 'donut' : 'lie'), t)) return true; if (d.placed) return false; }
    if (o.bed != null || o.sofa != null) { if (!d.placed) putFree(d, d.x || 5.4, d.z || 6.3, d.heading); return false; }
    d.x = Number.isFinite(o.x) ? o.x : d.x; d.z = Number.isFinite(o.z) ? o.z : d.z; d.heading = Number.isFinite(o.heading) ? o.heading : d.heading;
    const p = o.pose || 'stand';
    if (p === 'sit') startSit(d, t); else if (p === 'lie') startLie(d, t); else if (p === 'curl' || p === 'donut' || p === 'side') { startSleep(d, t, p); d.sleepy = 1; } else idle(d, 1);
    d.placed = true;
    if (o.snap) snapPose(d);
    settle(d);
    return true;
  }
  const rest = (name, bedId) => { const d = byName(name); if (!d) return false; const b = bedId == null ? beds.find((x) => x.ok && (!x.claim || x.claim === d)) : beds.find((x) => x.id === String(bedId)); return goToBed(d, b); };

  // ---------------------------------------------------------------- animation
  const E = {}; for (const b of POSE_BONES) E[b] = [0, 0, 0]; // scratch eulers (reused)
  // footfall offsets in cycle fractions: walk = lateral sequence LH LF RH RF, trot = diagonal pairs
  const WALK_OFF = { armL: 0.25, thighR: 0.5, armR: 0.75, thighL: 0 };
  const TROT_OFF = { armL: 0, thighR: 0, armR: 0.5, thighL: 0.5 };
  const LEG_L = 0.455; // shoulder / hip pivot to the pad
  const U = new Float32Array(8);
  function pose(d, dt) {
    const P = d.P, B = P.byName, w = walker();
    if (d.pose !== d.poseReq) { d.poseReq = d.pose; d.poseUse = choosePose(d, d.pose); d.poseT = 2; }
    else if (d.poseUse !== d.poseReq && (d.poseT -= dt) <= 0) { d.poseUse = choosePose(d, d.pose); d.poseT = 2; }
    const pu = d.poseUse;
    // pose weights
    let sum = 0;
    const slow = pu === 'curl' || pu === 'donut' || pu === 'side';
    for (const k of POSE_NAMES) { const t = pu === k ? 1 : 0; d.poseW[k] = damp(d.poseW[k], t, slow || ((k === 'curl' || k === 'donut' || k === 'side') && d.poseW[k] > 0.01) ? 2.2 : 5, dt); sum += d.poseW[k]; }
    let rootY = 0, rootP = 0, rootR = 0;
    for (const b of POSE_BONES) { E[b][0] = 0; E[b][1] = 0; E[b][2] = 0; }
    for (const k of POSE_NAMES) {
      const wgt = d.poseW[k] / sum; if (wgt < 1e-3) continue;
      const p = POSES[k]; rootY += wgt * p.rootY; rootP += wgt * p.rootP; rootR += wgt * (p.rootR || 0);
      for (const b of POSE_BONES) { const r = p[b]; if (r) { E[b][0] += wgt * r[0]; E[b][1] += wgt * r[1]; E[b][2] += wgt * r[2]; } }
    }
    const standW = d.poseW.stand / sum, lying = (d.poseW.lie + d.poseW.curl + d.poseW.donut + d.poseW.side) / sum, sitW = d.poseW.sit / sum, ringW = (d.poseW.donut + d.poseW.side) / sum;

    // gait: every paw is planted while in stance (it moves under the body by exactly the ground speed at that paw, turning
    // included) and swung forward to its next footfall, half a stance ahead along its own ground track. Cadence follows the
    // fastest paw, so the stride shortens when walking slowly and the paws never skate.
    const L = LEG_L * d.scale, hc = Math.cos(d.heading), hs = Math.sin(d.heading), vlx = hc * d.vx - hs * d.vz, vlz = hs * d.vx + hc * d.vz;
    let ue = 0;
    for (let i = 0; i < 4; i++) { const ux = -vlx - d.om * PAW_REST[i][1] * d.scale, uz = -vlz + d.om * PAW_REST[i][0] * d.scale; U[2 * i] = ux; U[2 * i + 1] = uz; ue = Math.max(ue, Math.hypot(ux, uz)); }
    d.ue = damp(d.ue, ue, 12, dt);
    d.walkBlend = damp(d.walkBlend, d.hop ? 0 : standW * sstep(0.01, 0.06, d.ue), 10, dt);
    d.trotBlend = damp(d.trotBlend, sstep(0.8, 1.15, Math.hypot(d.vx, d.vz)), 4, dt);
    const stance = lerp(0.62, 0.5, d.trotBlend), A = Math.min(lerp(0.3, 0.36, d.trotBlend), 0.12 + d.ue * 0.3), sA = Math.sin(A); // short steps: the legs stay under the dog
    const f = d.ue > 0.02 ? (stance * d.ue) / (2 * L * sA) : d.walkBlend > 0.01 ? 0.5 : 0, Tst = f > 1e-4 ? stance / f : 0;
    d.phase = (d.phase + dt * f) % 1;
    const Wk = d.walkBlend, hp = d.hop, tuck = hp && hp.arc > 0 ? Math.sin(Math.PI * clamp(hp.t / hp.dur, 0, 1)) : 0, PW = d.paw;
    for (let i = 0; i < 4; i++) {
      const leg = LEGS[i], ux = U[2 * i], uz = U[2 * i + 1], o = 4 * i, side = leg.slice(-1);
      const ph = (d.phase + lerp(WALK_OFF[leg], TROT_OFF[leg], d.trotBlend)) % 1;
      let flex = 0;
      if (ph < stance) { d.pawSt[i] = 1; PW[o] += ux * dt; PW[o + 1] += uz * dt; }
      else {
        const sw = (ph - stance) / (1 - stance), e = sw * sw * (3 - 2 * sw);
        if (d.pawSt[i]) { d.pawSt[i] = 0; PW[o + 2] = PW[o]; PW[o + 3] = PW[o + 1]; }
        PW[o] = lerp(PW[o + 2], (-ux * Tst) / 2, e); PW[o + 1] = lerp(PW[o + 3], (-uz * Tst) / 2, e); flex = Math.sin(Math.PI * sw);
      }
      const pl = Math.hypot(PW[o], PW[o + 1]), lim = 0.55 * L; if (pl > lim) { PW[o] *= lim / pl; PW[o + 1] *= lim / pl; }
      const rz = Math.asin(clamp(PW[o] / L, -0.5, 0.5)), rx = Math.asin(clamp(-PW[o + 1] / (L * Math.cos(rz)), -0.6, 0.6));
      if (leg[0] === 'a') {
        E[leg][0] += rx * Wk + tuck * 0.9; E[leg][2] += rz * Wk;
        E['fore' + side][0] += -1.15 * flex * Wk - tuck * 1.5;
        E['paw' + side][0] += 0.65 * flex * Wk + tuck * 0.6;
      } else { // stifle flexes with the shin forward (+x), the hock with the foot back (-x)
        E[leg][0] += rx * Wk + tuck * 0.6; E[leg][2] += rz * Wk;
        E['shin' + side][0] += 0.9 * flex * Wk + tuck * 1.2;
        E['foot' + side][0] += -0.65 * flex * Wk - tuck * 0.9;
      }
    }
    const ph2 = d.phase * TAU * 2, bob = (0.008 * Math.sin(ph2) - 0.006 + 0.015 * d.trotBlend * Math.max(0, Math.sin(ph2 + 1))) * Wk;
    E.neck[0] += 0.07 * Wk + 0.035 * Math.sin(ph2 + 0.6) * Wk; // head carried up, nodding a little with the forelegs
    E.neck2[0] += -0.03 * Wk;
    if (d.state === 'shake') { // whole-body shake from the head back, dying out
      const k = Math.sin(d.shakeT * 40) * sstep(0, 0.12, d.shakeT) * (1 - sstep(0.6, 1.05, d.shakeT));
      E.head[2] += 0.55 * k; E.neck2[2] += 0.35 * k; E.neck[2] += 0.25 * k; E.chest[2] += 0.18 * k; E.spine[2] += 0.1 * Math.sin(d.shakeT * 40 - 0.8) * (1 - sstep(0.6, 1.05, d.shakeT));
      E.earL[2] += 0.7 * k; E.earR[2] += 0.7 * k; E.tail1[2] += 0.4 * k; E.neck[0] += 0.2 * sstep(0, 0.2, d.shakeT);
    }
    if (d.state === 'stretch' && pu === 'stretch') E.neck[0] += 0.15 * Math.sin(d.timer * 3);
    // hop arc: nose up on the way up, down on the way down
    if (hp && hp.arc > 0) { const t = clamp(hp.t / hp.dur, 0, 1); rootP += -0.5 * Math.cos(Math.PI * t) * (hp.s1 >= hp.s0 ? 1 : -1) * sstep(0, 0.2, Math.abs(hp.s1 - hp.s0)); }

    // breathing (ribs scale, slight chest lift); slow and deep while asleep, panting fast when happy / after a run
    d.pant = damp(d.pant, d.happy > 0.5 || d.petT > 0 ? 1 : 0, 1.5, dt);
    const rate = lerp(lerp(1.6, 3.2, Wk), 0.9, d.sleepy) + d.pant * 7;
    d.breath = (d.breath + dt * rate) % TAU;
    const br = Math.sin(d.breath), ribs = 1 + (0.02 + 0.012 * d.sleepy + 0.01 * Wk) * br;
    B.ribs.scale.set(ribs, ribs, 1); E.chest[0] += -0.012 * br * (1 - Wk); E.spine[0] += 0.01 * br * lying;

    // head: look targets (kept within the turns the pose was fitted for)
    d.lookT -= dt;
    const wd = w && w.l === 0 ? Math.hypot(w.x - d.x, w.z - d.z) : 99;
    if (d.lookT <= 0) {
      d.lookT = 1.5 + Math.random() * 3;
      const r = Math.random();
      if (d.lookMode === 'walker' && wd > 5) d.lookMode = 'random';
      if (wd < 3.5 && r < 0.55) d.lookMode = 'walker';
      else if (r < 0.72) d.lookMode = 'other';
      else if (d.lookMode !== 'walker' || r > 0.9) d.lookMode = 'random';
      if (d.lookMode === 'random') { d.lookYaw = (Math.random() * 2 - 1) * 0.7; d.lookPitch = (Math.random() - 0.5) * 0.4; d.lookTilt = Math.random() < 0.15 ? (Math.random() < 0.5 ? -0.3 : 0.3) : 0; }
      else d.lookTilt = Math.random() < 0.25 ? (Math.random() < 0.5 ? -0.25 : 0.25) : 0;
    }
    let yawT = d.lookYaw, pitchT = d.lookPitch, tiltT = d.lookTilt;
    if (d.lookMode === 'walker' && w && w.l === 0) {
      yawT = clamp(wrapAngle(Math.atan2(w.x - d.x, w.z - d.z) - d.heading), -1.0, 1.0);
      const dy = (w.y + 1.5) - (d.lift + 0.66 * d.scale); pitchT = clamp(-Math.atan2(dy, Math.max(0.4, wd)), -0.8, 0.3);
    } else if (d.lookMode === 'other') {
      const o = d.other; yawT = clamp(wrapAngle(Math.atan2(o.x - d.x, o.z - d.z) - d.heading), -1.0, 1.0); pitchT = 0.1;
    }
    if (d.state === 'walk') { const n = nav.nodes[d.path[Math.min(d.pathIdx, d.pathLen - 1)]]; if (n && d.lookMode !== 'walker') { yawT = clamp(wrapAngle(Math.atan2(n.x - d.x, n.z - d.z) - d.heading) * 0.6, -0.6, 0.6); pitchT = 0.1; } tiltT = 0; }
    if (d.state === 'sniff') { pitchT = 0.95; yawT = 0.25 * Math.sin(d.timer * 7) + 0.3 * Math.sin(d.timer * 2.1); tiltT = 0; }
    if (d.state === 'drink') { pitchT = 1.0; yawT = 0; tiltT = 0; }
    if (d.state === 'yawn') { const y = Math.sin(Math.PI * clamp(d.yawnT / 1.8, 0, 1)); pitchT = -0.45 * y; tiltT = 0; }
    if (d.petT > 0) { pitchT = Math.min(pitchT, -0.35) - 0.1 * Math.sin(d.petT * 5); tiltT = (d.index ? -1 : 1) * 0.3 * sstep(0, 0.5, d.petT); }
    if (d.state === 'scratch' && pu === 'scratch') { yawT = -0.4; pitchT = 0.2; tiltT = 0.4; }
    if (d.state === 'waitdoor' && d.lookMode !== 'walker') { yawT = 0.15 * Math.sin(d.waitT * 0.9); pitchT = -0.1; tiltT = d.waitT > 3 ? 0.2 * Math.sin(d.waitT * 0.4) : 0; }
    const sl = d.sleepy; yawT *= 1 - sl; pitchT = lerp(pitchT, 0.35, sl); tiltT *= 1 - sl;
    yawT = clamp(yawT, -0.6, 0.6); pitchT = clamp(pitchT, -0.8, 1.0); // the turns the collision shapes were measured with
    const lookRate = d.state === 'sniff' ? 10 : 5;
    d.hy = damp(d.hy, yawT, lookRate, dt); d.hp = damp(d.hp, pitchT, lookRate, dt); d.ht = damp(d.ht, tiltT, 4, dt);
    E.neck2[1] += d.hy * 0.4; E.head[1] += d.hy * 0.6; E.neck2[0] += d.hp * 0.45; E.head[0] += d.hp * 0.55; E.head[2] += d.ht;
    if (d.state === 'sniff') { E.head[0] += 0.05 * Math.sin(d.timer * 23); }
    if (d.state === 'sleep') { E.head[0] += 0.03 * br; }
    if (d.stir > 0) { d.stir = Math.max(0, d.stir - dt * 0.25); E.neck[0] -= 0.5 * sstep(0.2, 0.8, d.stir); E.head[0] -= 0.3 * sstep(0.2, 0.8, d.stir); }

    // tail: height by mood, wag by mood (thumps while lying when stirred)
    const happy = d.happy; d.happy = Math.max(0, d.happy - dt * 0.22);
    let wagT = 0.12 + happy * 0.6, upT = 0.15 + happy * 0.6;
    if (d.state === 'walk') { wagT += 0.15; upT += 0.25; }
    if (d.state === 'sniff') { upT = 0.1; wagT = 0.2; }
    if (d.state === 'sleep') { wagT = 0.02 + d.stir * 0.5; upT = -0.3; }
    if (d.state === 'lie') { wagT = 0.1 + d.stir * 0.5 + happy * 0.4; upT = -0.1; }
    if (d.petT > 0) { wagT = 0.9; upT = 0.7; }
    if (pu === 'bow') { upT = 1.0; wagT = 0.8; }
    if (d.state === 'scratch') { wagT = 0.05; }
    if (d.state === 'waitdoor') { wagT = d.lookMode === 'walker' ? 0.5 : 0.08; upT = 0.05; }
    if (d.state === 'stretch') { wagT = 0.2; upT = 0.6; }
    if (pu !== 'stand' && pu !== 'bow') { wagT = Math.min(wagT, 1); upT = clamp(upT, -0.3, 0.7); }
    d.wag = damp(d.wag, wagT, 4, dt); d.tailUp = damp(d.tailUp, upT, 3, dt);
    d.wagPhase = (d.wagPhase + dt * (6 + d.wag * 16)) % (TAU * 1000);
    for (let i = 0; i < 5; i++) {
      const tb = 'tail' + (i + 1), wv = Math.sin(d.wagPhase - i * 0.65) * d.wag * (i === 0 ? 0.45 : 0.3);
      E[tb][1] += wv; E[tb][2] += wv * 0.35;
      E[tb][0] += i === 0 ? d.tailUp * 0.9 : d.tailUp * 0.22 - 0.05 * lying;
    }

    // ears: hang, flick now and then, back when petted / submissive, perked when alert
    d.earFlickT -= dt;
    if (d.earFlickT <= 0) { d.earFlickT = 3 + Math.random() * 8; d.earFlick = 0.35; d.earSide = Math.random() < 0.5 ? 1 : -1; }
    if (d.earFlick > 0) d.earFlick -= dt;
    const flick = d.earFlick > 0 ? Math.sin((0.35 - d.earFlick) / 0.35 * Math.PI) : 0;
    const back = damp(d.earBack, d.petT > 0 || d.state === 'yawn' ? 1 : d.lookMode === 'walker' && d.state !== 'sleep' ? -0.35 : 0, 4, dt); d.earBack = back;
    const earSwing = 0.08 * Math.sin(ph2 + 1) * Wk;
    E.earL[0] += -0.55 * back + earSwing; E.earR[0] += -0.55 * back + earSwing;
    E.earL[2] += 0.15 + (d.earSide > 0 ? flick * 0.6 : 0) + 0.25 * d.pant; E.earR[2] += -0.15 - (d.earSide < 0 ? flick * 0.6 : 0) - 0.25 * d.pant;
    if (d.state === 'scratch' && pu === 'scratch') { E.earR[2] += -0.5 + 0.2 * Math.sin(d.timer * 40); E.shinR[0] += 0.5 * Math.sin(d.timer * 40); }

    // jaw: panting, yawning, lapping
    let jawT = d.pant * (0.22 + 0.06 * Math.sin(d.breath));
    if (d.state === 'yawn') jawT = 0.6 * Math.sin(Math.PI * clamp(d.yawnT / 1.8, 0, 1));
    if (d.state === 'drink') jawT = 0.12 + 0.1 * Math.sin(d.timer * 18);
    d.jaw = damp(d.jaw, jawT, 12, dt);
    B.jaw.rotation.x = d.jaw;

    // eyes: blink, sleepy half-lids, closed while asleep
    d.blinkT -= dt;
    if (d.blinkT <= 0) { d.blinkT = 2 + Math.random() * 5; d.blink = 0.16; }
    if (d.blink > 0) d.blink -= dt;
    const sleepyT = d.state === 'sleep' && d.stir < 0.2 && d.sleepT > 2 ? 1 : d.state === 'sleep' ? 0.5 : 0;
    d.sleepy = damp(d.sleepy, sleepyT, 0.9, dt);
    const closed = Math.max(d.blink > 0 ? Math.sin((0.16 - d.blink) / 0.16 * Math.PI) : 0, d.sleepy * 0.95, d.state === 'yawn' ? Math.sin(Math.PI * clamp(d.yawnT / 1.8, 0, 1)) : 0);
    { const es = 0.0092, ey = es * (1 - 0.92 * closed); P.eyes[0].scale.set(es, ey, es); P.eyes[1].scale.set(es, ey, es); }

    // apply (legs and tail are posed in world terms: compensate the pelvis pitch they inherit)
    E.armL[0] += rootP; E.armR[0] += rootP; E.thighL[0] += rootP; E.thighR[0] += rootP; E.tail1[0] += rootP;
    for (const b of POSE_BONES) B[b].rotation.set(E[b][0], E[b][1], E[b][2]);
    const R = B.root; R.position.set(0, rootY + bob + (d.state === 'scratch' && pu === 'scratch' ? 0.01 * Math.sin(d.timer * 40) : 0), -0.22); R.rotation.set(-rootP, 0, rootR);
    // contact shadow follows the footprint (a round blob under the curled-up dog, shifted to the curl side)
    const sh = P.shadow, sx = lerp(lerp(0.62, 0.7, lying) - 0.1 * sitW, 0.72, ringW), sz = lerp(lerp(0.42, 0.55, lying), 0.7, ringW);
    sh.scale.set(sx, sz, 1); sh.position.z = lerp(lerp(0, -0.05, lying) - 0.1 * sitW, 0.02, ringW); sh.position.x = 0.1 * ringW;
    sh.position.y = 0.006 - (d.lift + d.body.footLo) / d.scale; // on the support, wherever the body is
  }
  // height: the lowest point of the body rests on its support (floor, bed, seat), eased; in a hop it arcs between supports
  function liftStep(d, dt) {
    const hp = d.hop;
    if (hp) { const t = clamp(hp.t / hp.dur, 0, 1), e = t * t * (3 - 2 * t); d.lift = lerp(hp.s0, hp.s1, e) + hp.arc * Math.sin(Math.PI * t) - d.body.footLo; return; }
    const want = (d.spot ? d.spot.seatY : 0) - d.body.footLo, m = 1.9 * dt;
    d.lift += clamp(want - d.lift, -m, m);
  }

  // ---- per-frame update, with LOD (a still dog far away / off-screen is posed at a lower rate; it is always drawn where it is)
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sph = new THREE.Sphere(new THREE.Vector3(), 0.9);
  let disposed = false, frame = 0;
  function update(dt) {
    if (disposed) return;
    dt = clamp(dt || 0, 0, 0.1); frame++;
    if (!ensureWorld()) return;
    syncWorld(false);
    doorWatch();
    for (const d of dogs) {
      d.ox = d.x; d.oz = d.z; d.oh = d.heading; d.pushX = d.pushZ = 0;
      if (d.spot && !d.spot.ok && d.state !== 'hop') leaveSpot(d);
      behave(d, dt);
      if (d.state !== 'hop' && !d.spot && dt > 0) move(d, dt);
      d.room = nav.roomOf(d.x, d.z) || d.room;
    }
    const cam = H && H.camera;
    if (cam) { pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm); }
    for (let i = 0; i < dogs.length; i++) {
      const d = dogs[i];
      if (dt > 0) { d.vx = (d.x - d.ox) / dt; d.vz = (d.z - d.oz) / dt; d.om = wrapAngle(d.heading - d.oh) / dt; }
      const still = !d.hop && Math.hypot(d.vx, d.vz) < 0.01 && Math.abs(d.om) < 0.05 && d.walkBlend < 0.01;
      let stride = 1;
      if (cam && still) {
        sph.center.set(d.x, d.lift + 0.35, d.z); const cp = cam.position;
        d.dist = Math.hypot(cp.x - d.x, cp.y - d.lift - 0.35, cp.z - d.z);
        d.visible = frustum.intersectsSphere(sph);
        stride = !d.visible ? 6 : d.dist > 16 ? 4 : d.dist > 7 ? 2 : 1;
        if (H && H.mode === 'doll') stride = Math.max(stride, 2);
      }
      d.lodAcc += dt;
      if (stride === 1 || (frame + i) % stride === 0) { pose(d, d.lodAcc); measure(d); d.lodAcc = 0; }
      liftStep(d, dt);
      d.group.position.set(d.x, d.lift, d.z); d.group.rotation.y = d.heading;
    }
  }
  const unsub = typeof onTick === 'function' ? onTick((dt) => update(dt)) : null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof unsub === 'function') unsub();
    for (const u of unsubs) { try { u(); } catch (e) { /* ignore */ } }
    for (const d of dogs) { scene.remove(d.group); ALL_DOGS.delete(d); }
    scene.remove(bed); scene.remove(bowls);
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
  }
  // the host changed its walls / doors / rooms outside the dogs' view (HOUSE 'kitchen' event): re-read everything now
  function refreshNav() { if (!ready) return; W.sync(true, 1e9); rebuildAll(); } // only the changed groups are rasterised
  const navApi = {
    nodes: nav.nodes, beds, sofas, doors: nav.doors, route: nav.route, nearestNode: nav.nearestNode, blocked: nav.blocked, segmentFree: nav.segmentFree,
    roomOf: nav.roomOf, doorOpen: nav.doorOpen, passable: nav.passable, refreshDoors: refreshNav, clearAt: nav.clearAt,
    // a query (tests, tools): catch up in one go, also before the idle first pass has finished
    furniture: () => { if (!ready) { W.sync(true, 1e9); ensureWorld(); } syncWorld(true, 1e9); return nav.furniture(); },
    stats: () => ({ rebuilds, parts: W.parts ? W.parts.size : 0 }),
  };
  // test hooks (tools/pw): lattice points of a spot, and why a pose does (not) fit at a place
  const _dbg = {
    pts: (sp) => { const a = []; spotCells(sp, (k, x, z) => { if (Math.abs(W.hi[k] - sp.seatY) < 0.015) a.push([x, z, Math.hypot(x - sp.x, z - sp.z)]); }); return a.sort((p, q) => p[2] - q[2]); },
    why: (n, p, x, z, h, seatY) => { const d = byName(n), body = canon(d, p); setNear(x, z, 1.4); const v = pen(d, x, z, h, seatY - body.footLo, body, 7, 1e9); return v > 1e-4 ? 'P' + (v * 100).toFixed(1) + '/' + (PEN.max * 100).toFixed(1) : fitsOn(d, body, x, z, h, seatY) ? 'ok' : 'low'; },
    canon: (n, p) => canon(byName(n), p), W,
  };
  // setObstacles: kept for older hosts; the dogs see the furniture themselves now
  return { dogs, bed, bowls, beds, addBed, removeBed, rest, place, dispose, pet, call, update, setObstacles: () => {}, refreshNav, nav: navApi, POSES, ready: () => ready, _dbg };
}
