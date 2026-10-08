// dalmatians.js - two animated dalmatians and a dog bed for the house walkthrough.
// Standalone ES module, imports nothing: THREE (0.170.0) is passed in.
//
//   import { addDalmatians, pet } from './dalmatians.js';
//   const { dogs, bed, dispose, update, setObstacles } = addDalmatians(THREE, scene, { onTick, walkableRects, obstacles, sofa });
//   obstacles: [{ x0, x1, z0, z1 }] furniture footprints (inflated 0.3 m); sofa: { x, z, y, heading } spot where Gemma lounges
//   // raycast: raycaster.intersectObjects(dogs.map(d => d.group), true) -> pet(hit.object)
//
// Coordinates: metres, Y up, X 0..9 left->right, Z 0 back facade .. 12.25 front facade.
// Each dog's local forward is +Z; group.rotation.y = heading (forward = (sin h, 0, cos h)).

const DEFAULT_RECTS = [
  { x0: 3.4, z0: 4.3, x1: 6.8, z1: 12.0, y: 0 }, // woonkamer main part
  { x0: 7.1, z0: 4.3, x1: 8.9, z1: 7.4, y: 0 },  // woonkamer right part
  { x0: 3.9, z0: 0.3, x1: 6.4, z1: 3.9, y: 0 },  // dining area
];
const BED_X = 4.0, BED_Z = 9.8, BED_TOP = 0.085;
const BED_HEADING = Math.PI / 2 + 0.35; // lying on the bed facing into the room
const TAU = Math.PI * 2;
const TURN_RATE = 3.0;   // rad/s
const STRIDE = 0.56;     // m per gait cycle at scale 1
const HOP_TIME = 0.42;
const SEPARATION = 0.72; // min distance between dog centres
const BED_AVOID = 0.62;  // wanderer keeps this far from the bed centre

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
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

// ---------------------------------------------------------------- textures
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

// White short coat with irregular, well-separated black spots (soft edges, seamless in U and V).
function spotTexture(THREE, seed, w, h, o) {
  const rand = mulberry32(seed);
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#f7f5f0';
  g.fillRect(0, 0, w, h);
  g.lineWidth = 0.8;
  const grain = Math.round((w * h) / 70); // faint short-hair grain
  for (let i = 0; i < grain; i++) {
    const x = rand() * w, y = rand() * h, len = 1.5 + rand() * 3;
    g.strokeStyle = rand() < 0.55 ? 'rgba(140,130,118,0.07)' : 'rgba(255,255,255,0.4)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 1.2, y + len); g.stroke();
  }
  const spots = [];
  for (let tries = 0; spots.length < o.count && tries < o.count * 80; tries++) {
    const r = o.rMin + (o.rMax - o.rMin) * Math.pow(rand(), 1.7);
    const x = rand() * w, y = h * (o.v0 + (o.v1 - o.v0) * rand());
    let ok = true;
    for (const s of spots) {
      let dx = Math.abs(s.x - x); dx = Math.min(dx, w - dx);
      let dy = Math.abs(s.y - y); dy = Math.min(dy, h - dy);
      const m = s.r + r + o.gap;
      if (dx * dx + dy * dy < m * m) { ok = false; break; }
    }
    if (!ok) continue;
    const np = 9 + ((rand() * 4) | 0), stretch = 0.8 + rand() * 0.45, rot = rand() * Math.PI, pts = [];
    for (let i = 0; i < np; i++) {
      const a = (i / np) * TAU, rr = r * (0.78 + rand() * 0.38);
      const px = Math.cos(a) * rr * stretch, py = (Math.sin(a) * rr) / stretch;
      pts.push(px * Math.cos(rot) - py * Math.sin(rot), px * Math.sin(rot) + py * Math.cos(rot));
    }
    spots.push({ x, y, r, pts });
  }
  const ink = '#1c1a19';
  if ('filter' in g) g.filter = `blur(${o.blur}px)`;
  else { g.shadowColor = ink; g.shadowBlur = o.blur * 2; }
  g.fillStyle = ink;
  for (const s of spots) {
    for (let ox = -w; ox <= w; ox += w) for (let oy = -h; oy <= h; oy += h) {
      const cx = s.x + ox, cy = s.y + oy, R = s.r * 1.5;
      if (cx + R < 0 || cx - R > w || cy + R < 0 || cy - R > h) continue;
      blobPath(g, cx, cy, s.pts);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function fabricTexture(THREE) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d'), rand = mulberry32(77);
  g.fillStyle = '#d6d6d6'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 2) { g.fillStyle = y % 4 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.18)'; g.fillRect(0, y, s, 1); }
  for (let x = 0; x < s; x += 2) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(x, 0, 1, s); }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.14)';
    g.fillRect(rand() * s, rand() * s, 1 + rand() * 2.5, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------- geometry
function scaleUV(geo, su, sv, ou = 0, ov = 0) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  return geo;
}

function torsoGeometry(THREE) {
  const prof = [[0, -0.345], [0.05, -0.336], [0.088, -0.312], [0.11, -0.272], [0.118, -0.21], [0.112, -0.13],
    [0.104, -0.05], [0.11, 0.03], [0.124, 0.11], [0.132, 0.19], [0.128, 0.26], [0.108, 0.315], [0.07, 0.345], [0, 0.356]];
  const SEG = 15;
  const g = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), SEG);
  g.rotateX(Math.PI / 2); // lathe axis Y -> Z, front at +Z
  const bump = (z, c, w) => { const t = 1 - ((z - c) / w) ** 2; return t > 0 ? t * t : 0; };
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let ny = y;
    if (y < 0) ny = y * (1 + 0.3 * bump(z, 0.17, 0.17) - 0.16 * bump(z, -0.1, 0.13)); // deep chest, tucked waist
    else ny = y * (1 + 0.05 * bump(z, -0.22, 0.12)); // slight croup
    pos.setXYZ(i, x * 0.8, ny, z);
  }
  g.computeVertexNormals();
  const n = g.attributes.normal, P = prof.length; // weld seam normals
  for (let j = 0; j < P; j++) {
    const a = j, b = SEG * P + j;
    let nx = n.getX(a) + n.getX(b), ny = n.getY(a) + n.getY(b), nz = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    n.setXYZ(a, nx, ny, nz); n.setXYZ(b, nx, ny, nz);
  }
  return g;
}

// Capsule with V proportional to height (the stock lathe UVs crowd the caps and stretch spots into stripes).
function capsule(THREE, r, len, capSeg, radial) {
  const g = new THREE.CapsuleGeometry(r, len, capSeg, radial);
  const pos = g.attributes.position, uv = g.attributes.uv, h = len / 2 + r;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (pos.getY(i) + h) / (2 * h));
  return g;
}

function buildGeometries(THREE) {
  const G = {};
  G.torso = torsoGeometry(THREE);
  G.neck = scaleUV(capsule(THREE, 0.062, 0.1, 1, 10).scale(0.85, 1, 1), 0.6, 0.5, 0.2, 0.3);
  G.skull = new THREE.SphereGeometry(0.078, 13, 9).scale(0.86, 0.84, 1.05);
  G.muzzle = scaleUV(capsule(THREE, 0.038, 0.075, 2, 10).rotateX(Math.PI / 2).scale(0.88, 0.8, 1), 0.5, 0.5, 0.25, 0.1);
  G.nose = new THREE.SphereGeometry(0.021, 7, 5).scale(1.15, 0.85, 0.85);
  G.eye = new THREE.SphereGeometry(0.0135, 6, 4);
  G.ear = new THREE.SphereGeometry(0.054, 7, 6).scale(0.24, 1, 0.74);
  G.fUpper = scaleUV(capsule(THREE, 0.033, 0.14, 1, 7).translate(0, -0.1, 0), 0.45, 0.45);
  G.fLower = scaleUV(capsule(THREE, 0.025, 0.15, 1, 7).translate(0, -0.095, 0), 0.4, 0.4, 0.3, 0.5);
  G.paw = scaleUV(new THREE.SphereGeometry(0.031, 7, 5).scale(0.95, 0.6, 1.35).translate(0, 0, 0.012), 0.3, 0.3);
  G.haunch = scaleUV(new THREE.SphereGeometry(0.08, 7, 6).scale(0.5, 1.2, 0.92), 0.6, 0.6, 0.1, 0.2);
  G.thigh = scaleUV(capsule(THREE, 0.038, 0.11, 1, 7).scale(0.8, 1, 1.15).translate(0, -0.085, 0), 0.45, 0.45, 0.5, 0);
  G.shin = scaleUV(capsule(THREE, 0.026, 0.12, 1, 6).translate(0, -0.08, 0), 0.4, 0.4, 0.1, 0.6);
  G.meta = scaleUV(capsule(THREE, 0.022, 0.07, 1, 5).translate(0, -0.05, 0), 0.3, 0.3);
  G.tail = [0.021, 0.017, 0.013, 0.009].map((r, i) =>
    scaleUV(capsule(THREE, r, 0.075, 1, 5).translate(0, 0.045, 0), 0.22, 0.25, i * 0.27, i * 0.31));
  G.collar = new THREE.TorusGeometry(0.066, 0.011, 5, 12).rotateX(Math.PI / 2).scale(0.88, 1, 1);
  G.tag = new THREE.CylinderGeometry(0.014, 0.014, 0.004, 8).rotateX(Math.PI / 2);
  return G;
}

function buildBed(THREE, mats, geos, y) {
  const grp = new THREE.Group();
  grp.name = 'dalmatian-dog-bed';
  // outer side up, over the top, down the inner side (front faces outward)
  const rim = [[0.47, 0.0], [0.505, 0.03], [0.52, 0.09], [0.51, 0.15], [0.48, 0.19], [0.43, 0.205],
    [0.38, 0.19], [0.345, 0.15], [0.325, 0.1], [0.31, 0.06]];
  const cushion = [[0.34, 0.02], [0.348, 0.065], [0.33, 0.09], [0.25, 0.1], [0.12, 0.104], [0.0, 0.105]];
  const v2 = (p) => new THREE.Vector2(p[0], p[1]);
  const rimGeo = new THREE.LatheGeometry(rim.map(v2), 44);
  const cushGeo = new THREE.LatheGeometry(cushion.map(v2), 44);
  geos.push(rimGeo, cushGeo);
  for (const [geo, mat] of [[rimGeo, mats.rim], [cushGeo, mats.cushion]]) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
  }
  grp.position.set(BED_X, y, BED_Z);
  return grp;
}

// ---------------------------------------------------------------- dog assembly
function buildDog(THREE, G, M, spec) {
  const root = new THREE.Group();
  root.name = spec.name;
  root.scale.setScalar(spec.scale);
  const body = new THREE.Group();
  root.add(body);
  const meshes = [];
  const mk = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    meshes.push(m);
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

  const torso = mk(G.torso, spec.body, body, 0, 0.46, 0);

  // neck, collar, head
  const neck = group(body, 0, 0.53, 0.25);
  mk(G.neck, spec.body, neck, 0, 0.07, 0);
  mk(G.collar, spec.collar, neck, 0, 0.05, 0);
  mk(G.tag, M.tag, neck, 0, 0.032, 0.066);
  const headLevel = group(neck, 0, 0.165, 0);
  const head = group(headLevel);
  head.rotation.order = 'YXZ';
  head.scale.setScalar(1.1); // slightly large head reads friendlier
  mk(G.skull, spec.head, head, 0, 0.02, 0);
  mk(G.muzzle, spec.head, head, 0, -0.012, 0.09);
  mk(G.nose, M.nose, head, 0, 0.0, 0.163);
  const eyes = [mk(G.eye, M.eye, head, 0.035, 0.03, 0.062), mk(G.eye, M.eye, head, -0.035, 0.03, 0.062)];
  const ears = [];
  for (const side of [1, -1]) {
    const pivot = group(head, side * 0.054, 0.062, -0.012);
    pivot.userData.side = side;
    mk(G.ear, side > 0 ? spec.earL : spec.earR, pivot, side * 0.008, -0.05, 0.004);
    ears.push(pivot);
  }

  // legs: diagonal pairs (LF+RH, RF+LH)
  const legs = [];
  for (const side of [1, -1]) {
    const hip = group(body, side * 0.062, 0.41, 0.215);
    mk(G.fUpper, spec.body, hip).rotation.y = side * 1.3 + spec.legTwist;
    const j1 = group(hip, 0, -0.2, 0);
    mk(G.fLower, spec.body, j1).rotation.y = side * 2.1 + spec.legTwist;
    const paw = group(j1, 0, -0.19, 0);
    mk(G.paw, spec.body, paw);
    legs.push({ front: true, side, off: side > 0 ? 0 : Math.PI, hip, j1, j2: null, paw });
  }
  for (const side of [1, -1]) {
    const hip = group(body, side * 0.06, 0.425, -0.215);
    mk(G.haunch, spec.body, hip, side * 0.008, -0.045, 0.005).rotation.y = side * 0.8 + spec.legTwist;
    mk(G.thigh, spec.body, hip).rotation.y = side * 2.6;
    const j1 = group(hip, 0, -0.17, 0);
    mk(G.shin, spec.body, j1).rotation.y = side * 0.9 + spec.legTwist;
    const j2 = group(j1, 0, -0.16, 0);
    mk(G.meta, spec.body, j2).rotation.y = side * 1.7;
    const paw = group(j2, 0, -0.1, 0);
    mk(G.paw, spec.body, paw);
    legs.push({ front: false, side, off: side > 0 ? Math.PI : 0, hip, j1, j2, paw });
  }

  // tail: chain of tapering segments
  const tail = [];
  let parent = group(body, 0, 0.525, -0.32);
  for (let i = 0; i < G.tail.length; i++) {
    const seg = group(parent, 0, i === 0 ? 0 : 0.09, 0);
    mk(G.tail[i], spec.body, seg).rotation.y = i * 1.9;
    tail.push(seg);
    parent = seg;
  }

  return { root, body, torso, neck, headLevel, head, eyes, ears, legs, tail, meshes };
}

// ---------------------------------------------------------------- public API
const ALL_DOGS = new Set();

/** Make a dog wag hard and do a little hop. Accepts a dog object, its group or any mesh inside it. */
export function pet(target) {
  let o = target;
  if (o && typeof o.pet === 'function' && ALL_DOGS.has(o)) return o.pet();
  while (o) {
    if (o.userData && o.userData.dalmatian) return o.userData.dalmatian.pet();
    o = o.parent;
  }
  return false;
}

export function addDalmatians(THREE, scene, opts = {}) {
  const { onTick } = opts;
  const src = Array.isArray(opts.walkableRects) && opts.walkableRects.length ? opts.walkableRects : DEFAULT_RECTS;
  let rects = src.map((r) => ({
    x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), z0: Math.min(r.z0, r.z1), z1: Math.max(r.z0, r.z1), y: r.y || 0,
  }));
  // stay on one level: the one holding the bed, else the lowest
  const bedRect = rects.find((r) => BED_X >= r.x0 && BED_X <= r.x1 && BED_Z >= r.z0 && BED_Z <= r.z1);
  const levelY = bedRect ? bedRect.y : Math.min(...rects.map((r) => r.y));
  rects = rects.filter((r) => Math.abs(r.y - levelY) < 0.05);
  let totalArea = 0;
  for (const r of rects) totalArea += (r.x1 - r.x0) * (r.z1 - r.z0);

  const insideRects = (x, z, grow) => {
    for (let i = 0; i < rects.length; i++) { const r = rects[i]; if (x >= r.x0 - grow && x <= r.x1 + grow && z >= r.z0 - grow && z <= r.z1 + grow) return true; }
    return false;
  };
  // furniture footprints { x0, x1, z0, z1 } (opts.obstacles / setObstacles), inflated by 0.3 m; the dog bed itself stays reachable
  let obstacles = [];
  function setObstacles(list) {
    obstacles = (Array.isArray(list) ? list : []).filter((o) => o && [o.x0, o.x1, o.z0, o.z1].every(Number.isFinite)).map((o) => ({
      x0: Math.min(o.x0, o.x1) - 0.3, x1: Math.max(o.x0, o.x1) + 0.3, z0: Math.min(o.z0, o.z1) - 0.3, z1: Math.max(o.z0, o.z1) + 0.3,
    }));
  }
  setObstacles(opts.obstacles);
  const blocked = (x, z) => {
    if (Math.hypot(x - BED_X, z - BED_Z) < 0.55) return false;
    for (let i = 0; i < obstacles.length; i++) { const o = obstacles[i]; if (x >= o.x0 && x <= o.x1 && z >= o.z0 && z <= o.z1) return true; }
    return false;
  };
  const inside = (x, z, grow) => insideRects(x, z, grow) && !blocked(x, z);
  const segmentOK = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / 0.12));
    let escaping = blocked(x0, z0); // a dog that ended up inside a footprint may walk out of it
    for (let i = 0; i <= n; i++) {
      const x = lerp(x0, x1, i / n), z = lerp(z0, z1, i / n);
      if (escaping && !blocked(x, z)) escaping = false;
      if (!(escaping ? insideRects(x, z, 0.25) : inside(x, z, 0.25))) return false;
    }
    return true;
  };
  // optional sofa spot { x, z, y, heading }: the second dog (Gemma) lounges there instead of roaming
  const sofa = opts.sofa && [opts.sofa.x, opts.sofa.z].every(Number.isFinite) ? { y: 0.45, heading: 0, ...opts.sofa } : null;

  // ---- shared resources
  const geos = [], mats = [], texs = [];
  const G = buildGeometries(THREE);
  for (const k in G) Array.isArray(G[k]) ? geos.push(...G[k]) : geos.push(G[k]);
  const std = (p) => { const m = new THREE.MeshStandardMaterial(p); mats.push(m); return m; };
  const M = {
    nose: std({ color: 0x141312, roughness: 0.35 }),
    eye: std({ color: 0x1e120b, roughness: 0.15 }),
    tag: std({ color: 0xd8b04c, metalness: 0.85, roughness: 0.3 }),
    red: std({ color: 0xc8242e, roughness: 0.55 }),
    blue: std({ color: 0x2457c9, roughness: 0.55 }),
  };
  const skin = (seed, w, h, o) => {
    const t = spotTexture(THREE, seed, w, h, o);
    texs.push(t);
    return std({ map: t, roughness: 0.7 });
  };
  const fab = fabricTexture(THREE), fab2 = fab.clone();
  fab.repeat.set(12, 2); fab2.repeat.set(10, 1);
  texs.push(fab, fab2);
  const bedMats = {
    rim: std({ color: 0x9a958d, map: fab, roughness: 0.95 }),
    cushion: std({ color: 0xdccfb5, map: fab2, roughness: 0.95 }),
  };
  const bed = buildBed(THREE, bedMats, geos, levelY);
  scene.add(bed);

  const specs = [
    { // Dog 1: bigger homebody, blue collar, loves the bed
      name: 'Logan', scale: 1.0, homebody: true, maxSpeed: 0.8, collar: M.blue, legTwist: 0,
      body: skin(1101, 512, 512, { count: 34, rMin: 8, rMax: 20, gap: 7, blur: 1.3, v0: 0, v1: 1 }),
      head: skin(1102, 256, 128, { count: 8, rMin: 3.5, rMax: 8, gap: 9, blur: 0.9, v0: 0.2, v1: 0.8 }),
      earL: null, earR: null,
    },
    { // Dog 2: smaller wanderer, red collar, finer spots, one dark ear
      name: 'Gemma', scale: 0.88, homebody: false, maxSpeed: 0.85, collar: M.red, legTwist: 0.9,
      body: skin(2201, 512, 512, { count: 52, rMin: 5, rMax: 15, gap: 7, blur: 1.1, v0: 0, v1: 1 }),
      head: skin(2202, 256, 128, { count: 11, rMin: 3, rMax: 7, gap: 7, blur: 0.8, v0: 0.2, v1: 0.8 }),
      earL: null, earR: null,
    },
  ];
  specs[0].earL = specs[0].earR = skin(1103, 128, 128, { count: 6, rMin: 10, rMax: 22, gap: 4, blur: 1.2, v0: 0, v1: 1 });
  specs[1].earR = skin(2203, 128, 128, { count: 7, rMin: 8, rMax: 18, gap: 4, blur: 1.0, v0: 0, v1: 1 });
  specs[1].earL = skin(2204, 128, 128, { count: 18, rMin: 18, rMax: 34, gap: -14, blur: 1.4, v0: 0, v1: 1 });

  const bedSpotX = BED_X - Math.sin(BED_HEADING) * 0.12, bedSpotZ = BED_Z - Math.cos(BED_HEADING) * 0.12;

  const dogs = specs.map((spec, index) => {
    const parts = buildDog(THREE, G, M, spec);
    const d = {
      name: spec.name, index, group: parts.root, scale: spec.scale, homebody: spec.homebody, maxSpeed: spec.maxSpeed,
      parts, other: null,
      x: 0, z: 0, heading: 0, speed: 0, turnSpeed: 0,
      state: 'idle', timer: 1, tx: 0, tz: 0, faceHeading: null, goingToBed: false, onBed: false, bedCooldown: 0, wasInBed: false,
      lieLin: 0, lieTarget: 0, lieDur: 0, sleepy: 0, tailSide: 1,
      walkBlend: 0, phase: Math.random() * TAU, breath: Math.random() * TAU,
      wagPhase: 0, wagAmp: 0.2, petT: 0, petTilt: 0, hopT: HOP_TIME, thumpT: 0,
      headYaw: 0, headPitch: 0, headTilt: 0, lookYaw: 0, lookPitch: 0, lookTilt: 0, lookTimer: 0.5, lastErr: 0,
      blinkT: 1 + Math.random() * 3, blinkDur: 0,
      pet: null, command: null,
    };
    d.pet = () => doPet(d);
    d.command = (cmd) => command(d, cmd);
    parts.root.userData.dalmatian = d;
    for (const m of parts.meshes) m.userData.dalmatian = d;
    scene.add(parts.root);
    ALL_DOGS.add(d);
    return d;
  });
  dogs[0].other = dogs[1];
  dogs[1].other = dogs[0];

  // ---- behaviour helpers
  function setIdle(d, t) { d.state = 'idle'; d.timer = t; d.lieTarget = 0; d.faceHeading = null; d.goingToBed = false; }
  function startLie(d, t) {
    d.state = 'lie'; d.timer = t; d.lieDur = t; d.lieTarget = 1; d.tailSide = Math.random() < 0.5 ? -1 : 1;
  }
  function walkTo(d, x, z, face) {
    d.state = 'walk'; d.tx = x; d.tz = z; d.faceHeading = face;
    d.timer = (Math.hypot(x - d.x, z - d.z) / d.maxSpeed) * 1.8 + 3;
  }
  function pickTarget(d, minDist) {
    const o = d.other;
    for (let k = 0; k < 24; k++) {
      let a = Math.random() * totalArea, r = rects[0];
      for (const rr of rects) { a -= (rr.x1 - rr.x0) * (rr.z1 - rr.z0); if (a <= 0) { r = rr; break; } }
      const mx = Math.min(0.3, (r.x1 - r.x0) / 2), mz = Math.min(0.3, (r.z1 - r.z0) / 2);
      const x = lerp(r.x0 + mx, r.x1 - mx, Math.random()), z = lerp(r.z0 + mz, r.z1 - mz, Math.random());
      if (Math.hypot(x - d.x, z - d.z) < minDist) continue;
      if (Math.hypot(x - o.x, z - o.z) < 0.95) continue;
      if (!d.homebody && Math.hypot(x - BED_X, z - BED_Z) < BED_AVOID + 0.2) continue;
      if (!segmentOK(d.x, d.z, x, z)) continue;
      d.tx = x; d.tz = z;
      return true;
    }
    return false;
  }
  function wander(d) {
    if (pickTarget(d, 1.2) || pickTarget(d, 0.4)) walkTo(d, d.tx, d.tz, null);
    else setIdle(d, 1 + Math.random() * 2);
  }
  function goBed(d) {
    if (!segmentOK(d.x, d.z, bedSpotX, bedSpotZ) || Math.hypot(d.other.x - bedSpotX, d.other.z - bedSpotZ) < 0.6) return wander(d);
    walkTo(d, bedSpotX, bedSpotZ, BED_HEADING);
    d.goingToBed = true;
  }
  function decide(d) {
    if (d.onSofa) return startLie(d, 20 + Math.random() * 25); // stretches, then settles again
    const r = Math.random();
    if (d.bedCooldown > 0) d.bedCooldown--;
    if (d.homebody) {
      if (d.bedCooldown <= 0 && r < 0.6) return goBed(d);
      if (r < 0.85) return wander(d);
      if (r < 0.93) return startLie(d, 5 + Math.random() * 5);
      return setIdle(d, 2 + Math.random() * 3);
    }
    if (r < 0.64) return wander(d);
    if (r < 0.8) return startLie(d, 5 + Math.random() * 5);
    return setIdle(d, 2 + Math.random() * 3);
  }
  function arrive(d) {
    const toBed = d.goingToBed;
    d.faceHeading = null;
    d.goingToBed = false;
    if (toBed) { d.onBed = true; startLie(d, 14 + Math.random() * 16); }
    else setIdle(d, 1.5 + Math.random() * 3);
  }
  function command(d, cmd) {
    if (d.onSofa) return startLie(d, 10 + Math.random() * 10);
    if (cmd === 'bed') return goBed(d);
    if (cmd === 'wander') { d.lieTarget = 0; return wander(d); }
    if (cmd === 'lie') return startLie(d, 5 + Math.random() * 5);
    d.onBed = false; d.sleepy = 0;
    return setIdle(d, 2 + Math.random() * 2);
  }
  function doPet(d) {
    d.petT = 1.8;
    d.petTilt = Math.random() < 0.5 ? -0.3 : 0.3;
    d.sleepy = Math.min(d.sleepy, 0.2);
    if (d.state !== 'lie' && d.lieLin < 0.2) {
      d.hopT = 0;
      if (d.state === 'walk') setIdle(d, 1.8);
      else d.timer = Math.max(d.timer, 1.8);
    }
    return true;
  }
  function moveTo(d, x, z) {
    if (d.onSofa) return;
    if (inside(x, z, 0.12) || (blocked(d.x, d.z) && insideRects(x, z, 0.12))) { d.x = x; d.z = z; }
  }
  const pinned = (d) => d.state === 'lie' || d.lieLin > 0.1;

  // ---- initial placement: Logan lies on the bed, Gemma stands somewhere in the room
  {
    const a = dogs[0], b = dogs[1];
    a.x = bedSpotX; a.z = bedSpotZ; a.heading = BED_HEADING; a.onBed = true; a.wasInBed = true;
    startLie(a, 6 + Math.random() * 8); a.lieLin = 1;
    if (sofa) {
      b.x = sofa.x; b.z = sofa.z; b.heading = sofa.heading; b.onSofa = true;
      startLie(b, 12 + Math.random() * 20); b.lieLin = 1;
    } else {
      b.x = 5.6; b.z = 8.6; b.heading = -2.4;
      if (!inside(b.x, b.z, 0) && pickTarget(b, 0)) { b.x = b.tx; b.z = b.tz; }
      setIdle(b, 0.8 + Math.random());
    }
  }

  // ---- per-frame update (no allocations)
  function behave(d, dt) {
    d.timer -= dt;
    if (d.petT > 0) d.petT -= dt;
    const h0 = d.heading;
    let movingSpeed = 0;
    if (d.state === 'idle') {
      d.lieTarget = 0;
      if (d.timer <= 0 && d.lieLin < 0.02 && d.petT <= 0) decide(d);
    } else if (d.state === 'lie') {
      d.lieTarget = 1;
      if (d.timer <= 0) {
        if (d.onBed) { d.onBed = false; d.bedCooldown = 2; }
        setIdle(d, 1.5 + Math.random() * 2);
      }
    } else if (d.state === 'walk') {
      d.lieTarget = 0;
      if (d.lieLin < 0.05) {
        const dx = d.tx - d.x, dz = d.tz - d.z, dist = Math.hypot(dx, dz);
        if (dist > 0.1 || d.faceHeading !== null) {
          const want = dist > 0.1 ? Math.atan2(dx, dz) : d.faceHeading;
          const err = wrapAngle(want - d.heading);
          d.lastErr = err;
          d.heading = wrapAngle(d.heading + clamp(err, -TURN_RATE * dt, TURN_RATE * dt));
          if (dist > 0.1) {
            const c = Math.max(0, Math.cos(err));
            d.speed = damp(d.speed, d.maxSpeed * c * c * clamp(dist / 0.5, 0.3, 1), 4, dt);
            movingSpeed = d.speed;
          } else if (Math.abs(err) < 0.06) arrive(d);
        } else arrive(d);
        if (d.state === 'walk' && d.timer <= 0) setIdle(d, 1 + Math.random() * 2);
      }
    }
    if (movingSpeed === 0) d.speed = damp(d.speed, 0, 8, dt);
    d.x += Math.sin(d.heading) * movingSpeed * dt;
    d.z += Math.cos(d.heading) * movingSpeed * dt;
    d.turnSpeed = Math.abs(wrapAngle(d.heading - h0)) / Math.max(dt, 1e-4);

    // lie / sleepy blends
    d.lieLin = clamp(d.lieLin + (d.lieTarget ? dt : -dt) / 0.9, 0, 1);
    const sleepyT = d.state === 'lie' && (d.onBed || d.onSofa) && d.timer > 2 && d.timer < d.lieDur - 3 && d.petT <= 0 ? 1 : 0;
    d.sleepy = damp(d.sleepy, sleepyT, 1.2, dt);

    // gait
    const drive = movingSpeed + d.turnSpeed * 0.16;
    d.walkBlend = damp(d.walkBlend, clamp(drive / 0.75, 0, 1), 6, dt);
    d.phase = (d.phase + (dt * drive * TAU) / (STRIDE * d.scale)) % TAU;
    d.breath = (d.breath + dt * (1.9 + 2.5 * d.walkBlend - 0.6 * d.sleepy)) % TAU;

    // tail wag
    let wagT = d.state === 'lie' ? 0.04 + d.sleepy * -0.04 : d.state === 'walk' ? 0.3 : 0.2;
    if (d.state === 'lie' && d.sleepy < 0.5) {
      d.thumpT -= dt;
      if (d.thumpT < -4 - Math.random() * 6) d.thumpT = 1.2;
      if (d.thumpT > 0) wagT = 0.35;
    }
    if (d.petT > 0) wagT = 0.95;
    d.wagAmp = damp(d.wagAmp, wagT, 5, dt);
    d.wagPhase = (d.wagPhase + dt * (d.petT > 0 ? 17 : d.state === 'walk' ? 9 : 7)) % (TAU * 100);

    // head look-around
    d.lookTimer -= dt;
    if (d.lookTimer <= 0) {
      const lying = d.state === 'lie';
      d.lookTimer = (lying ? 2.5 : 1.2) + Math.random() * 3;
      const o = d.other;
      if (Math.random() < 0.3) {
        d.lookYaw = clamp(wrapAngle(Math.atan2(o.x - d.x, o.z - d.z) - d.heading), -0.9, 0.9);
        d.lookPitch = 0.05;
      } else {
        d.lookYaw = (Math.random() * 2 - 1) * (d.state === 'walk' ? 0.3 : 0.75);
        d.lookPitch = (Math.random() - 0.4) * 0.3;
      }
      d.lookTilt = Math.random() < 0.18 ? (Math.random() < 0.5 ? -0.25 : 0.25) : 0;
    }
    let yawT = d.lookYaw, pitchT = d.lookPitch, tiltT = d.lookTilt;
    if (d.state === 'walk') { yawT = clamp(yawT * 0.4 + d.lastErr * 0.6, -0.8, 0.8); tiltT = 0; }
    if (d.petT > 0) { yawT *= 0.3; pitchT = -0.3; tiltT = d.petTilt; }
    yawT *= 1 - d.sleepy;
    d.headYaw = damp(d.headYaw, yawT, 4, dt);
    d.headPitch = damp(d.headPitch, pitchT, 4, dt);
    d.headTilt = damp(d.headTilt, tiltT, 5, dt);

    // blink
    d.blinkT -= dt;
    if (d.blinkT <= 0) { d.blinkT = 2.5 + Math.random() * 4; d.blinkDur = 0.13; }
    if (d.blinkDur > 0) d.blinkDur -= dt;
  }

  function separate() {
    const a = dogs[0], b = dogs[1];
    const dx = b.x - a.x, dz = b.z - a.z, dd = Math.hypot(dx, dz);
    if (dd < SEPARATION) {
      const nx = dd > 1e-4 ? dx / dd : 1, nz = dd > 1e-4 ? dz / dd : 0;
      const fa = pinned(a) ? 0 : 1, fb = pinned(b) ? 0 : 1, tot = fa + fb;
      if (tot > 0) {
        const push = (SEPARATION - dd) / tot;
        if (fa) moveTo(a, a.x - nx * push, a.z - nz * push);
        if (fb) moveTo(b, b.x + nx * push, b.z + nz * push);
      }
    }
    for (let i = 0; i < dogs.length; i++) {
      const d = dogs[i];
      if (d.homebody || pinned(d)) continue;
      const bx = d.x - BED_X, bz = d.z - BED_Z, bd = Math.hypot(bx, bz);
      if (bd < BED_AVOID && bd > 1e-4) moveTo(d, BED_X + (bx / bd) * BED_AVOID, BED_Z + (bz / bd) * BED_AVOID);
    }
  }

  function pose(d, dt) {
    const P = d.parts;
    const lie = d.lieLin * d.lieLin * (3 - 2 * d.lieLin);
    const W = d.walkBlend * (1 - lie), p = d.phase;

    // bed: rise onto the cushion, little hop over the rim
    const bedDist = Math.hypot(d.x - BED_X, d.z - BED_Z);
    const inBed = bedDist < 0.46;
    if (inBed !== d.wasInBed) { d.wasInBed = inBed; if (d.state === 'walk' && d.hopT >= HOP_TIME) d.hopT = 0; }
    const lift = BED_TOP * (1 - smoothstep(0.3, 0.48, bedDist));

    let hop = 0;
    if (d.hopT < HOP_TIME) { d.hopT += dt; hop = Math.sin(Math.PI * Math.min(1, d.hopT / HOP_TIME)) * 0.11; }
    const tuck = hop * 6; // 0..0.66

    d.group.position.set(d.x, d.onSofa ? sofa.y : levelY + lift, d.z);
    d.group.rotation.y = d.heading;
    P.body.position.y = -0.32 * lie - 0.009 * Math.cos(2 * p) * W + hop;
    P.body.rotation.z = 0.025 * Math.sin(p) * W;
    P.body.rotation.x = -0.25 * hop;
    const br = 1 + (0.012 + 0.012 * d.walkBlend) * Math.sin(d.breath);
    P.torso.scale.set(br, br, 1);

    for (let li = 0; li < P.legs.length; li++) {
      const g = P.legs[li];
      const s = Math.sin(p + g.off), c = Math.cos(p + g.off), swing = c > 0 ? c : 0;
      if (g.front) {
        const a = lerp(-0.36 * s * W - tuck * 0.5, -1.38, lie);
        const b = lerp(0.85 * swing * W + tuck * 1.2, 0, lie);
        g.hip.rotation.x = a; g.j1.rotation.x = b;
        g.paw.rotation.x = -(a + b) * lerp(0.5, 1, lie);
      } else {
        const a = lerp(-0.35 - 0.3 * s * W - tuck * 0.3, -1.25, lie);
        const b = lerp(0.9 + 0.45 * swing * W + tuck * 0.6, 2.6, lie);
        const e = lerp(-0.55 - 0.25 * swing * W, 0.22, lie);
        g.hip.rotation.x = a; g.j1.rotation.x = b; g.j2.rotation.x = e;
        g.paw.rotation.x = -(a + b + e);
        g.hip.rotation.z = g.side * 0.22 * lie;
      }
    }

    const neckTilt = lerp(0.55 + 0.035 * Math.sin(2 * p + 0.6) * W, 0.62, lie) + d.sleepy * 0.55 - hop * 1.5;
    P.neck.rotation.x = neckTilt;
    P.headLevel.rotation.x = -neckTilt;
    P.head.rotation.set(d.headPitch + d.sleepy * 0.3 + 0.03 * Math.sin(2 * p) * W, d.headYaw, d.headTilt);

    const flap = 0.07 * Math.sin(2 * p + 1.2) * W;
    for (let ei = 0; ei < P.ears.length; ei++) {
      const e = P.ears[ei];
      e.rotation.z = e.userData.side * (0.24 + flap * 0.6 + hop * 4);
      e.rotation.x = -0.12 + flap;
    }
    const eyeOpen = Math.min(d.blinkDur > 0 ? 0.12 : 1, 1 - 0.88 * clamp(d.sleepy * 1.4 - 0.2, 0, 1));
    P.eyes[0].scale.y = eyeOpen; P.eyes[1].scale.y = eyeOpen;

    const raise = d.petT > 0 ? 0.55 : 0;
    const basePitch = lerp(lerp(-2.6, -2.1, W) + raise, -2.05, lie);
    const curl = lerp(lerp(0.17, 0.24, W), 0.07, lie);
    for (let i = 0; i < P.tail.length; i++) {
      const wag = d.wagAmp * Math.sin(d.wagPhase - i * 0.7);
      P.tail[i].rotation.x = i === 0 ? basePitch : curl;
      P.tail[i].rotation.z = (i === 0 ? wag * 0.8 + 0.55 * lie * d.tailSide : wag * 0.45 + 0.12 * lie * d.tailSide);
    }
  }

  let disposed = false;
  function update(dt) {
    if (disposed) return;
    dt = clamp(dt || 0, 0, 0.1);
    for (let i = 0; i < dogs.length; i++) behave(dogs[i], dt);
    separate();
    for (let i = 0; i < dogs.length; i++) pose(dogs[i], dt);
  }
  update(0);
  const unsub = typeof onTick === 'function' ? onTick((dt) => update(dt)) : null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof unsub === 'function') unsub();
    for (const d of dogs) { scene.remove(d.group); ALL_DOGS.delete(d); }
    scene.remove(bed);
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
  }

  return { dogs, bed, dispose, pet, update, setObstacles };
}
