// dalmatians.js - Logan & Gemma: two skinned, procedurally textured dalmatians that live in the house.
// Standalone ES module, imports nothing: THREE (0.170.0) is passed in.
//
//   import { addDalmatians, pet } from './dalmatians.js';
//   const dogs = addDalmatians(THREE, scene, { onTick });   // -> { dogs:[{group,name,...}], bed, pet, call(name), dispose, update }
//   HOUSE.dogs = dogs;  // raycast dogs.dogs[i].group -> pet(hit.object); dogs.call('Logan')
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
// in one BufferGeometry; eyes and nose are tiny extra meshes parented to the head bone.
class MeshBuilder {
  constructor() { this.pos = []; this.uv = []; this.si = []; this.sw = []; this.idx = []; this.seams = []; this.regions = []; }
  // rings: [{ p:[x,y,z], w, ht, hb, pinch, b:[[bone,wt],[bone,wt]] }], region { u0,u1,v0,v1, seam (angle of seam), id }
  tube(rings, region, seg, bones) {
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
      const pinch = r.pinch || 0;
      for (let k = 0; k <= seg; k++) {
        const th = seam + (k / seg) * TAU, c = Math.cos(th), s = Math.sin(th);
        const h = s >= 0 ? r.ht : r.hb, wx = r.w * c * (s < 0 ? 1 - pinch * -s : 1), hy = h * s;
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
    const info = { id: region.id, u0: region.u0, u1: region.u1, v0: region.v0, v1: region.v1, len, vs, circ, rings, seam };
    this.regions.push(info);
    return info;
  }
  pushWeights(b, bones) {
    const b0 = b[0], b1 = b[1];
    this.si.push(bones[b0[0]], b1 ? bones[b1[0]] : 0, 0, 0);
    this.sw.push(b0[1], b1 ? b1[1] : 0, 0, 0);
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
  ['earL', 'head', 0.05, 0.705, 0.44], ['earR', 'head', -0.05, 0.705, 0.44],
  ['armL', 'chest', 0.066, 0.47, 0.215], ['foreL', 'armL', 0.067, 0.305, 0.205], ['pawL', 'foreL', 0.067, 0.07, 0.205],
  ['armR', 'chest', -0.066, 0.47, 0.215], ['foreR', 'armR', -0.067, 0.305, 0.205], ['pawR', 'foreR', -0.067, 0.07, 0.205],
  ['thighL', 'root', 0.06, 0.465, -0.26], ['shinL', 'thighL', 0.064, 0.27, -0.20], ['footL', 'shinL', 0.064, 0.15, -0.32],
  ['thighR', 'root', -0.06, 0.465, -0.26], ['shinR', 'thighR', -0.064, 0.27, -0.20], ['footR', 'shinR', -0.064, 0.15, -0.32],
  ['tail1', 'root', 0, 0.515, -0.34], ['tail2', 'tail1', 0, 0.49, -0.40], ['tail3', 'tail2', 0, 0.455, -0.455], ['tail4', 'tail3', 0, 0.415, -0.505], ['tail5', 'tail4', 0, 0.37, -0.55],
];
const BI = {}; BONES.forEach((b, i) => { BI[b[0]] = i; });

// Body tube from the buttocks to the nose. ht/hb = top/bottom half heights, pinch narrows the underside (keel).
function bodyRings(f) {
  const R = (z, y, w, ht, hb, b, pinch = 0.1, jaw = 0) => ({ p: [0, y, z], w: w * f.wide, ht, hb, pinch, b, jaw });
  return [
    R(-0.345, 0.455, 0.045, 0.055, 0.05, [['root', 1]], 0),
    R(-0.33, 0.455, 0.075, 0.08, 0.07, [['root', 1]], 0),
    R(-0.27, 0.465, 0.1, 0.095, 0.085, [['root', 1]], 0.1),
    R(-0.19, 0.47, 0.09, 0.09, 0.082, [['root', 0.5], ['spine', 0.5]], 0.2),   // loin, tucked
    R(-0.09, 0.47, 0.095, 0.095, 0.105, [['spine', 0.8], ['ribs', 0.2]], 0.2),
    R(0.02, 0.46, 0.104, 0.105, 0.145, [['ribs', 0.7], ['spine', 0.3]], 0.3),     // ribcage, deepest
    R(0.13, 0.455, 0.104, 0.11, 0.155, [['ribs', 0.6], ['chest', 0.4]], 0.32),
    R(0.235, 0.45, 0.095, 0.12, 0.14, [['chest', 1]], 0.3),                        // withers / shoulder
    R(0.305, 0.49, 0.074, 0.09, 0.095, [['chest', 0.5], ['neck', 0.5]], 0.25),   // base of neck
    R(0.355, 0.555, 0.066, 0.072, 0.078, [['neck', 0.8], ['neck2', 0.2]], 0.15),
    R(0.395, 0.615, 0.058, 0.062, 0.064, [['neck2', 0.75], ['neck', 0.25]], 0.1),
    R(0.425, 0.66, 0.056, 0.054, 0.058, [['neck2', 0.4], ['head', 0.6]], 0),
    R(0.465, 0.68, 0.064, 0.058, 0.058, [['head', 1]], 0),                           // skull
    R(0.505, 0.678, 0.06, 0.054, 0.052, [['head', 1]], 0),                         // brow
    R(0.535, 0.666, 0.05, 0.042, 0.046, [['head', 1]], 0, 0.3),                   // stop
    R(0.575, 0.652, 0.044, 0.036, 0.042, [['head', 1]], 0.05, 0.75),                // muzzle
    R(0.625, 0.64, 0.038, 0.031, 0.036, [['head', 1]], 0.1, 0.85),
    R(0.655, 0.634, 0.031, 0.027, 0.029, [['head', 1]], 0.1, 0.8),                 // nose
  ];
}
function frontLegRings(s, f) {
  const x = s * 0.062 * f.wide, R = (y, z, w, ht, hb, b) => ({ p: [x, y, z], w, ht, hb, b });
  const a = 'arm' + (s > 0 ? 'L' : 'R'), fo = 'fore' + (s > 0 ? 'L' : 'R'), pw = 'paw' + (s > 0 ? 'L' : 'R');
  return [
    R(0.53, 0.205, 0.024, 0.04, 0.036, [['chest', 1]]),
    R(0.475, 0.21, 0.033, 0.05, 0.044, [[a, 0.55], ['chest', 0.45]]),
    R(0.415, 0.215, 0.034, 0.047, 0.041, [[a, 1]]),
    R(0.335, 0.21, 0.03, 0.037, 0.031, [[a, 0.75], [fo, 0.25]]),
    R(0.295, 0.205, 0.027, 0.031, 0.029, [[a, 0.4], [fo, 0.6]]),    // elbow
    R(0.22, 0.2, 0.025, 0.028, 0.026, [[fo, 1]]),
    R(0.13, 0.2, 0.023, 0.025, 0.024, [[fo, 1]]),
    R(0.085, 0.203, 0.023, 0.026, 0.024, [[fo, 0.6], [pw, 0.4]]),   // pastern
    R(0.045, 0.215, 0.028, 0.027, 0.021, [[pw, 1]]),
    R(0.024, 0.248, 0.032, 0.023, 0.02, [[pw, 1]]),                 // paw
    R(0.017, 0.275, 0.028, 0.016, 0.014, [[pw, 1]]),
  ];
}
function hindLegRings(s, f) {
  const x = s * 0.064 * f.wide, R = (y, z, w, ht, hb, b) => ({ p: [x, y, z], w, ht, hb, b });
  const t = 'thigh' + (s > 0 ? 'L' : 'R'), sh = 'shin' + (s > 0 ? 'L' : 'R'), ft = 'foot' + (s > 0 ? 'L' : 'R');
  return [
    R(0.525, -0.25, 0.026, 0.05, 0.05, [['root', 1]]),
    R(0.475, -0.248, 0.038, 0.07, 0.064, [[t, 0.5], ['root', 0.5]]),
    R(0.43, -0.245, 0.043, 0.078, 0.062, [[t, 1]]),                 // upper thigh, broad front-back
    R(0.35, -0.225, 0.037, 0.056, 0.046, [[t, 1]]),
    R(0.30, -0.21, 0.031, 0.042, 0.037, [[t, 0.7], [sh, 0.3]]),
    R(0.265, -0.205, 0.029, 0.036, 0.033, [[t, 0.4], [sh, 0.6]]),   // stifle
    R(0.21, -0.26, 0.026, 0.03, 0.032, [[sh, 1]]),
    R(0.165, -0.31, 0.024, 0.026, 0.031, [[sh, 0.6], [ft, 0.4]]),   // hock
    R(0.12, -0.31, 0.022, 0.024, 0.026, [[ft, 1]]),
    R(0.06, -0.295, 0.023, 0.025, 0.023, [[ft, 1]]),
    R(0.03, -0.265, 0.028, 0.026, 0.021, [[ft, 1]]),
    R(0.022, -0.225, 0.031, 0.022, 0.02, [[ft, 1]]),                // paw
    R(0.017, -0.2, 0.027, 0.016, 0.015, [[ft, 1]]),
  ];
}
function tailRings() {
  const R = (y, z, r, b) => ({ p: [0, y, z], w: r, ht: r, hb: r, b });
  return [
    R(0.515, -0.335, 0.026, [['tail1', 1]]), R(0.49, -0.40, 0.022, [['tail1', 0.4], ['tail2', 0.6]]),
    R(0.455, -0.455, 0.019, [['tail2', 0.4], ['tail3', 0.6]]), R(0.415, -0.505, 0.016, [['tail3', 0.4], ['tail4', 0.6]]),
    R(0.37, -0.55, 0.013, [['tail4', 0.4], ['tail5', 0.6]]), R(0.33, -0.58, 0.01, [['tail5', 1]]), R(0.305, -0.598, 0.007, [['tail5', 1]]),
  ];
}
function earRings(s, f) {
  const e = 'ear' + (s > 0 ? 'L' : 'R'), R = (dx, dy, dz, w, h, b) => ({ p: [s * (0.05 + dx) * f.wide, 0.705 + dy, 0.44 + dz], w, ht: h, hb: h, b });
  return [
    R(0.0, 0.005, 0.0, 0.012, 0.034, [['head', 0.5], [e, 0.5]]),
    R(0.014, -0.02, -0.002, 0.009, 0.046, [[e, 1]]),
    R(0.021, -0.05, 0.002, 0.008, 0.052, [[e, 1]]),
    R(0.022, -0.082, 0.009, 0.007, 0.046, [[e, 1]]),
    R(0.02, -0.108, 0.017, 0.006, 0.032, [[e, 1]]),
    R(0.018, -0.126, 0.024, 0.005, 0.014, [[e, 1]]),
  ];
}
function tongueRings() {
  const R = (y, z, w, h) => ({ p: [0, y, z], w, ht: h, hb: h, b: [['jaw', 1]] });
  return [R(0.638, 0.54, 0.01, 0.0035), R(0.636, 0.575, 0.012, 0.0035), R(0.635, 0.605, 0.01, 0.003), R(0.634, 0.618, 0.006, 0.0025)];
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
  const mb = new MeshBuilder(), seg = LOWQ ? 18 : 26, lseg = LOWQ ? 8 : 12;
  const body = mb.tube(bodyRings(f), { ...ATLAS.body, id: 'body', seam: -Math.PI / 2 }, seg, BI);
  const legs = [
    mb.tube(frontLegRings(1, f), { ...ATLAS.legFL, id: 'legFL', seam: Math.PI }, lseg, BI),
    mb.tube(frontLegRings(-1, f), { ...ATLAS.legFR, id: 'legFR', seam: 0 }, lseg, BI),
    mb.tube(hindLegRings(1, f), { ...ATLAS.legHL, id: 'legHL', seam: Math.PI }, lseg, BI),
    mb.tube(hindLegRings(-1, f), { ...ATLAS.legHR, id: 'legHR', seam: 0 }, lseg, BI),
  ];
  const tail = mb.tube(tailRings(), { ...ATLAS.tail, id: 'tail', capStart: false }, 7, BI);
  const ears = [
    mb.tube(earRings(1, f), { ...ATLAS.earL, id: 'earL', seam: Math.PI / 2 }, 8, BI),
    mb.tube(earRings(-1, f), { ...ATLAS.earR, id: 'earR', seam: Math.PI / 2 }, 8, BI),
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
  const circAt = (v) => { // metres around the tube at atlas v
    const t = (v - reg.v0) / (reg.v1 - reg.v0), vs = reg.vs, c = reg.circ;
    for (let i = 1; i < vs.length; i++) { const a = (vs[i - 1] - reg.v0) / (reg.v1 - reg.v0), b = (vs[i] - reg.v0) / (reg.v1 - reg.v0); if (t <= b) return lerp(c[i - 1], c[i], clamp((t - a) / (b - a || 1), 0, 1)); }
    return c[c.length - 1];
  };
  const spots = [];
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

// Paint the atlas for one dog: coat, spots per region, black nose and eye rims, lip line, collar / tongue patches.
function coatTexture(THREE, parts, spec) {
  const W = LOWQ ? 1024 : 2048, H = W, rand = mulberry32(spec.seed);
  const c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, W, H);
  furGrain(g, W, H, rand);
  g.fillStyle = '#17161a';
  const body = parts.body, vNeck = body.vs[8], vHead = body.vs[11], vNose = lerp(body.vs[16], body.vs[17], 0.35);
  const bodySize = (v) => (v < vNeck ? 1 : v < vHead ? 0.72 : 0.5);
  if ('filter' in g) g.filter = `blur(${W / 1400}px)`;
  // body: large spots on the trunk, smaller and denser on neck and head
  spotRegion(g, W, H, rand, body, { count: spec.bodySpots, rMin: 0.012, rMax: 0.03, gap: 1.25, vlo: 0.0, vhi: 0.95, size: bodySize });
  spotRegion(g, W, H, rand, body, { count: Math.round(spec.bodySpots * 0.45), rMin: 0.007, rMax: 0.015, gap: 1.2, vlo: 0.6, vhi: 0.96, size: bodySize });
  for (const l of parts.legs) spotRegion(g, W, H, rand, l, { count: 11, rMin: 0.006, rMax: 0.016, gap: 1.25, vlo: 0.0, vhi: 0.95 });
  spotRegion(g, W, H, rand, parts.tail, { count: 7, rMin: 0.005, rMax: 0.011, gap: 1.2, vlo: 0.0, vhi: 0.95 });
  spotRegion(g, W, H, rand, parts.ears[0], { count: spec.earSpots[0], rMin: 0.008, rMax: 0.02, gap: spec.earGap[0], vlo: 0, vhi: 1 });
  spotRegion(g, W, H, rand, parts.ears[1], { count: spec.earSpots[1], rMin: 0.008, rMax: 0.02, gap: spec.earGap[1], vlo: 0, vhi: 1 });
  if ('filter' in g) g.filter = 'none';
  // nose leather: the last ~1.5 cm of the muzzle, all round
  g.fillStyle = '#121113';
  g.fillRect(0, 0, W, (1 - (vNose - 0.004)) * H);
  // soft black eye rims and a lip line along the lower muzzle (seam is at the belly, so u=0.5 is the top line)
  const uvAt = (ringA, t, th) => { const v = lerp(body.vs[ringA], body.vs[ringA + 1], t); return [((th - body.seam) / TAU) * W, (1 - v) * H]; };
  for (const s of [1, -1]) {
    const [ex, ey] = uvAt(13, 0.55, s > 0 ? 0.05 : Math.PI - 0.05);
    const rg = g.createRadialGradient(ex, ey, 0, ex, ey, W * 0.012);
    rg.addColorStop(0, 'rgba(25,22,24,0.85)'); rg.addColorStop(0.55, 'rgba(25,22,24,0.55)'); rg.addColorStop(1, 'rgba(25,22,24,0)');
    g.fillStyle = rg; g.beginPath(); g.ellipse(ex, ey, W * 0.012, W * 0.006, 0, 0, TAU); g.fill();
  }
  {
    const [x0, y0] = uvAt(14, 0.1, -Math.PI / 2 + 0.55), [x1, y1] = uvAt(16, 0.2, -Math.PI / 2 + 0.2);
    g.strokeStyle = 'rgba(30,26,28,0.7)'; g.lineWidth = Math.max(1, W / 900); g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const [x2, y2] = uvAt(14, 0.1, -Math.PI / 2 - 0.55), [x3, y3] = uvAt(16, 0.2, -Math.PI / 2 - 0.2);
    g.beginPath(); g.moveTo(x2 + W, y2); g.lineTo(x3 + W, y3); g.stroke(); // wraps past u=1
  }
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
// Eye sphere texture: dark glossy eye at the front, fur-coloured lid at the top; a blink rotates the lid down.
function eyeTexture(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#1d1410'; g.fillRect(0, 0, s, s);                                                          // dark brown eyeball
  g.fillStyle = '#3a2416'; g.beginPath(); g.ellipse(s * 0.25, s * 0.52, s * 0.11, s * 0.16, 0, 0, TAU); g.fill(); // iris, left eye looks +u
  g.beginPath(); g.ellipse(s * 0.75, s * 0.52, s * 0.11, s * 0.16, 0, 0, TAU); g.fill();
  g.fillStyle = '#050304'; g.beginPath(); g.ellipse(s * 0.25, s * 0.52, s * 0.06, s * 0.1, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(s * 0.75, s * 0.52, s * 0.06, s * 0.1, 0, 0, TAU); g.fill();
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
    map: coat, roughness: 0.78, metalness: 0, sheen: 0.3, sheenRoughness: 0.75, sheenColor: new THREE.Color(0xfff6ea),
    bumpMap: shared.bump, bumpScale: 0.0008,
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

  // eyes + nose: tiny meshes on the head bone (3 draw calls, one shared material)
  const head = byName.head, eyes = [];
  for (const s of [1, -1]) {
    const e = new THREE.Mesh(shared.eyeGeo, shared.eyeMat);
    e.position.set(s * 0.041 * spec.wide, 0.677 - 0.665, 0.525 - 0.43);
    e.rotation.order = 'YXZ'; e.rotation.y = s * 0.5 + (s > 0 ? 0 : Math.PI); // each eye looks a little outward
    e.scale.setScalar(0.0105); e.name = 'eye';
    head.add(e); eyes.push(e);
  }
  const nose = new THREE.Mesh(shared.noseGeo, shared.noseMat);
  nose.position.set(0, 0.641 - 0.665, 0.668 - 0.43); nose.scale.set(0.022, 0.018, 0.015); nose.name = 'nose';
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
// Walls and closed doors come from HOUSE.colliders / HOUSE.doors; furniture the dogs must walk around is listed here
// (the house keeps no colliders for furniture). Points of interest + door passages form a small waypoint graph.
const DOG_R = 0.17;
// Woonkamer furniture, used only when the host passes no opts.obstacles (the v2 app passes its live footprints).
const WOONKAMER_FURNITURE = [
  [6.06, 6.98, 7.75, 10.05], [5.04, 5.66, 8.33, 9.48], [3.95, 4.75, 10.2, 11.0], [7.85, 8.75, 4.55, 5.45], [3.25, 3.6, 7.9, 8.9],
  [3.25, 3.6, 4.8, 6.4], [4.3, 6.0, 0.25, 2.25], [6.5, 6.9, 10.25, 10.65], [8.55, 8.95, 4.2, 4.6], [6.42, 6.82, 11.7, 12.1],
  [3.42, 3.82, 4.25, 4.65], [8.5, 8.9, 7.0, 7.4],
];
// Furniture in the other ground-floor rooms (the host only tracks the woonkamer): zitkamer corner sofa + table + media wall,
// floor lamp, plants, the office corner, the hall bench and the food bowls.
const EXTRA_FURNITURE = [
  [0.05, 0.95, 0.4, 2.5], [0.95, 2.0, 0.4, 1.3], [1.1, 2.0, 1.7, 2.2], [3.2, 3.62, 0.3, 2.3], [0.15, 0.45, 2.63, 2.93], [0.1, 0.6, 3.2, 3.7],
  [1.1, 3.0, 4.6, 6.1],
  [7.07, 7.5, 9.35, 10.45], [8.2, 8.65, 10.8, 11.3],
  [7.8, 8.35, 0.15, 0.55],
];
const BED_X = 3.8, BED_Z = 7.0, BED_R = 0.45, BED_TOP = 0.09;
// sofa spots: { x, z, y, heading } on the seat; a hop-off point on the floor is found automatically (or given as from: { x, z })
const WOONKAMER_SOFA = { id: 'bank', x: 6.45, z: 9.6, y: 0.495, heading: -Math.PI / 2 + 0.3, item: 'bank' };
// points of interest: [id, x, z, facing heading, room, kind]
const POIS = [
  ['bed', BED_X + 0.02, BED_Z, -Math.PI / 2 - 0.4, 'woonkamer', 'bed'],
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
  ['zitrug', 0.7, 5.2, Math.PI, 'zitkamer', 'spot'],
  // door passages and corridor points (not destinations)
  ['d-entree', 7.67, 7.65, 0, null, 'door'], ['d-keuken', 6.6, 2.84, 0, null, 'door'], ['d-zitkamer', 3.67, 2.84, 0, null, 'door'],
  ['w-mid2', 6.3, 4.6, 0, null, 'via'], ['w-entree', 7.65, 9.0, 0, null, 'via'], ['w-zit', 2.6, 2.6, 0, null, 'via'],
  ['w-sofa', 5.85, 10.6, 0, null, 'via'], ['w-win', 5.0, 9.9, 0, null, 'via'],
];

function makeNav(H, opts) {
  const walls = H && H.colliders ? H.colliders[0] : [];
  const doors = H && H.doors ? H.doors.filter((d) => d.l === 0) : [];
  const nodes = POIS.map((p, i) => ({ i, id: p[0], x: p[1], z: p[2], h: p[3], room: p[4], kind: p[5], door: null, spot: null, edges: [] }));
  for (const n of nodes) if (n.kind === 'door') n.door = doors.find((d) => n.x >= d.col[0] - 0.05 && n.x <= d.col[1] + 0.05 && n.z >= d.col[2] - 0.05 && n.z <= d.col[3] + 0.05) || null;
  let furniture = [];
  const hits = (x, z, r, rects) => { for (let i = 0; i < rects.length; i++) { const c = rects[i]; if (x > c[0] - r && x < c[1] + r && z > c[2] - r && z < c[3] + r) return true; } return false; };
  const blocked = (x, z, r) => hits(x, z, r, walls) || hits(x, z, r, furniture);
  const segmentFree = (x0, z0, x1, z1, r) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.08));
    for (let i = 0; i <= n; i++) if (blocked(lerp(x0, x1, i / n), lerp(z0, z1, i / n), r)) return false;
    return true;
  };
  function rebuildEdges() {
    for (const n of nodes) n.edges.length = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.kind === 'walker' || b.kind === 'walker') continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 4.5 && segmentFree(a.x, a.z, b.x, b.z, DOG_R - 0.02)) { a.edges.push(j); b.edges.push(i); }
    }
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
  const roomOf = (x, z) => (H && H.roomAt ? H.roomAt(0, x, z) : 'woonkamer');
  // sofa spots: the host's spot (opts.sofa) plus the woonkamer bank; each gets a hop-off node on the floor next to it
  const sofas = [];
  const addSofa = (s) => {
    if (!s || ![s.x, s.z].every(Number.isFinite)) return;
    const spot = { id: s.id || 'sofa' + sofas.length, x: s.x, z: s.z, y: Number.isFinite(s.y) ? s.y : 0.45, heading: Number.isFinite(s.heading) ? s.heading : 0, item: s.item || null, claim: null, node: -1, jumpX: s.x, jumpZ: s.z, room: roomOf(s.x, s.z) };
    sofas.push(spot);
  };
  addSofa(opts && opts.sofa ? { ...opts.sofa, id: 'sofa' } : null);
  addSofa(WOONKAMER_SOFA);
  for (const s of sofas) {
    const n = { i: nodes.length, id: 'n-' + s.id, x: s.x, z: s.z, h: 0, room: null, kind: 'sofa', door: null, spot: s, edges: [] };
    nodes.push(n); s.node = n.i;
  }
  function placeSofaNodes() {
    for (const s of sofas) {
      const n = nodes[s.node], from = opts && opts.sofa && opts.sofa.from && s.id === 'sofa' ? opts.sofa.from : null;
      let bx = from ? from.x : NaN, bz = from ? from.z : NaN;
      if (!Number.isFinite(bx) || blocked(bx, bz, DOG_R)) {
        bx = NaN; let bd = 1e9;
        for (const r of [0.85, 1.05, 1.3]) for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU, x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
          if (blocked(x, z, DOG_R + 0.02) || roomOf(x, z) !== s.room) continue;
          let ok = false; for (let j = 0; j < nodes.length && !ok; j++) if (nodes[j].kind !== 'sofa' && nodes[j].kind !== 'walker' && Math.hypot(nodes[j].x - x, nodes[j].z - z) < 4 && segmentFree(x, z, nodes[j].x, nodes[j].z, DOG_R - 0.02)) ok = true;
          if (!ok) continue;
          const d = r + Math.abs(wrapAngle(a - s.heading)) * 0.05; if (d < bd) { bd = d; bx = x; bz = z; }
        }
      }
      if (!Number.isFinite(bx)) { bx = s.x; bz = s.z; }
      n.x = s.jumpX = bx; n.z = s.jumpZ = bz; n.h = Math.atan2(s.x - bx, s.z - bz); s.ok = !(bx === s.x && bz === s.z);
    }
  }
  setObstacles(opts && opts.obstacles);
  placeSofaNodes(); rebuildEdges();
  const doorOpen = (n) => !n.door || n.door.angle >= 0.35;
  // Dijkstra (tiny graph; arrays reused)
  const dist = new Float32Array(64), prev = new Int16Array(64), done = new Uint8Array(64);
  function route(from, to, out) { // out: Int16Array, returns length (path from -> ... -> to), 0 when unreachable
    const N = Math.min(nodes.length, 64);
    dist.fill(1e9); prev.fill(-1); done.fill(0); dist[from] = 0;
    for (;;) {
      let u = -1, best = 1e9;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === to) break;
      done[u] = 1;
      const e = nodes[u].edges;
      for (let k = 0; k < e.length; k++) { const v = e[k]; if (done[v] || !doorOpen(nodes[v])) continue; const nd = best + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].z - nodes[v].z); if (nd < dist[v]) { dist[v] = nd; prev[v] = u; } }
    }
    if (dist[to] >= 1e9) return 0;
    let n = 0, c = to; const tmp = out; // fill backwards then reverse
    while (c >= 0 && n < tmp.length) { tmp[n++] = c; c = prev[c]; }
    for (let i = 0, j = n - 1; i < j; i++, j--) { const t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t; }
    return n;
  }
  function nearestNode(x, z, r) { // nearest node reachable in a straight line
    let best = -1, bd = 1e9;
    for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n.kind === 'walker') continue; const d = Math.hypot(n.x - x, n.z - z); if (d < bd && segmentFree(x, z, n.x, n.z, r)) { bd = d; best = i; } }
    return best;
  }
  // circle vs AABB sliding resolution (walls, closed doors, furniture); a dog already inside a footprint is let out gently
  function resolve(d, r) {
    for (let it = 0; it < 2; it++) {
      pushOut(d, r, walls);
      for (let i = 0; i < furniture.length; i++) pushOut1(d, r, furniture[i]);
      for (let i = 0; i < doors.length; i++) if (doors[i].angle < 0.35) pushOut1(d, r, doors[i].col);
    }
  }
  function pushOut(d, r, rects) { for (let i = 0; i < rects.length; i++) pushOut1(d, r, rects[i]); }
  function pushOut1(d, r, c) {
    const px = clamp(d.x, c[0], c[1]), pz = clamp(d.z, c[2], c[3]), ex = d.x - px, ez = d.z - pz, d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return;
    if (d2 > 1e-10) { const l = Math.sqrt(d2); d.x += (ex / l) * (r - l); d.z += (ez / l) * (r - l); }
    else { const o0 = d.x - c[0] + r, o1 = c[1] - d.x + r, o2 = d.z - c[2] + r, o3 = c[3] - d.z + r, m = Math.min(o0, o1, o2, o3) * 0.5; if (m === o0 * 0.5) d.x -= m; else if (m === o1 * 0.5) d.x += m; else if (m === o2 * 0.5) d.z -= m; else d.z += m; }
  }
  return { nodes, sofas, route, nearestNode, resolve, blocked, segmentFree, roomOf, doorOpen, setObstacles: (l) => { setObstacles(l); placeSofaNodes(); rebuildEdges(); }, furniture: () => furniture };
}

// ================================================================ SOUND (synthesised bark, quiet, after a user gesture)
let audioCtx = null;
function bark(pitch = 1, n = 2) {
  try {
    if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; audioCtx = new AC(); }
    if (audioCtx.state === 'suspended') audioCtx.resume();
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
  curl: { // asleep: sphinx body, spine bent round, head down on the forepaws, tail round the flank
    rootY: 0.175, rootP: 0.05, spine: [0, 0.32, 0], chest: [0, 0.28, 0], neck: [0.5, 0.42, 0], neck2: [0.35, 0.3, 0], head: [0.2, 0.15, 0.08],
    thighL: [-1.2, 0, 0.2], shinL: [2.15, 0, 0], footL: [-2.45, 0, 0], thighR: [-1.2, 0, -0.2], shinR: [2.15, 0, 0], footR: [-2.45, 0, 0],
    armL: [0.35, 0.15, 0.05], foreL: [-1.95, 0, 0], pawL: [0.3, 0, 0], armR: [0.35, -0.15, -0.05], foreR: [-1.95, 0, 0], pawR: [0.3, 0, 0],
    tail1: [-0.3, 0.9, 0], tail2: [0, 0.9, 0], tail3: [0, 0.8, 0], tail4: [0, 0.6, 0], tail5: [0, 0.4, 0], earL: [0, 0, 0.25], earR: [0, 0, -0.25],
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
    bump: furBump(THREE), eyeGeo: new THREE.SphereGeometry(1, 14, 10), noseGeo: new THREE.SphereGeometry(1, 10, 8),
    eyeMat: new THREE.MeshPhysicalMaterial({ map: eyeTexture(THREE), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 }),
    noseMat: new THREE.MeshPhysicalMaterial({ color: 0x141217, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.35 }),
    shadowGeo: new THREE.PlaneGeometry(1, 1), shadowMat: new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  shared.noseGeo.scale(1, 1, 1);
  texs.push(shared.bump, shared.eyeMat.map, shared.shadowMat.map); geos.push(shared.eyeGeo, shared.noseGeo, shared.shadowGeo); mats.push(shared.eyeMat, shared.noseMat, shared.shadowMat);
  const fab = fabricTexture(THREE), fab2 = fab.clone(); fab.repeat.set(10, 2); fab2.repeat.set(8, 1); texs.push(fab, fab2);
  const bedMats = { rim: std({ color: 0x8e8577, map: fab, roughness: 0.95 }), cushion: std({ color: 0xd9ccb2, map: fab2, roughness: 0.95 }) };
  const bowlMats = { steel: std({ color: 0xcfd2d6, metalness: 0.9, roughness: 0.3 }), mat: std({ color: 0x4a4f55, roughness: 0.95 }), water: std({ color: 0x9fc4d8, roughness: 0.05, metalness: 0.1 }), kibble: std({ color: 0x8a5a2b, roughness: 1 }) };
  const bed = buildBed(THREE, bedMats, geos, BED_X, BED_Z, 0); scene.add(bed);
  const bowls = buildBowls(THREE, bowlMats, geos, 8.07, 0.35, 0); scene.add(bowls);

  const specs = [
    { name: 'Logan', seed: 4101, scale: 1.0, wide: 1.0, collar: '#2a4fbf', bodySpots: 46, earSpots: [4, 14], earGap: [1.1, 0.35], speed: 0.72, trot: 1.45, pitch: 0.85 },
    { name: 'Gemma', seed: 7207, scale: 0.91, wide: 0.94, collar: '#c4262e', bodySpots: 58, earSpots: [5, 5], earGap: [1.1, 1.1], speed: 0.78, trot: 1.55, pitch: 1.1 },
  ];

  const dogs = specs.map((spec, index) => {
    const P = buildDog(THREE, spec, shared);
    geos.push(P.parts.geo); mats.push(P.mat); texs.push(P.coat);
    const d = {
      name: spec.name, index, spec, group: P.root, P, scale: spec.scale, other: null,
      x: 0, z: 0, heading: 0, speed: 0, lift: 0, onSofa: false, sofa: null, onBed: false, room: 'woonkamer',
      state: 'idle', timer: 2, pose: 'stand', poseW: { stand: 1, sit: 0, lie: 0, curl: 0, bow: 0, scratch: 0 },
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
  const N_BED = node('bed'), N_STAIRS = node('stairs'), N_BOWLS = node('bowls');
  const claims = { bed: null };
  // a sofa spot is usable when its furniture item is shown (the host hides items via state.rooms.<room>.items[id] = false)
  const sofaEnabled = (s) => { if (!s.item || !H || !H.state || !H.state.rooms) return true; const r = H.state.rooms[s.room === 'zitkamer' ? 'zitkamer' : 'woonkamer']; return !(r && r.items && r.items[s.item] === false); };
  const releaseSofa = (d) => { for (const s of nav.sofas) if (s.claim === d && d.sofa !== s) s.claim = null; };

  // ---- state helpers
  function setState(d, s, t) { d.state = s; d.timer = t; }
  function idle(d, t) { setState(d, 'idle', t == null ? 1.5 + Math.random() * 3 : t); d.pose = 'stand'; d.goalKind = null; }
  function planTo(d, nodeIdx, kind) {
    const from = nav.nearestNode(d.x, d.z, DOG_R - 0.03);
    if (from < 0) return false;
    const n = nav.route(from, nodeIdx, d.path);
    if (!n) return false;
    d.pathLen = n; d.pathIdx = 0; d.goal = nodeIdx; d.goalKind = kind; d.stuckT = 0; d.lastProg = 1e9;
    setState(d, 'walk', 8 + n * 5); d.pose = 'stand';
    return true;
  }
  function wander(d) {
    const w = walker(), room = w && w.l === 0 ? nav.roomOf(w.x, w.z) : null;
    for (let k = 0; k < 8; k++) {
      const i = (Math.random() * nav.nodes.length) | 0, n = nav.nodes[i];
      if (!n.room || i === N_BED || i === d.goal) continue;
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
    if (!claims.bed && d.bedCool <= 0 && planTo(d, N_BED, 'bed')) { claims.bed = d; return true; }
    return false;
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
  function startSleep(d, t) { setState(d, 'sleep', t); d.pose = 'curl'; d.sleepT = 0; }
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
    if (d.onBed) { d.onBed = false; claims.bed = null; d.bedCool = 40 + Math.random() * 60; }
    return false;
  }
  function arrive(d) {
    const n = nav.nodes[d.goal], kind = d.goalKind;
    d.goal = -1;
    if (kind === 'bed') { d.onBed = true; d.heading = n.h; return startCircle(d, () => { startLie(d, 2); d.timer = 1.5; d.nextDecision = () => startSleep(d, (evening() ? 50 : 25) + Math.random() * 40); }); }
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
    else { setState(d, 'petted', 3.2); d.pose = (d.onSofa || d.onBed) ? 'sit' : (Math.random() < 0.3 ? 'bow' : 'sit'); d.bowT = d.pose === 'bow' ? 1.3 : 0; }
    const lines = PET_LINES[d.name] || [d.name + ' kwispelt'];
    toast(lines[(Math.random() * lines.length) | 0]);
    if (Math.random() < 0.6) bark(d.spec.pitch, 1 + (Math.random() < 0.4 ? 1 : 0));
    return true;
  }
  function call(name) {
    const d = byName(name) || dogs[0], w = walker();
    if (!w || w.l !== 0) { toast(d.name + ' kan je daar niet vinden'); return false; }
    if (d.onSofa || d.onBed) { leaveFurniture(d); d.nextDecision = () => goToWalker(d, 'come'); d.follow = true; d.followT = 30; toast(d.name + ' komt eraan'); return true; }
    if (goToWalker(d, 'come')) { d.follow = true; d.followT = 30; toast(d.name + ' komt eraan'); if (Math.random() < 0.5) bark(d.spec.pitch, 1); return true; }
    toast(d.name + ' kan niet bij je komen'); return false;
  }
  // walk to a point ~1.1 m from the walker, on the dog's side
  function goToWalker(d, kind) {
    const w = walker(); if (!w || w.l !== 0) return false;
    let dx = d.x - w.x, dz = d.z - w.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const tx = w.x + dx * 1.1, tz = w.z + dz * 1.1;
    if (nav.blocked(tx, tz, DOG_R)) { // fall back to the nearest node to the walker
      const n = nav.nearestNode(w.x, w.z, DOG_R - 0.03); if (n < 0) return false; return planTo(d, n, kind);
    }
    // temporary node: use the walker node slot (last index) as a moving target
    const wn = nav.nodes[nav.nodes.length - 1];
    wn.x = tx; wn.z = tz; wn.h = Math.atan2(w.x - tx, w.z - tz);
    const from = nav.nearestNode(d.x, d.z, DOG_R - 0.03), to = nav.nearestNode(tx, tz, DOG_R - 0.03);
    if (from < 0 || to < 0) return false;
    const n = nav.route(from, to, d.path); if (!n) return false;
    d.pathLen = n; d.pathIdx = 0; d.goal = nav.nodes.length - 1; d.goalKind = kind; d.stuckT = 0; d.lastProg = 1e9;
    if (n < 24) { d.path[n] = nav.nodes.length - 1; d.pathLen = n + 1; }
    setState(d, 'walk', 10 + n * 4); d.pose = 'stand';
    return true;
  }
  nav.nodes.push({ i: nav.nodes.length, id: 'walker', x: 0, z: 0, h: 0, room: null, kind: 'walker', door: null, edges: [] });

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
      if (best.onSofa || best.onBed) { best.lookMode = 'walker'; best.happy = 0.6; return; }
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
        const spd = d.goalKind === 'walker' || d.goalKind === 'come' ? d.spec.trot : d.goalKind === 'follow' ? d.spec.speed * 1.3 : d.spec.speed;
        const dist = steer(d, n.x, n.z, dt, spd);
        moving = true;
        if (dist < (last ? 0.1 : 0.3)) { d.pathIdx++; d.stuckT = 0; d.lastProg = 1e9; if (last) { d.speed *= 0.5; } }
        if (d.goalKind === 'follow' && wd < 1.4) { d.speed = 0; idle(d, 1 + Math.random()); d.lookMode = 'walker'; break; }
        if ((d.goalKind === 'walker' || d.goalKind === 'come') && wd < 1.25) { arrive(d); break; }
        if (dist < d.lastProg - 0.02) { d.lastProg = dist; d.stuckT = 0; } else { d.stuckT += dt; if (d.stuckT > 1.4) { if (d.goal === N_BED) { claims.bed = null; } releaseSofa(d); idle(d, 1); } }
        if (d.timer <= 0) { if (d.goal === N_BED) claims.bed = null; releaseSofa(d); idle(d, 1); }
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
          if (d.onBed || d.onSofa || Math.random() < (evening() ? 0.6 : 0.35)) startSleep(d, (evening() ? 45 : 20) + Math.random() * 30);
          else if (Math.random() < 0.5) startSit(d, 2 + Math.random() * 3);
          else idle(d, 1);
        }
        break;
      case 'sleep':
        d.sleepT += dt;
        if (d.timer <= 0) { d.sleepy = 0; setState(d, 'wake', 2.5); d.pose = 'sit'; d.nextDecision = null; }
        break;
      case 'wake':
        if (d.timer <= 0) {
          if (d.nextDecision) { const f = d.nextDecision; d.nextDecision = null; f(); break; }
          if (d.onSofa && Math.random() < 0.5) { startSit(d, 4 + Math.random() * 6); break; }
          if (leaveFurniture(d)) break;
          idle(d, 0.5);
        }
        break;
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
        if (!d.onSofa && !d.onBed && w && wd > 0.4) faceHeading(d, Math.atan2(w.x - d.x, w.z - d.z), dt);
        if (d.timer <= 0) { if (d.onSofa || d.onBed) { startLie(d, 4 + Math.random() * 6); } else { startSit(d, 1 + Math.random() * 2); d.follow = true; d.followT = 20; } }
        break;
    }
    if (!moving && d.state !== 'hop') d.speed = damp(d.speed, 0, 9, dt);

    // --- movement + collisions (not while on furniture or mid-hop)
    if (d.state !== 'hop' && !d.onSofa) {
      d.x += Math.sin(d.heading) * d.speed * dt; d.z += Math.cos(d.heading) * d.speed * dt;
      // make way for the walker: never stand in their path
      const standing = d.state === 'idle' || d.state === 'sit' || d.state === 'sniff' || d.state === 'happy' || d.state === 'walk';
      if (w && w.l === 0 && wd < 0.62 && wd > 1e-3 && standing && !d.onBed) {
        const k = (0.62 - wd) * 3.5 * dt;
        d.x += ((d.x - w.x) / wd) * k; d.z += ((d.z - w.z) / wd) * k;
        if (d.state === 'sit' && wd < 0.45) idle(d, 0.8);
      } else if (w && w.l === 0 && wd < 0.5 && (d.state === 'lie' || d.state === 'sleep') && !d.onBed) { d.sleepy = 0; setState(d, 'wake', 0.6); d.pose = 'sit'; }
      nav.resolve(d, DOG_R);
      if (!d.onBed && d.goalKind !== 'bed') { // the bed belongs to whoever is in it
        const bx = d.x - BED_X, bz = d.z - BED_Z, bd = Math.hypot(bx, bz), rr = BED_R + 0.08;
        if (bd < rr && bd > 1e-4) { d.x = BED_X + (bx / bd) * rr; d.z = BED_Z + (bz / bd) * rr; }
      }
      if (d.state !== 'walk' || d.goalKind !== 'bed') d.lift = d.onBed ? BED_TOP : 0;
      else d.lift = BED_TOP * (1 - sstep(BED_R - 0.1, BED_R + 0.1, Math.hypot(d.x - BED_X, d.z - BED_Z)));
      if (d.onBed && Math.hypot(d.x - BED_X, d.z - BED_Z) > BED_R + 0.1) { d.onBed = false; claims.bed = null; }
    }
    d.room = nav.roomOf(d.x, d.z) || d.room;
  }
  function separate() {
    const a = dogs[0], b = dogs[1], dx = b.x - a.x, dz = b.z - a.z, dd = Math.hypot(dx, dz), MIN = 0.55;
    if (dd >= MIN || a.state === 'hop' || b.state === 'hop' || a.onSofa !== b.onSofa) return;
    const nx = dd > 1e-4 ? dx / dd : 1, nz = dd > 1e-4 ? dz / dd : 0;
    const pin = (d) => d.state === 'sleep' || d.state === 'lie' || d.onSofa || d.onBed;
    const fa = pin(a) ? 0 : 1, fb = pin(b) ? 0 : 1, tot = fa + fb; if (!tot) return;
    const push = (MIN - dd) / tot;
    if (fa) { a.x -= nx * push; a.z -= nz * push; nav.resolve(a, DOG_R); }
    if (fb) { b.x += nx * push; b.z += nz * push; nav.resolve(b, DOG_R); }
  }

  // ---- animation
  const E = {}; for (const b of POSE_BONES) E[b] = [0, 0, 0]; // scratch eulers (reused)
  const WALK_OFF = { armL: Math.PI / 2, thighR: Math.PI, armR: 3 * Math.PI / 2, thighL: 0 };
  const TROT_OFF = { armL: 0, thighR: 0, armR: Math.PI, thighL: Math.PI };
  function pose(d, dt) {
    const P = d.P, B = P.byName, w = walker();
    // pose weights
    let sum = 0;
    for (const k of POSE_NAMES) { const t = d.pose === k ? 1 : 0; d.poseW[k] = damp(d.poseW[k], t, k === 'curl' || d.pose === 'curl' ? 2.2 : 5, dt); sum += d.poseW[k]; }
    let rootY = 0, rootP = 0;
    for (const b of POSE_BONES) { E[b][0] = 0; E[b][1] = 0; E[b][2] = 0; }
    for (const k of POSE_NAMES) {
      const wgt = d.poseW[k] / sum; if (wgt < 1e-3) continue;
      const p = POSES[k]; rootY += wgt * p.rootY; rootP += wgt * p.rootP;
      for (const b of POSE_BONES) { const r = p[b]; if (r) { E[b][0] += wgt * r[0]; E[b][1] += wgt * r[1]; E[b][2] += wgt * r[2]; } }
    }
    const standW = d.poseW.stand / sum, lying = (d.poseW.lie + d.poseW.curl) / sum, sitW = d.poseW.sit / sum;

    // gait
    const spd = d.speed, turn = 0;
    d.walkBlend = damp(d.walkBlend, clamp((spd + turn) / 0.3, 0, 1) * standW, 8, dt);
    d.trotBlend = damp(d.trotBlend, sstep(0.75, 1.1, spd), 4, dt);
    const stride = lerp(0.42, 0.62, d.trotBlend) * d.scale;
    d.phase = (d.phase + (dt * Math.max(spd, d.walkBlend * 0.12) * TAU) / stride) % TAU;
    const W = d.walkBlend, A = lerp(0.42, 0.5, d.trotBlend);
    const tuck = d.state === 'hop' ? Math.sin(Math.PI * clamp(d.hopT / d.hopDur, 0, 1)) : 0;
    for (const leg of ['armL', 'armR', 'thighL', 'thighR']) {
      const off = lerp(WALK_OFF[leg], TROT_OFF[leg], d.trotBlend), ph = d.phase + off, s = Math.sin(ph), c = Math.cos(ph), sw = c > 0 ? c : 0;
      const front = leg[0] === 'a', side = leg.slice(-1);
      if (front) {
        E[leg][0] += (A * s - 0.1 * sw) * W + tuck * 0.9;
        E['fore' + side][0] += (-0.95 * sw * sw - 0.05) * W - tuck * 1.5;
        E['paw' + side][0] += (0.5 * sw + 0.05) * W + tuck * 0.6;
      } else {
        E[leg][0] += (A * s * 0.9 + 0.05) * W + tuck * 0.6;
        E['shin' + side][0] += (-0.75 * sw * sw - 0.12) * W - tuck * 1.2;
        E['foot' + side][0] += (0.55 * sw * sw + 0.12) * W + tuck * 0.9;
      }
    }
    const bob = (0.012 * Math.sin(2 * d.phase) - 0.01) * W;
    E.spine[2] += 0.03 * Math.sin(d.phase) * W; E.chest[0] += -0.02 * Math.sin(2 * d.phase + 1) * W;
    E.neck[0] += 0.25 * W + 0.03 * Math.sin(2 * d.phase) * W; // head carried lower when walking
    E.neck2[0] += -0.1 * W;
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
    const earSwing = 0.06 * Math.sin(2 * d.phase + 1) * W;
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
    { const es = 0.0105, ey = es * (1 - 0.92 * closed); P.eyes[0].scale.set(es, ey, es); P.eyes[1].scale.set(es, ey, es); }

    // apply (legs and tail are posed in world terms: compensate the pelvis pitch they inherit)
    E.armL[0] += rootP; E.armR[0] += rootP; E.thighL[0] += rootP; E.thighR[0] += rootP; E.tail1[0] += rootP;
    for (const b of POSE_BONES) B[b].rotation.set(E[b][0], E[b][1], E[b][2]);
    const R = B.root; R.position.set(0, rootY + bob + (d.state === 'scratch' ? 0.01 * Math.sin(d.timer * 40) : 0), -0.22); R.rotation.set(-rootP, 0, 0);
    d.group.position.set(d.x, d.lift, d.z); d.group.rotation.y = d.heading;
    // contact shadow follows the footprint
    const sh = P.shadow, sx = lerp(0.62, 0.7, lying) - 0.1 * sitW, sz = lerp(0.42, 0.55, lying);
    sh.scale.set(sx, sz, 1); sh.position.z = lerp(0, -0.05, lying) - 0.1 * sitW;
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
  return { dogs, bed, bowls, dispose, pet, call, update, setObstacles, nav, POSES };
}
