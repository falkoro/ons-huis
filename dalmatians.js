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
function furGrain(g, W, H, rand) {
  g.lineWidth = 1;
  const n = Math.round((W * H) / 60);
  for (let i = 0; i < n; i++) {
    const x = rand() * W, y = rand() * H, l = 1 + rand() * 3;
    g.strokeStyle = rand() < 0.5 ? 'rgba(150,140,125,0.09)' : 'rgba(255,255,255,0.35)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 1.5, y + l); g.stroke();
  }
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
  const rim = [[0.40, 0.0], [0.435, 0.03], [0.45, 0.085], [0.44, 0.14], [0.41, 0.175], [0.37, 0.19], [0.325, 0.175], [0.30, 0.14], [0.285, 0.1], [0.275, 0.06]];
  const cushion = [[0.29, 0.02], [0.3, 0.06], [0.285, 0.085], [0.22, 0.095], [0.1, 0.1], [0.0, 0.1]];
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

// ================================================================ NAVIGATION (ground floor)
// Walls come from HOUSE.colliders, doors from HOUSE.doors (leaf geometry mirrors buildDoor: hinge 5.3 cm in from the
// opening's low end at the wall centre, leaf length W = opening - 10.6 cm, 4.2 cm thick, pointing (cos th, -sin th) with
// th = base + dir * angle; 5 cm jambs at both ends). Furniture the dogs must walk around is listed here (the house keeps
// no colliders for furniture). Points of interest + door passages (gap centre + an approach node either side) form a
// small waypoint graph; a door is only routed through when it is open past DOOR_PASS and not closing.
const DOG_R = 0.17, DOOR_PASS = 1.2, DOOR_OPEN_ANG = 1.45, LEAF_R = DOG_R + 0.021 + 0.035;
// Woonkamer furniture, used only when the host passes no opts.obstacles (the v2 app passes its live footprints).
const WOONKAMER_FURNITURE = [
  [6.06, 6.98, 7.75, 10.05], [5.04, 5.66, 8.33, 9.48], [3.95, 4.75, 10.2, 11.0], [7.85, 8.75, 4.55, 5.45], [3.25, 3.6, 7.9, 8.9],
  [3.25, 3.6, 4.8, 6.4], [4.3, 6.0, 0.25, 2.25], [6.5, 6.9, 10.25, 10.65], [8.55, 8.95, 4.2, 4.6], [6.42, 6.82, 11.7, 12.1],
  [3.42, 3.82, 4.25, 4.65], [8.5, 8.9, 7.0, 7.4],
];
// Furniture in the other ground-floor rooms (the host only tracks the woonkamer): zitkamer corner sofa + table + media wall,
// floor lamp, plants, the hall bench and the food bowls. The office corner comes from HOUSE.office.obstacles (host).
const EXTRA_FURNITURE = [
  [0.05, 0.95, 0.4, 2.5], [0.95, 2.0, 0.4, 1.3], [1.1, 2.0, 1.7, 2.2], [3.2, 3.62, 0.3, 2.3], [0.15, 0.45, 2.63, 2.93], [0.1, 0.6, 3.2, 3.7],
  [7.07, 7.5, 9.35, 10.45], [8.2, 8.65, 10.8, 11.3],
  [7.8, 8.35, 0.15, 0.55],
];
// rest spots (dog beds): { id, x, z, y (cushion top), r, heading, room }. The woonkamer mand is built here; the host adds
// more with dogs.addBed() (e.g. the green bean bag in the zitkamer office corner).
const BED_X = 3.8, BED_Z = 7.0, BED_R = 0.45, BED_TOP = 0.09;
const MAND = { id: 'mand', x: BED_X, z: BED_Z, y: BED_TOP, r: BED_R, heading: -Math.PI / 2 - 0.4, room: 'woonkamer' };
// sofa spots: { x, z, y, heading } on the seat; a hop-off point on the floor is found automatically (or given as from: { x, z })
const WOONKAMER_SOFA = { id: 'bank', x: 6.45, z: 9.6, y: 0.495, heading: -Math.PI / 2 + 0.3, item: 'bank' };
// points of interest: [id, x, z, facing heading, room, kind]
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
// leaf geometry of a host door (see the header note); posts = the two jambs, openRect = the fully open leaf as a box
function doorGeom(d) {
  const c = d.col, ax = c[1] - c[0] > c[3] - c[2] ? 'x' : 'z', a = ax === 'x' ? c[0] : c[2], b = ax === 'x' ? c[1] : c[3];
  const c0 = (ax === 'x' ? c[2] : c[0]) + 0.03, c1 = (ax === 'x' ? c[3] : c[1]) - 0.03, cm = (c0 + c1) / 2, W = b - a - 0.106;
  const hx = ax === 'x' ? a + 0.053 : cm, hz = ax === 'x' ? cm : a + 0.053;
  const posts = ax === 'x' ? [[a, a + 0.05, c0 - 0.01, c1 + 0.01], [b - 0.05, b, c0 - 0.01, c1 + 0.01]] : [[c0 - 0.01, c1 + 0.01, a, a + 0.05], [c0 - 0.01, c1 + 0.01, b - 0.05, b]];
  const th = d.base + d.dir * DOOR_OPEN_ANG, ex = hx + Math.cos(th) * W, ez = hz - Math.sin(th) * W;
  const openRect = [Math.min(hx, ex) - 0.03, Math.max(hx, ex) + 0.03, Math.min(hz, ez) - 0.03, Math.max(hz, ez) + 0.03];
  const mid = ax === 'x' ? [(a + b) / 2, cm] : [cm, (a + b) / 2], nrm = ax === 'x' ? [0, 1] : [1, 0];
  return { d, ax, hx, hz, W, posts, openRect, mid, nrm, col: c };
}
// distance from (x,z) to a leaf's centre line at its live angle, and the push direction out of it
function leafDist(x, z, g, out) {
  const th = g.d.base + g.d.dir * g.d.angle, dx = Math.cos(th), dz = -Math.sin(th), ex = x - g.hx, ez = z - g.hz;
  const t = clamp(ex * dx + ez * dz, 0, g.W), px = ex - dx * t, pz = ez - dz * t, l = Math.hypot(px, pz);
  if (out) { if (l > 1e-6) { out[0] = px / l; out[1] = pz / l; } else { out[0] = -dz; out[1] = dx; } }
  return l;
}

function makeNav(H, opts) {
  const walls = H && H.colliders ? H.colliders[0] : [];
  const roomOf = (x, z) => (H && H.roomAt ? H.roomAt(0, x, z) : 'woonkamer');
  // walls is the host's live list (the "Nieuwe keuken" toggle splices it in place); doors are re-read by refreshDoors()
  const doors = [], posts = [], doorCols = [], openRects = [];
  function readDoors() {
    doors.length = posts.length = doorCols.length = openRects.length = 0;
    for (const d of H && H.doors ? H.doors.filter((d) => d.l === 0 && d.col) : []) doors.push(doorGeom(d));
    for (const g of doors) { posts.push(...g.posts); doorCols.push(g.col); openRects.push(g.openRect); }
  }
  readDoors();
  const nodes = POIS.map((p, i) => ({ i, id: p[0], x: p[1], z: p[2], h: p[3], room: p[4], kind: p[5], door: null, spot: null, edges: [] }));
  // a dead slot (removed bed, door of the other kitchen variant) is reused, so node indexes stay valid and the graph stays small
  const addNode = (n) => { const k = nodes.findIndex((m) => m.kind === 'dead'); n.i = k >= 0 ? k : nodes.length; n.edges = []; nodes[n.i] = n; return n; };
  let furniture = [];
  const hits = (x, z, r, rects) => { for (let i = 0; i < rects.length; i++) { const c = rects[i]; if (x > c[0] - r && x < c[1] + r && z > c[2] - r && z < c[3] + r) return true; } return false; };
  const blocked = (x, z, r) => hits(x, z, r, walls) || hits(x, z, r, posts) || hits(x, z, r, openRects) || hits(x, z, r, furniture);
  const blockedRoute = (x, z, r) => blocked(x, z, r) || hits(x, z, r, doorCols); // generic edges never cross a doorway
  const segFree = (x0, z0, x1, z1, r, fn) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.08));
    for (let i = 0; i <= n; i++) if (fn(lerp(x0, x1, i / n), lerp(z0, z1, i / n), r)) return false;
    return true;
  };
  const segmentFree = (x0, z0, x1, z1, r) => segFree(x0, z0, x1, z1, r, blockedRoute);
  // door passages: a node in the gap centre, one approach node 0.75 m into each room, linked only to the gap node
  function addDoorNodes() {
    for (const g of doors) {
      const [mx, mz] = g.mid, [nx, nz] = g.nrm, side = [];
      for (const s of [1, -1]) for (const r of [0.75, 0.6, 0.9, 1.1]) { const x = mx + nx * r * s, z = mz + nz * r * s; if (!blocked(x, z, DOG_R) && roomOf(x, z)) { side.push([x, z, s]); break; } }
      if (side.length < 2) continue; // one side is outside: no passage
      const inner = side.map(([x, z, s]) => addNode({ id: 'a-' + g.hx.toFixed(1) + '/' + g.hz.toFixed(1) + (s > 0 ? '+' : '-'), x, z, h: 0, room: null, kind: 'via', door: null, spot: null }));
      g.node = addNode({ id: 'd-' + g.hx.toFixed(1) + '/' + g.hz.toFixed(1), x: mx, z: mz, h: 0, room: null, kind: 'door', door: g.d, geom: g, spot: null, near: inner.map((n) => n.i) });
    }
  }
  addDoorNodes();
  // the host swapped walls/doors (the "Nieuwe keuken" toggle): drop the door nodes, re-read the doors, rebuild the graph
  function refreshDoors() {
    for (const n of nodes) if (n.kind === 'door' || (n.kind === 'via' && n.id.startsWith('a-'))) { n.kind = 'dead'; n.door = null; }
    readDoors(); addDoorNodes(); placeSofaNodes(); rebuildEdges();
  }
  function rebuildEdges() {
    for (const n of nodes) n.edges.length = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.kind === 'walker' || b.kind === 'walker' || a.kind === 'door' || b.kind === 'door' || a.kind === 'dead' || b.kind === 'dead') continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 4.5 && segmentFree(a.x, a.z, b.x, b.z, DOG_R - 0.02)) { a.edges.push(j); b.edges.push(i); }
    }
    for (const n of nodes) if (n.kind === 'door') for (const j of n.near) { n.edges.push(j); nodes[j].edges.push(n.i); }
  }
  // furniture footprints: host list { x0, x1, z0, z1 } (woonkamer) + the fixed extras; the dog bed itself is never a wall
  function setObstacles(list) {
    const out = [];
    if (Array.isArray(list)) for (const o of list) {
      if (!o) continue;
      const r = Array.isArray(o) ? o : [o.x0, o.x1, o.z0, o.z1];
      if (!r.every(Number.isFinite)) continue;
      out.push([Math.min(r[0], r[1]), Math.max(r[0], r[1]), Math.min(r[2], r[3]), Math.max(r[2], r[3])]);
    } else out.push(...WOONKAMER_FURNITURE);
    out.push(...EXTRA_FURNITURE);
    furniture = out;
    rebuildEdges();
  }
  // beds: each is a node on its centre (never an obstacle: the dog walks onto it)
  const beds = [];
  function addBed(b) {
    if (!b || ![b.x, b.z].every(Number.isFinite)) return null;
    const id = String(b.id || 'bed' + beds.length); removeBed(id);
    const bed = { id, x: b.x, z: b.z, y: Number.isFinite(b.y) ? b.y : 0.08, r: Number.isFinite(b.r) ? b.r : 0.45, heading: Number.isFinite(b.heading) ? b.heading : 0, room: b.room || roomOf(b.x, b.z), claim: null, node: -1 };
    bed.node = addNode({ id: 'n-' + id, x: bed.x, z: bed.z, h: bed.heading, room: bed.room, kind: 'bed', door: null, spot: bed }).i;
    beds.push(bed); rebuildEdges();
    return bed;
  }
  function removeBed(id) {
    const k = beds.findIndex((b) => b.id === id); if (k < 0) return null;
    const bed = beds[k], n = nodes[bed.node]; n.kind = 'dead'; n.spot = null; beds.splice(k, 1); rebuildEdges();
    return bed;
  }
  // sofa spots: the host's spot (opts.sofa) plus the woonkamer bank; each gets a hop-off node on the floor next to it
  const sofas = [];
  const addSofa = (s) => {
    if (!s || ![s.x, s.z].every(Number.isFinite)) return;
    const spot = { id: s.id || 'sofa' + sofas.length, x: s.x, z: s.z, y: Number.isFinite(s.y) ? s.y : 0.45, heading: Number.isFinite(s.heading) ? s.heading : 0, item: s.item || null, claim: null, node: -1, jumpX: s.x, jumpZ: s.z, room: roomOf(s.x, s.z) };
    sofas.push(spot);
  };
  addSofa(opts && opts.sofa ? { ...opts.sofa, id: 'sofa' } : null);
  addSofa(WOONKAMER_SOFA);
  for (const s of sofas) s.node = addNode({ id: 'n-' + s.id, x: s.x, z: s.z, h: 0, room: null, kind: 'sofa', door: null, spot: s }).i;
  function placeSofaNodes() {
    for (const s of sofas) {
      const n = nodes[s.node], from = opts && opts.sofa && opts.sofa.from && s.id === 'sofa' ? opts.sofa.from : null;
      let bx = from ? from.x : NaN, bz = from ? from.z : NaN;
      if (!Number.isFinite(bx) || blocked(bx, bz, DOG_R)) {
        bx = NaN; let bd = 1e9;
        for (const r of [0.85, 1.05, 1.3]) for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU, x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
          if (blockedRoute(x, z, DOG_R + 0.02) || roomOf(x, z) !== s.room) continue;
          let ok = false; for (let j = 0; j < nodes.length && !ok; j++) if (nodes[j].kind !== 'sofa' && nodes[j].kind !== 'walker' && nodes[j].kind !== 'door' && nodes[j].kind !== 'dead' && Math.hypot(nodes[j].x - x, nodes[j].z - z) < 4 && segmentFree(x, z, nodes[j].x, nodes[j].z, DOG_R - 0.02)) ok = true;
          if (!ok) continue;
          const d = r + Math.abs(wrapAngle(a - s.heading)) * 0.05; if (d < bd) { bd = d; bx = x; bz = z; }
        }
      }
      if (!Number.isFinite(bx)) { bx = s.x; bz = s.z; }
      n.x = s.jumpX = bx; n.z = s.jumpZ = bz; n.h = Math.atan2(s.x - bx, s.z - bz); s.ok = !(bx === s.x && bz === s.z);
    }
  }
  addBed(MAND);
  if (opts && Array.isArray(opts.beds)) for (const b of opts.beds) addBed(b);
  if (H && Array.isArray(H.dogBeds)) for (const b of H.dogBeds) addBed(b);
  setObstacles(opts && opts.obstacles);
  placeSofaNodes(); rebuildEdges();
  // a doorway can be walked through when the leaf is open wide and not on its way shut
  const passable = (door) => !door || (door.open !== false && door.angle >= DOOR_PASS);
  const doorOpen = (n) => !n.door || passable(n.door);
  // Dijkstra (tiny graph; arrays reused). ignoreDoors routes through shut doors too (the dog then waits at the first one).
  const dist = new Float32Array(96), prev = new Int16Array(96), done = new Uint8Array(96);
  function route(from, to, out, ignoreDoors) { // out: Int16Array, returns length (path from -> ... -> to), 0 when unreachable
    const N = Math.min(nodes.length, 96);
    dist.fill(1e9); prev.fill(-1); done.fill(0); dist[from] = 0;
    for (;;) {
      let u = -1, best = 1e9;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === to) break;
      done[u] = 1;
      const e = nodes[u].edges;
      for (let k = 0; k < e.length; k++) { const v = e[k]; if (done[v] || (!ignoreDoors && !doorOpen(nodes[v]))) continue; const nd = best + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].z - nodes[v].z) + (nodes[v].kind === 'door' && !doorOpen(nodes[v]) ? 3 : 0); if (nd < dist[v]) { dist[v] = nd; prev[v] = u; } }
    }
    if (dist[to] >= 1e9) return 0;
    let n = 0, c = to; const tmp = out; // fill backwards then reverse
    while (c >= 0 && n < tmp.length) { tmp[n++] = c; c = prev[c]; }
    for (let i = 0, j = n - 1; i < j; i++, j--) { const t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t; }
    return n;
  }
  function nearestNode(x, z, r) { // nearest node reachable in a straight line (a dog standing in a doorway may cross it)
    let best = -1, bd = 1e9;
    for (const fn of [blockedRoute, blocked]) {
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n.kind === 'walker' || n.kind === 'dead' || (n.kind === 'door' && fn === blockedRoute)) continue; const d = Math.hypot(n.x - x, n.z - z); if (d < bd && segFree(x, z, n.x, n.z, r, fn)) { bd = d; best = i; } }
      if (best >= 0) break;
    }
    return best;
  }
  // circle vs obstacle resolution: walls, jambs, furniture (a dog already inside a footprint is let out gently), the shut
  // door box and every leaf as a capsule at its live angle, so a swinging leaf shoves the dog instead of passing through it
  const tmpN = [0, 0];
  function overlaps(x, z, r) {
    if (hits(x, z, r, walls) || hits(x, z, r, posts)) return true;
    for (let i = 0; i < doors.length; i++) { const g = doors[i]; if (leafDist(x, z, g, null) < LEAF_R - 0.01 || (g.d.angle < 0.3 && hits(x, z, r, [g.col]))) return true; }
    return false;
  }
  function resolve(d, r) {
    let dirty = false;
    for (let it = 0; it < 6; it++) {
      dirty = false;
      for (let i = 0; i < walls.length; i++) dirty = pushOut1(d, r, walls[i]) || dirty;
      for (let i = 0; i < posts.length; i++) dirty = pushOut1(d, r, posts[i]) || dirty;
      for (let i = 0; i < furniture.length; i++) pushOut1(d, r, furniture[i]);
      for (let i = 0; i < doors.length; i++) {
        const g = doors[i];
        if (g.d.angle < 0.3) dirty = pushOut1(d, r, g.col) || dirty;
        const l = leafDist(d.x, d.z, g, tmpN);
        if (l < LEAF_R) { d.x += tmpN[0] * (LEAF_R - l); d.z += tmpN[1] * (LEAF_R - l); dirty = true; }
      }
      if (!dirty) return;
    }
    if (overlaps(d.x, d.z, r)) escape(d, r); // wedged (a leaf closed onto a corner): hop to the nearest free spot
  }
  function escape(d, r) {
    for (let ring = 1; ring <= 10; ring++) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + ring * 0.4, rr = ring * 0.06, x = d.x + Math.cos(a) * rr, z = d.z + Math.sin(a) * rr;
      if (!overlaps(x, z, r)) { d.x = x; d.z = z; return true; }
    }
    return false;
  }
  function pushOut1(d, r, c) {
    const px = clamp(d.x, c[0], c[1]), pz = clamp(d.z, c[2], c[3]), ex = d.x - px, ez = d.z - pz, d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return false;
    if (d2 > 1e-10) { const l = Math.sqrt(d2); d.x += (ex / l) * (r - l); d.z += (ez / l) * (r - l); }
    else { const o0 = d.x - c[0] + r, o1 = c[1] - d.x + r, o2 = d.z - c[2] + r, o3 = c[3] - d.z + r, m = Math.min(o0, o1, o2, o3) * 0.5; if (m === o0 * 0.5) d.x -= m; else if (m === o1 * 0.5) d.x += m; else if (m === o2 * 0.5) d.z -= m; else d.z += m; }
    return true;
  }
  return { nodes, sofas, beds, doors, addBed, removeBed, route, nearestNode, resolve, overlaps, blocked, segmentFree, roomOf, doorOpen, passable, refreshDoors, setObstacles: (l) => { setObstacles(l); placeSofaNodes(); rebuildEdges(); }, furniture: () => furniture };
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
// Each pose lists [rx, ry, rz] per bone; unlisted bones are 0. Leg bones: rx > 0 swings the limb forward (about +X).
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

export function addDalmatians(THREE, scene, opts = {}) {
  const H = (typeof window !== 'undefined' && window.HOUSE) || opts.house || null;
  const onTick = opts.onTick || (H && H.onTick);
  const toast = (msg) => { try { if (H && H.ui && H.ui.toast) H.ui.toast(msg); } catch (e) { /* ignore */ } };
  const nav = makeNav(H, opts);
  const geos = [], mats = [], texs = [];
  const std = (p) => { const m = new THREE.MeshStandardMaterial(p); mats.push(m); return m; };

  // ---- shared resources
  const shared = {
    bump: furBump(THREE), rough: furRough(THREE), eyeGeo: new THREE.SphereGeometry(1, 16, 12), noseGeo: new THREE.SphereGeometry(1, 12, 9),
    eyeMat: new THREE.MeshPhysicalMaterial({ map: eyeTexture(THREE), roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 }),
    noseMat: new THREE.MeshPhysicalMaterial({ color: 0x141217, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.35 }),
    shadowGeo: new THREE.PlaneGeometry(1, 1), shadowMat: new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  shared.noseGeo.scale(1, 1, 1);
  texs.push(shared.bump, shared.rough, shared.eyeMat.map, shared.shadowMat.map); geos.push(shared.eyeGeo, shared.noseGeo, shared.shadowGeo); mats.push(shared.eyeMat, shared.noseMat, shared.shadowMat);
  const fab = fabricTexture(THREE), fab2 = fab.clone(); fab.repeat.set(10, 2); fab2.repeat.set(8, 1); texs.push(fab, fab2);
  const bedMats = { rim: std({ color: 0x8e8577, map: fab, roughness: 0.95 }), cushion: std({ color: 0xd9ccb2, map: fab2, roughness: 0.95 }) };
  const bowlMats = { steel: std({ color: 0xcfd2d6, metalness: 0.9, roughness: 0.3 }), mat: std({ color: 0x4a4f55, roughness: 0.95 }), water: std({ color: 0x9fc4d8, roughness: 0.05, metalness: 0.1 }), kibble: std({ color: 0x8a5a2b, roughness: 1 }) };
  const bed = buildBed(THREE, bedMats, geos, BED_X, BED_Z, 0); scene.add(bed);
  const bowls = buildBowls(THREE, bowlMats, geos, 8.07, 0.35, 0); scene.add(bowls);

  const specs = [
    { name: 'Logan', seed: 4101, scale: 1.0, wide: 1.0, collar: '#2a4fbf', bodySpots: 105, earSpots: [5, 26], earGap: [1.0, 0.22], eyePatch: [0, 1], speed: 0.72, trot: 1.45, pitch: 0.85 },
    { name: 'Gemma', seed: 7207, scale: 0.92, wide: 0.95, collar: '#c4262e', bodySpots: 125, earSpots: [9, 8], earGap: [0.6, 0.7], eyePatch: null, speed: 0.78, trot: 1.55, pitch: 1.1 },
  ];

  const dogs = specs.map((spec, index) => {
    const P = buildDog(THREE, spec, shared);
    geos.push(P.parts.geo); mats.push(P.mat); texs.push(P.coat);
    const d = {
      name: spec.name, index, spec, group: P.root, P, scale: spec.scale, other: null,
      x: 0, z: 0, heading: 0, speed: 0, lift: 0, onSofa: false, sofa: null, bed: null, room: 'woonkamer',
      state: 'idle', timer: 2, pose: 'stand', poseW: Object.fromEntries(POSE_NAMES.map((k) => [k, k === 'stand' ? 1 : 0])),
      waitT: 0, waitNode: null, toasted: false, shakeT: 0,
      goal: -1, goalKind: null, path: new Int16Array(24), pathLen: 0, pathIdx: 0, stuckT: 0, lastProg: 0,
      hop: null, hopT: 1, hopFrom: [0, 0, 0], hopTo: [0, 0, 0], hopDur: 0.55,
      phase: Math.random() * TAU, walkBlend: 0, trotBlend: 0, breath: Math.random() * TAU, breathRate: 1,
      wag: 0.15, wagT: 0.15, wagPhase: 0, tailUp: 0, tailUpT: 0,
      lookMode: 'random', lookYaw: 0, lookPitch: 0, lookTilt: 0, lookT: 1, hy: 0, hp: 0, ht: 0,
      blinkT: 2 + Math.random() * 3, blink: 0, eyesClosed: 0, sleepy: 0,
      earFlickT: 3, earFlick: 0, earSide: 1, earBack: 0, earBackT: 0,
      jaw: 0, jawT: 0, pant: 0, yawnT: 0, sniff: 0, sniffT: 0,
      petT: 0, petCool: 0, greetCool: 10 + index * 15, followT: 0, follow: false, happy: 0, bowT: 0, circleT: 0, circleDir: 1,
      sleepT: 0, stir: 0, bedCool: 0, sofaCool: 20 * index, tuck: 0, lodStride: 1, lodAcc: 0, frame: 0, dist: 0, visible: true,
      nextDecision: null, pet: null, command: null,
    };
    d.pet = () => doPet(d);
    P.root.userData.dalmatian = d;
    P.root.traverse((o) => { o.userData.dalmatian = d; });
    scene.add(P.root);
    ALL_DOGS.add(d);
    return d;
  });
  dogs[0].other = dogs[1]; dogs[1].other = dogs[0];
  const byName = (n) => dogs.find((d) => d.name.toLowerCase() === String(n || '').toLowerCase()) || null;

  const walker = () => (H && H.walker) || null;
  const walkMode = () => !H || H.mode === 'walk';
  const hour = () => (H && H.state && typeof H.state.time === 'number' ? H.state.time : 13);
  const evening = () => { const h = hour(); return h >= 18.5 || h < 7; };
  const node = (id) => nav.nodes.findIndex((n) => n.id === id);
  const N_STAIRS = node('stairs'), N_BOWLS = node('bowls');
  const releaseBed = (d) => { for (const b of nav.beds) if (b.claim === d && d.bed !== b) b.claim = null; };
  // a sofa spot is usable when its furniture item is shown (the host hides items via state.rooms.<room>.items[id] = false)
  const sofaEnabled = (s) => { if (!s.item || !H || !H.state || !H.state.rooms) return true; const r = H.state.rooms[s.room === 'zitkamer' ? 'zitkamer' : 'woonkamer']; return !(r && r.items && r.items[s.item] === false); };
  const releaseSofa = (d) => { for (const s of nav.sofas) if (s.claim === d && d.sofa !== s) s.claim = null; };

  // ---- state helpers
  function setState(d, s, t) { d.state = s; d.timer = t; }
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
      if (!n.room || n.kind === 'bed' || i === d.goal) continue;
      if (Math.hypot(n.x - d.x, n.z - d.z) < 1.0) continue;
      if (n.room === 'wc1' || n.room === 'wc2') continue;
      if (room && n.room !== room && Math.random() < 0.4) continue; // prefer the room you are in
      if (n.room === 'achterhal' && Math.random() < 0.6) continue;
      if (planTo(d, i, n.kind)) return true;
    }
    return false;
  }
  function goSleepSpot(d) {
    const ev = evening();
    if (d.sofaCool <= 0 && Math.random() < (ev ? 0.55 : 0.4)) {
      const k0 = (Math.random() * nav.sofas.length) | 0;
      for (let k = 0; k < nav.sofas.length; k++) {
        const s = nav.sofas[(k0 + k) % nav.sofas.length];
        if (s.claim || !sofaEnabled(s) || s.jumpX === s.x) continue;
        if (planTo(d, s.node, 'sofa')) { s.claim = d; return true; }
      }
    }
    if (d.bedCool <= 0) { // nearest free bed
      const free = nav.beds.filter((b) => !b.claim).sort((a, b) => Math.hypot(a.x - d.x, a.z - d.z) - Math.hypot(b.x - d.x, b.z - d.z));
      for (const b of free) if (planTo(d, b.node, 'bed')) { b.claim = d; return true; }
    }
    return false;
  }
  function goToBed(d, b) { // rest(): walk to a bed and sleep there (a dog on the sofa hops off first)
    if (!b || (b.claim && b.claim !== d)) return false;
    if (d.bed === b) { startSleep(d, 60 + Math.random() * 60); return true; }
    const go = () => { if (planTo(d, b.node, 'bed')) { b.claim = d; return true; } return false; };
    if (d.onSofa) { leaveFurniture(d); d.nextDecision = () => { if (!go()) idle(d, 1); }; return true; }
    if (d.bed) leaveFurniture(d);
    d.bedCool = 0; d.sleepy = 0; d.stir = 0;
    return go();
  }
  function decide(d) {
    const r = Math.random(), ev = evening(), w = walker();
    const sleepyBias = ev ? 0.3 : 0.1;
    if (r < sleepyBias && goSleepSpot(d)) return;
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
  function startCircle(d, then) { setState(d, 'circle', 1.1 + Math.random() * 0.6); d.pose = 'stand'; d.circleDir = Math.random() < 0.5 ? -1 : 1; d.nextDecision = then; }
  function startHop(d, tx, tz, ty, dur) {
    d.hopFrom[0] = d.x; d.hopFrom[1] = d.lift; d.hopFrom[2] = d.z; d.hopTo[0] = tx; d.hopTo[1] = ty; d.hopTo[2] = tz;
    d.hopT = 0; d.hopDur = dur; setState(d, 'hop', dur + 0.1); d.pose = 'stand';
  }
  function leaveFurniture(d) {
    if (d.onSofa && d.sofa) {
      const s = d.sofa; d.heading = Math.atan2(s.jumpX - s.x, s.jumpZ - s.z);
      startHop(d, s.jumpX, s.jumpZ, 0, 0.5); d.onSofa = false; d.sofa = null; s.claim = null; d.sofaCool = 60 + Math.random() * 90; return true;
    }
    if (d.bed) { d.bed.claim = null; d.bed = null; d.bedCool = 40 + Math.random() * 60; }
    return false;
  }
  function arrive(d) {
    const n = nav.nodes[d.goal], kind = d.goalKind;
    d.goal = -1;
    if (kind === 'bed' && n.spot) { d.bed = n.spot; n.spot.claim = d; d.heading = n.h; return startCircle(d, () => { startLie(d, 2); d.timer = 1.5; d.nextDecision = () => startSleep(d, (evening() ? 50 : 25) + Math.random() * 40); }); }
    if (kind === 'sofa' && n.spot) { d.sofa = n.spot; n.spot.claim = d; return setState(d, 'prejump', 0.6); }
    if (kind === 'bowls') { d.heading = n.h; return setState(d, 'drink', 3 + Math.random() * 3); }
    if (kind === 'look') { d.heading = n.h; return startSit(d, 5 + Math.random() * 8); }
    if (kind === 'sniff') return startSniff(d);
    if (kind === 'walker' || kind === 'come') { d.lookMode = 'walker'; return setState(d, 'happy', kind === 'come' ? 3.5 : 2.6); }
    if (kind === 'wait') { d.heading = n.h; return startLie(d, 20 + Math.random() * 20); }
    idle(d, 1 + Math.random() * 3);
  }
  function doPet(d) {
    if (d.petCool > 0) return true;
    d.petCool = 0.6; d.petT = 3.2; d.happy = 1; d.lookMode = 'walker'; d.follow = false;
    d.sleepy = 0; d.stir = 1;
    if (d.state === 'sleep' || d.state === 'lie') { setState(d, 'wake', 1.2); d.pose = 'sit'; d.nextDecision = () => { setState(d, 'petted', 3); d.pose = 'sit'; }; }
    else if (d.state === 'hop') { /* let it land */ }
    else { setState(d, 'petted', 3.2); d.pose = (d.onSofa || d.bed) ? 'sit' : (Math.random() < 0.3 ? 'bow' : 'sit'); d.bowT = d.pose === 'bow' ? 1.3 : 0; }
    const lines = PET_LINES[d.name] || [d.name + ' kwispelt'];
    toast(lines[(Math.random() * lines.length) | 0]);
    if (Math.random() < 0.6) bark(d.spec.pitch, 1 + (Math.random() < 0.4 ? 1 : 0));
    return true;
  }
  function call(name) {
    const d = byName(name) || dogs[0], w = walker();
    if (!w || w.l !== 0) { toast(d.name + ' kan je daar niet vinden'); return false; }
    if (d.onSofa || d.bed) { leaveFurniture(d); d.nextDecision = () => goToWalker(d, 'come'); d.follow = true; d.followT = 30; toast(d.name + ' komt eraan'); return true; }
    if (goToWalker(d, 'come')) { d.follow = true; d.followT = 30; toast(d.name + ' komt eraan'); if (Math.random() < 0.5) bark(d.spec.pitch, 1); return true; }
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
    if (n < 24) { d.path[n] = N_WALKER; d.pathLen = n + 1; }
    setState(d, 'walk', 10 + n * 4); d.pose = 'stand';
    return true;
  }
  const N_WALKER = nav.nodes.length;
  nav.nodes.push({ i: N_WALKER, id: 'walker', x: 0, z: 0, h: 0, room: null, kind: 'walker', door: null, edges: [] });

  // ---- events: greet when you walk into a dog's room
  const unsubs = [];
  if (H && H.on) {
    unsubs.push(H.on('room', (ev) => {
      if (!ev || ev.source !== 'walk' || ev.level !== 0 || !ev.id) return;
      let best = null, bd = 1e9;
      for (const d of dogs) { if (d.room !== ev.id || d.greetCool > 0 || d.state === 'hop') continue; const dd = Math.hypot(d.x - walker().x, d.z - walker().z); if (dd < bd) { bd = dd; best = d; } }
      if (!best) return;
      best.greetCool = 45 + Math.random() * 30;
      if (best.state === 'sleep') { best.stir = 1; best.sleepy = 0.3; best.timer = Math.min(best.timer, 6); best.lookMode = 'walker'; return; }
      if (best.onSofa || best.bed) { best.lookMode = 'walker'; best.happy = 0.6; return; }
      if (goToWalker(best, 'walker')) { best.happy = 1; best.speed = 0; }
    }));
  }
  // (clicks, taps and the E key reach pet() through the app's own picker: HOUSE.dogs.pet(hit.object))

  // ---- initial placement: one dog lounges on the sofa (Gemma on the host's spot, else Logan on the woonkamer bank),
  // the other stands in the woonkamer
  {
    const hostSofa = nav.sofas.find((s) => s.id === 'sofa') || null, spot = hostSofa || nav.sofas[0] || null;
    const a = hostSofa ? dogs[1] : dogs[0], b = a.other;
    if (spot) {
      a.x = spot.x; a.z = spot.z; a.lift = spot.y; a.onSofa = true; a.sofa = spot; spot.claim = a; a.heading = spot.heading;
      if (hostSofa) { startLie(a, 10 + Math.random() * 12); a.poseW.stand = 0; a.poseW.lie = 1; a.nextDecision = () => startSleep(a, 30 + Math.random() * 30); }
      else { startSleep(a, 25 + Math.random() * 20); a.poseW.stand = 0; a.poseW.curl = 1; a.sleepy = 1; }
    } else { a.x = 4.6; a.z = 9.0; a.heading = 1.2; idle(a, 1); }
    b.x = 5.4; b.z = 6.3; b.heading = 2.6; idle(b, 1 + Math.random());
  }

  // ---- behaviour (per frame)
  const TURN = 4.0;
  function steer(d, tx, tz, dt, maxSpeed) { // returns distance to target
    const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz), err = wrapAngle(want - d.heading);
    d.heading = wrapAngle(d.heading + clamp(err, -TURN * dt, TURN * dt));
    const c = Math.max(0, Math.cos(err));
    d.speed = damp(d.speed, maxSpeed * c * c * clamp(dist / 0.45, 0.25, 1), 5, dt);
    return dist;
  }
  function faceHeading(d, h, dt) { const err = wrapAngle(h - d.heading); d.heading = wrapAngle(d.heading + clamp(err, -TURN * dt, TURN * dt)); return Math.abs(err) < 0.05; }
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
        if (d.timer <= 0) decide(d);
        break;
      case 'walk': {
        if (d.pathIdx >= d.pathLen) { arrive(d); break; }
        const n = nav.nodes[d.path[d.pathIdx]], last = d.pathIdx === d.pathLen - 1;
        // the next waypoint is a doorway that is shut (or shutting): stop short of the leaf and wait
        if (n.kind === 'door' && !nav.passable(n.door)) {
          const dd = Math.hypot(n.x - d.x, n.z - d.z);
          if (dd < 0.95 && dd > 0.3) { setState(d, 'waitdoor', 0); d.pose = 'stand'; d.waitT = 0; d.waitNode = n; d.toasted = false; d.speed = 0; break; }
        }
        const spd = d.goalKind === 'walker' || d.goalKind === 'come' ? d.spec.trot : d.goalKind === 'follow' ? d.spec.speed * 1.3 : d.spec.speed;
        const dist = steer(d, n.x, n.z, dt, spd);
        moving = true;
        if (dist < (last ? 0.1 : 0.3)) { d.pathIdx++; d.stuckT = 0; d.lastProg = 1e9; if (last) { d.speed *= 0.5; } }
        if (d.goalKind === 'follow' && wd < 1.4) { d.speed = 0; idle(d, 1 + Math.random()); d.lookMode = 'walker'; break; }
        if ((d.goalKind === 'walker' || d.goalKind === 'come') && wd < 1.25) { arrive(d); break; }
        if (dist < d.lastProg - 0.02) { d.lastProg = dist; d.stuckT = 0; } else { d.stuckT += dt; if (d.stuckT > 1.4) { releaseBed(d); releaseSofa(d); idle(d, 1); } }
        if (d.timer <= 0) { releaseBed(d); releaseSofa(d); idle(d, 1); }
        break;
      }
      case 'waitdoor': { // at a shut door: face it, sit down after a moment, whine now and then, carry on once it opens
        const n = d.waitNode; d.waitT += dt;
        if (!n) { idle(d, 1); break; }
        faceHeading(d, Math.atan2(n.x - d.x, n.z - d.z), dt);
        if (nav.passable(n.door)) { setState(d, 'walk', 8 + (d.pathLen - d.pathIdx) * 5); d.pose = 'stand'; d.stuckT = 0; d.lastProg = 1e9; break; }
        if (d.waitT > 1.6 && d.pose !== 'sit') d.pose = 'sit';
        if (d.waitT > 2.2 && !d.toasted && wd < 6) { d.toasted = true; toast(d.name + ' wacht bij de deur'); }
        if (d.waitT > 3 && Math.random() < dt * 0.1) { whine(d.spec.pitch); d.lookMode = wd < 7 ? 'walker' : 'random'; d.lookT = 2; }
        if (d.waitT > 16 + 6 * Math.random()) { // nobody comes: give up on this route
          releaseBed(d); releaseSofa(d); d.goal = -1;
          if (d.goalKind === 'come' || d.goalKind === 'walker' || d.goalKind === 'follow' || !wander(d)) startLie(d, 12 + Math.random() * 15);
        }
        break;
      }
      case 'sniff':
        d.heading = wrapAngle(d.heading + d.circleDir * 0.35 * dt * (0.5 + 0.5 * Math.sin(d.timer * 1.3)));
        d.speed = damp(d.speed, 0.16, 3, dt); moving = true;
        if (d.timer <= 0) { d.sniff = 0; idle(d, 1 + Math.random() * 2); }
        break;
      case 'circle':
        d.heading = wrapAngle(d.heading + d.circleDir * 3.6 * dt); d.speed = damp(d.speed, 0.12, 4, dt);
        if (d.timer <= 0) { d.speed = 0; const f = d.nextDecision; d.nextDecision = null; f ? f() : idle(d, 1); }
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
          if (d.bed || d.onSofa || Math.random() < (evening() ? 0.6 : 0.35)) startSleep(d, (evening() ? 45 : 20) + Math.random() * 30);
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
          if (leaveFurniture(d)) break;
          if (Math.random() < 0.75) { setState(d, 'stretch', 1.8); d.pose = 'stretch'; break; }
          idle(d, 0.5);
        }
        break;
      case 'stretch': // a long bow after a nap, then a shake
        if (d.timer <= 0) { if (Math.random() < 0.7) { setState(d, 'shake', 1.1); d.pose = 'stand'; d.shakeT = 0; } else idle(d, 0.5); }
        break;
      case 'shake': d.shakeT += dt; if (d.timer <= 0) idle(d, 1); break;
      case 'prejump':
        if (!d.sofa) { idle(d, 1); break; }
        if (faceHeading(d, Math.atan2(d.sofa.x - d.x, d.sofa.z - d.z), dt) && d.timer <= 0) { startHop(d, d.sofa.x, d.sofa.z, d.sofa.y, 0.6); d.onSofa = true; }
        break;
      case 'hop':
        d.hopT += dt;
        if (d.hopT >= d.hopDur) {
          d.x = d.hopTo[0]; d.z = d.hopTo[2]; d.lift = d.hopTo[1]; d.hopT = d.hopDur;
          if (d.onSofa && d.sofa) { d.heading = d.sofa.heading + (Math.random() < 0.6 ? 0 : Math.PI); startCircle(d, () => { startLie(d, 8 + Math.random() * 10); d.nextDecision = () => startSleep(d, (evening() ? 60 : 30) + Math.random() * 45); }); }
          else { const f = d.nextDecision; d.nextDecision = null; f ? f() : idle(d, 0.8); }
        } else {
          const t = d.hopT / d.hopDur, e = t * t * (3 - 2 * t);
          d.x = lerp(d.hopFrom[0], d.hopTo[0], e); d.z = lerp(d.hopFrom[2], d.hopTo[2], e);
          d.lift = lerp(d.hopFrom[1], d.hopTo[1], e) + Math.sin(Math.PI * t) * 0.28;
        }
        break;
      case 'drink':
        if (d.timer <= 0) { if (Math.random() < 0.5) startSniff(d); else idle(d, 1); }
        break;
      case 'happy': // arrived at the walker: wag, maybe a play bow, then sit and look up
        d.lookMode = 'walker'; d.happy = 1;
        if (d.bowT <= 0 && d.timer > 1.2 && d.pose === 'stand' && Math.random() < dt * 1.5) { d.pose = 'bow'; d.bowT = 1.2; }
        if (d.bowT > 0) { d.bowT -= dt; if (d.bowT <= 0) d.pose = 'sit'; }
        if (w && wd > 0.45) faceHeading(d, Math.atan2(w.x - d.x, w.z - d.z), dt);
        if (d.timer <= 0) { d.pose = 'stand'; idle(d, 1.5); d.follow = Math.random() < 0.6; d.followT = 20 + Math.random() * 20; }
        break;
      case 'petted':
        d.lookMode = 'walker'; d.happy = 1;
        if (d.bowT > 0) { d.bowT -= dt; if (d.bowT <= 0) d.pose = 'sit'; }
        if (!d.onSofa && !d.bed && w && wd > 0.4) faceHeading(d, Math.atan2(w.x - d.x, w.z - d.z), dt);
        if (d.timer <= 0) { if (d.onSofa || d.bed) { startLie(d, 4 + Math.random() * 6); } else { startSit(d, 1 + Math.random() * 2); d.follow = true; d.followT = 20; } }
        break;
    }
    if (!moving && d.state !== 'hop') d.speed = damp(d.speed, 0, 9, dt);

    // --- movement + collisions (not while on furniture or mid-hop)
    if (d.state !== 'hop' && !d.onSofa) {
      d.x += Math.sin(d.heading) * d.speed * dt; d.z += Math.cos(d.heading) * d.speed * dt;
      // make way for the walker: never stand in their path
      const standing = d.state === 'idle' || d.state === 'sit' || d.state === 'sniff' || d.state === 'happy' || d.state === 'walk' || d.state === 'waitdoor';
      if (w && w.l === 0 && wd < 0.62 && wd > 1e-3 && standing && !d.bed) {
        const k = (0.62 - wd) * 3.5 * dt;
        d.x += ((d.x - w.x) / wd) * k; d.z += ((d.z - w.z) / wd) * k;
        if (d.state === 'sit' && wd < 0.45) idle(d, 0.8);
      } else if (w && w.l === 0 && wd < 0.5 && (d.state === 'lie' || d.state === 'sleep') && !d.bed) { d.sleepy = 0; setState(d, 'wake', 0.6); d.pose = 'sit'; }
      // a bed belongs to whoever is in it (or on the way to it); walls and doors have the last word
      const goalBed = d.state === 'walk' && d.goalKind === 'bed' && d.goal >= 0 ? nav.nodes[d.goal].spot : null;
      for (const b of nav.beds) {
        if (b === d.bed || b === goalBed) continue;
        const bx = d.x - b.x, bz = d.z - b.z, bd = Math.hypot(bx, bz), rr = b.r + 0.08;
        if (bd < rr && bd > 1e-4) { const k = Math.min(rr - bd, 1.0 * dt); d.x += (bx / bd) * k; d.z += (bz / bd) * k; } // eased, no jump when stepping off
      }
      nav.resolve(d, DOG_R);
      if (goalBed) d.lift = goalBed.y * (1 - sstep(goalBed.r - 0.1, goalBed.r + 0.1, Math.hypot(d.x - goalBed.x, d.z - goalBed.z)));
      else d.lift = d.bed ? d.bed.y : 0;
      if (d.bed && Math.hypot(d.x - d.bed.x, d.z - d.bed.z) > d.bed.r + 0.1) { d.bed.claim = null; d.bed = null; }
    }
    d.room = nav.roomOf(d.x, d.z) || d.room;
  }
  function separate() {
    const a = dogs[0], b = dogs[1], dx = b.x - a.x, dz = b.z - a.z, dd = Math.hypot(dx, dz), MIN = 0.55;
    if (dd >= MIN || a.state === 'hop' || b.state === 'hop' || a.onSofa !== b.onSofa) return;
    const nx = dd > 1e-4 ? dx / dd : 1, nz = dd > 1e-4 ? dz / dd : 0;
    const pin = (d) => d.state === 'sleep' || d.state === 'lie' || d.onSofa || d.bed;
    const fa = pin(a) ? 0 : 1, fb = pin(b) ? 0 : 1, tot = fa + fb; if (!tot) return;
    const push = (MIN - dd) / tot;
    if (fa) { a.x -= nx * push; a.z -= nz * push; nav.resolve(a, DOG_R); }
    if (fb) { b.x += nx * push; b.z += nz * push; nav.resolve(b, DOG_R); }
  }

  // ---- animation
  const E = {}; for (const b of POSE_BONES) E[b] = [0, 0, 0]; // scratch eulers (reused)
  // footfall offsets in cycle fractions: walk = lateral sequence LH LF RH RF, trot = diagonal pairs
  const WALK_OFF = { armL: 0.25, thighR: 0.5, armR: 0.75, thighL: 0 };
  const TROT_OFF = { armL: 0, thighR: 0, armR: 0.5, thighL: 0.5 };
  const LEG_L = 0.455; // shoulder / hip pivot to the pad: the planted paw moves back at exactly ground speed
  function pose(d, dt) {
    const P = d.P, B = P.byName, w = walker();
    // pose weights
    let sum = 0;
    const slow = d.pose === 'curl' || d.pose === 'donut' || d.pose === 'side';
    for (const k of POSE_NAMES) { const t = d.pose === k ? 1 : 0; d.poseW[k] = damp(d.poseW[k], t, slow || ((k === 'curl' || k === 'donut' || k === 'side') && d.poseW[k] > 0.01) ? 2.2 : 5, dt); sum += d.poseW[k]; }
    let rootY = 0, rootP = 0, rootR = 0;
    for (const b of POSE_BONES) { E[b][0] = 0; E[b][1] = 0; E[b][2] = 0; }
    for (const k of POSE_NAMES) {
      const wgt = d.poseW[k] / sum; if (wgt < 1e-3) continue;
      const p = POSES[k]; rootY += wgt * p.rootY; rootP += wgt * p.rootP; rootR += wgt * (p.rootR || 0);
      for (const b of POSE_BONES) { const r = p[b]; if (r) { E[b][0] += wgt * r[0]; E[b][1] += wgt * r[1]; E[b][2] += wgt * r[2]; } }
    }
    const standW = d.poseW.stand / sum, lying = (d.poseW.lie + d.poseW.curl + d.poseW.donut + d.poseW.side) / sum, sitW = d.poseW.sit / sum, ringW = (d.poseW.donut + d.poseW.side) / sum;

    // gait: a stance / swing cycle per leg. In stance the paw stays planted (the hip angle follows asin so the paw slides
    // back under the body at ground speed); in swing it is lifted with the elbow / hock flexed and carried forward. The
    // stride shortens at a slow walk and cadence follows speed, so the paws never skate.
    const spd = d.speed, L = LEG_L * d.scale;
    d.walkBlend = damp(d.walkBlend, clamp(spd / 0.2, 0, 1) * standW, 8, dt);
    d.trotBlend = damp(d.trotBlend, sstep(0.8, 1.15, spd), 4, dt);
    const stance = lerp(0.62, 0.5, d.trotBlend), A = Math.min(lerp(0.44, 0.5, d.trotBlend), 0.2 + spd * 0.45), sA = Math.sin(A);
    if (spd > 0.02) d.phase = (d.phase + (dt * stance * spd) / (2 * L * sA)) % 1;
    else if (d.walkBlend > 0.01) d.phase = (d.phase + dt * 0.5) % 1; // finish the step in place
    const W = d.walkBlend, tuck = d.state === 'hop' ? Math.sin(Math.PI * clamp(d.hopT / d.hopDur, 0, 1)) : 0;
    for (const leg of ['armL', 'armR', 'thighL', 'thighR']) {
      const off = lerp(WALK_OFF[leg], TROT_OFF[leg], d.trotBlend), ph = (d.phase + off) % 1, front = leg[0] === 'a', side = leg.slice(-1);
      let hip, flex;
      if (ph < stance) { hip = Math.asin(lerp(sA, -sA, ph / stance)); flex = 0; }
      else { const u = (ph - stance) / (1 - stance); hip = Math.asin(lerp(-sA, sA, u * u * (3 - 2 * u))); flex = Math.sin(Math.PI * u); }
      if (front) {
        E[leg][0] += hip * W + tuck * 0.9;
        E['fore' + side][0] += (-1.15 * flex - 0.04) * W - tuck * 1.5;
        E['paw' + side][0] += (0.65 * flex + 0.04) * W + tuck * 0.6;
      } else {
        E[leg][0] += (hip + 0.04) * W + tuck * 0.6;
        E['shin' + side][0] += (-0.9 * flex - 0.1) * W - tuck * 1.2;
        E['foot' + side][0] += (0.65 * flex + 0.1) * W + tuck * 0.9;
      }
    }
    const ph2 = d.phase * TAU * 2, bob = (0.008 * Math.sin(ph2) - 0.006 + 0.015 * d.trotBlend * Math.max(0, Math.sin(ph2 + 1))) * W;
    E.spine[2] += 0.03 * Math.sin(d.phase * TAU) * W; E.chest[0] += -0.02 * Math.sin(ph2 + 1) * W;
    E.neck[0] += 0.25 * W + 0.045 * Math.sin(ph2 + 0.6) * W; // head carried lower when walking, nodding with the forelegs
    E.neck2[0] += -0.1 * W;
    if (d.state === 'shake') { // whole-body shake from the head back, dying out
      const k = Math.sin(d.shakeT * 40) * sstep(0, 0.12, d.shakeT) * (1 - sstep(0.6, 1.05, d.shakeT));
      E.head[2] += 0.55 * k; E.neck2[2] += 0.35 * k; E.neck[2] += 0.25 * k; E.chest[2] += 0.18 * k; E.spine[2] += 0.1 * Math.sin(d.shakeT * 40 - 0.8) * (1 - sstep(0.6, 1.05, d.shakeT));
      E.earL[2] += 0.7 * k; E.earR[2] += 0.7 * k; E.tail1[2] += 0.4 * k; E.neck[0] += 0.2 * sstep(0, 0.2, d.shakeT);
    }
    if (d.state === 'stretch') E.neck[0] += 0.15 * Math.sin(d.timer * 3);
    // hop arc: nose up on the way up, down on the way down
    if (d.state === 'hop') { const t = clamp(d.hopT / d.hopDur, 0, 1); rootP += -0.5 * Math.cos(Math.PI * t) * (d.hopTo[1] >= d.hopFrom[1] ? 1 : -1); }

    // breathing (ribs scale, slight chest lift); slow and deep while asleep, panting fast when happy / after a run
    d.pant = damp(d.pant, d.happy > 0.5 || d.petT > 0 ? 1 : 0, 1.5, dt);
    const rate = lerp(lerp(1.6, 3.2, W), 0.9, d.sleepy) + d.pant * 7;
    d.breath = (d.breath + dt * rate) % TAU;
    const br = Math.sin(d.breath), ribs = 1 + (0.02 + 0.012 * d.sleepy + 0.01 * W) * br;
    B.ribs.scale.set(ribs, ribs, 1); E.chest[0] += -0.012 * br * (1 - W); E.spine[0] += 0.01 * br * lying;

    // head: look targets
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
      yawT = clamp(wrapAngle(Math.atan2(w.x - d.x, w.z - d.z) - d.heading), -1.2, 1.2);
      const dy = (w.y + 1.5) - (d.lift + 0.66 * d.scale); pitchT = clamp(-Math.atan2(dy, Math.max(0.4, wd)), -1.0, 0.3);
    } else if (d.lookMode === 'other') {
      const o = d.other; yawT = clamp(wrapAngle(Math.atan2(o.x - d.x, o.z - d.z) - d.heading), -1.0, 1.0); pitchT = 0.1;
    }
    if (d.state === 'walk') { const n = nav.nodes[d.path[Math.min(d.pathIdx, d.pathLen - 1)]]; if (n && d.lookMode !== 'walker') { yawT = clamp(wrapAngle(Math.atan2(n.x - d.x, n.z - d.z) - d.heading) * 0.6, -0.6, 0.6); pitchT = 0.1; } tiltT = 0; }
    if (d.state === 'sniff') { pitchT = 0.95; yawT = 0.25 * Math.sin(d.timer * 7) + 0.3 * Math.sin(d.timer * 2.1); tiltT = 0; }
    if (d.state === 'drink') { pitchT = 1.0; yawT = 0; tiltT = 0; }
    if (d.state === 'yawn') { const y = Math.sin(Math.PI * clamp(d.yawnT / 1.8, 0, 1)); pitchT = -0.45 * y; tiltT = 0; }
    if (d.petT > 0) { pitchT = Math.min(pitchT, -0.35) - 0.1 * Math.sin(d.petT * 5); tiltT = (d.index ? -1 : 1) * 0.3 * sstep(0, 0.5, d.petT); }
    if (d.state === 'scratch') { yawT = -0.4; pitchT = 0.2; tiltT = 0.4; }
    if (d.state === 'waitdoor' && d.lookMode !== 'walker') { yawT = 0.15 * Math.sin(d.waitT * 0.9); pitchT = -0.1; tiltT = d.waitT > 3 ? 0.2 * Math.sin(d.waitT * 0.4) : 0; }
    const sl = d.sleepy; yawT *= 1 - sl; pitchT = lerp(pitchT, 0.35, sl); tiltT *= 1 - sl;
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
    if (d.pose === 'bow') { upT = 1.0; wagT = 0.8; }
    if (d.state === 'scratch') { wagT = 0.05; }
    if (d.state === 'waitdoor') { wagT = d.lookMode === 'walker' ? 0.5 : 0.08; upT = 0.05; }
    if (d.state === 'stretch') { wagT = 0.2; upT = 0.6; }
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
    const earSwing = 0.08 * Math.sin(ph2 + 1) * W;
    E.earL[0] += -0.55 * back + earSwing; E.earR[0] += -0.55 * back + earSwing;
    E.earL[2] += 0.15 + (d.earSide > 0 ? flick * 0.6 : 0) + 0.25 * d.pant; E.earR[2] += -0.15 - (d.earSide < 0 ? flick * 0.6 : 0) - 0.25 * d.pant;
    if (d.state === 'scratch') E.earR[2] += -0.5 + 0.2 * Math.sin(d.timer * 40);
    if (d.state === 'scratch') { E.shinR[0] += 0.5 * Math.sin(d.timer * 40); }

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
    const R = B.root; R.position.set(0, rootY + bob + (d.state === 'scratch' ? 0.01 * Math.sin(d.timer * 40) : 0), -0.22); R.rotation.set(-rootP, 0, rootR);
    d.group.position.set(d.x, d.lift, d.z); d.group.rotation.y = d.heading;
    // contact shadow follows the footprint (a round blob under the curled-up dog, shifted to the curl side)
    const sh = P.shadow, sx = lerp(lerp(0.62, 0.7, lying) - 0.1 * sitW, 0.72, ringW), sz = lerp(lerp(0.42, 0.55, lying), 0.7, ringW);
    sh.scale.set(sx, sz, 1); sh.position.z = lerp(lerp(0, -0.05, lying) - 0.1 * sitW, 0.02, ringW); sh.position.x = 0.1 * ringW;
  }

  // ---- per-frame update, with LOD (far / off-screen dogs animate at a lower rate; behaviour always runs)
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sph = new THREE.Sphere(new THREE.Vector3(), 0.9);
  let disposed = false, frame = 0;
  function update(dt) {
    if (disposed) return;
    dt = clamp(dt || 0, 0, 0.1); frame++;
    for (let i = 0; i < dogs.length; i++) behave(dogs[i], dt);
    separate();
    const cam = H && H.camera;
    if (cam) { pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); frustum.setFromProjectionMatrix(pm); }
    for (let i = 0; i < dogs.length; i++) {
      const d = dogs[i];
      let stride = 1;
      if (cam) {
        sph.center.set(d.x, d.lift + 0.35, d.z); const cp = cam.position;
        d.dist = Math.hypot(cp.x - d.x, cp.y - d.lift - 0.35, cp.z - d.z);
        d.visible = frustum.intersectsSphere(sph);
        stride = !d.visible ? 6 : d.dist > 16 ? 4 : d.dist > 7 ? 2 : 1;
        if (H && H.mode === 'doll') stride = Math.max(stride, 2);
      }
      d.lodAcc += dt;
      if ((frame + i) % stride === 0) { pose(d, d.lodAcc); d.lodAcc = 0; }
    }
  }
  update(0); update(0);
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

  function setObstacles(list) { nav.setObstacles(list); }
  // the host changed its walls/doors (HOUSE 'kitchen' event): new graph, and whoever was walking plans again
  function refreshNav() {
    nav.refreshDoors();
    for (const d of dogs) if (d.state === 'walk' || d.state === 'waitdoor') { releaseBed(d); releaseSofa(d); d.goal = -1; idle(d, 0.5); }
  }
  if (H && typeof H.on === 'function') H.on('kitchen', refreshNav);
  // ---- rest spots. beds: live list of { id, x, z, y, r, heading, room, claim }. addBed({ id, x, z, y, r, heading, room })
  // registers a bed (the host places the mesh itself, e.g. the green bean bag in the office corner); rest('Gemma', 'id')
  // sends a dog there to curl up; place('Logan', { x, z, heading, pose }) puts a dog somewhere at once (pose: stand, sit,
  // lie, curl, donut, side; or bed: 'id' to drop it asleep on that bed).
  const addBed = (b) => nav.addBed(b);
  const removeBed = (id) => { const b = nav.removeBed(id); if (b) for (const d of dogs) if (d.bed === b) { d.bed = null; d.lift = 0; } return b; };
  const rest = (name, bedId) => { const d = byName(name); if (!d) return false; const b = bedId == null ? nav.beds.find((x) => !x.claim || x.claim === d) : nav.beds.find((x) => x.id === String(bedId)); return goToBed(d, b); };
  function place(name, o = {}) {
    const d = byName(name); if (!d) return false;
    if (d.onSofa && d.sofa) { d.sofa.claim = null; d.sofa = null; d.onSofa = false; }
    releaseBed(d); if (d.bed) { d.bed.claim = null; d.bed = null; }
    const b = o.bed != null ? nav.beds.find((x) => x.id === String(o.bed)) : null;
    d.x = Number.isFinite(o.x) ? o.x : b ? b.x : d.x; d.z = Number.isFinite(o.z) ? o.z : b ? b.z : d.z;
    d.heading = Number.isFinite(o.heading) ? o.heading : b ? b.heading : d.heading; d.lift = Number.isFinite(o.y) ? o.y : b ? b.y : 0;
    d.goal = -1; d.goalKind = null; d.follow = false; d.nextDecision = null; d.speed = 0; d.hopT = d.hopDur;
    if (b) { d.bed = b; b.claim = d; }
    const pose = o.pose || (b ? 'donut' : 'stand'), t = Number.isFinite(o.time) ? o.time : 40 + Math.random() * 40;
    if (pose === 'sit') startSit(d, t); else if (pose === 'lie') startLie(d, t); else if (pose === 'curl' || pose === 'donut' || pose === 'side') { startSleep(d, t, pose); d.sleepy = 1; } else idle(d, 1);
    if (o.snap) for (const k of POSE_NAMES) d.poseW[k] = k === d.pose ? 1 : 0;
    d.room = nav.roomOf(d.x, d.z) || d.room;
    return true;
  }
  return { dogs, bed, bowls, beds: nav.beds, addBed, removeBed, rest, place, dispose, pet, call, update, setObstacles, refreshNav, nav, POSES };
}
