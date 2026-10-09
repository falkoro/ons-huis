// models.js: photoreal furniture for the Ons Huis walkthrough (Poly Haven models, CC0; see CREDITS.txt).
// Self-boots on import (waits for window.HOUSE); also exports install(HOUSE).
//
// HOUSE.models = {
//   ready                      Promise -> { loaded, failed, ms }   (settles when every GLB has loaded or failed)
//   has(kind, variant?)        true once a model for that kind (and variant) has loaded
//   known(kind)                true when the manifest lists the kind (it may still be loading)
//   place(kind, { x, y, z, ry, w, d, h, variant, drop, dress, seed }) -> THREE.Group | null
//       (x, y, z) = floor-centre of the footprint (pendant: y = ceiling height), ry = rotation about Y (front = +Z).
//       The model keeps its real size; it is stretched per axis only within the manifest limits to fill the
//       w x d (x h) footprint. Wall-backed kinds (sofa, bookshelf, media, nightstand) keep their back on the
//       footprint's back edge. dress (default true) adds decor on top (books, vases, fruit bowl, cushions, lamp).
//       pendant: drop = cord length below the ceiling (the cord is stretched; the globe keeps its size), w = globe size.
//   list()                     [{ kind, variant, file, loaded }]
// }
// Every mesh it returns has userData.sharedGeo = true: its geometry is shared, so the host must not dispose it.
// Loading: GLB via fetch; when the host refuses .glb (artifact host) it falls back to <file>.b64.txt.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const BASE = new URL('./', import.meta.url);
const CONCURRENCY = 4;
// kinds that may also shrink/grow uniformly to fit their footprint: [min, max]
const UNIFORM = { armchair: [0.92, 1.0], media: [0.68, 1.05], coffee: [0.85, 1.08], bookshelf: [0.9, 1.0], nightstand: [0.85, 1.05], desk: [0.95, 1.0], table: [0.95, 1.0] };
const BACK = new Set(['sofa', 'bookshelf', 'media', 'nightstand']);
// default variant per kind (may depend on the interior style)
const DEFAULT = {
  chair: st => (st === 'klassiek' || st === 'industrieel') ? 'leather' : 'white',
  armchair: () => 'leather',
  table: () => 'oak',
  plant: (st, o, list) => { // closest natural height
    if (!o.h) return 'medium';
    let best = null, bd = 1e9; for (const e of list) { const d = Math.abs(Math.log(o.h / e.bbox.h)); if (d < bd) { bd = d; best = e.variant; } } return best;
  },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const seedOf = (x, z) => (Math.round(x * 100) * 73856093) ^ (Math.round(z * 100) * 19349663);

async function fetchBytes(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const ct = r.headers.get('content-type') || '';
    if (/text\/html/.test(ct)) throw new Error('html'); // SPA fallback page instead of the file
    return await r.arrayBuffer();
  } catch (e) {
    const r = await fetch(url + '.b64.txt');
    if (!r.ok) throw new Error('model not available: ' + url);
    const s = atob((await r.text()).trim()), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }
}

export function install(H) {
  if (H.models) return H.models;
  const T = H.THREE;
  const entries = [], byKind = new Map(), cache = new Map(); // file -> { scene } | Promise
  const lampMats = new Set();
  let lampLevel = -1;
  const stats = { loaded: 0, failed: 0, bytes: 0, ms: 0 };

  /* ---------- lamps follow the host's time of day (same curve as applyTime) ---------- */
  function lampFactor() { const h = +(H.state?.time ?? 12); return h >= 17.5 ? clamp((h - 17.5) / 1.5, 0, 1) : clamp((7.5 - h) / 1.0, 0, 1); }
  function updateLamps() {
    const lf = lampFactor(); if (Math.abs(lf - lampLevel) < 1e-3) return; lampLevel = lf;
    for (const m of lampMats) m.emissiveIntensity = (m.userData.lampMax ?? 1.6) * lf;
  }
  H.onTick?.(updateLamps);

  /* ---------- loading ---------- */
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  function prepTemplate(e, scene) {
    scene.updateMatrixWorld(true);
    scene.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.userData.sharedGeo = true;
      const m = o.material;
      if (m.map) m.map.anisotropy = Math.min(8, H.renderer.capabilities.getMaxAnisotropy?.() || 4);
      if (m.transparent && m.opacity < 0.5) { o.castShadow = false; m.depthWrite = false; }
      if (m.alphaTest > 0) m.alphaToCoverage = false;
      // pendant: the clear glass (transmission, stripped at build time) becomes an opal globe that glows after dusk
      if (e.kind === 'pendant' && (m.transparent || /glass|globe/i.test(m.name) || (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05))) {
        if (m.transparent || /glass/i.test(m.name)) { m.transparent = false; m.opacity = 1; m.map = null; m.color.set('#f4f1ea'); m.roughness = 0.3; m.metalness = 0; m.depthWrite = true; }
        m.emissive.set('#ffd29a'); m.emissiveMap = null; m.userData.lampMax = 1.8; m.emissiveIntensity = 0; m.needsUpdate = true;
        lampMats.add(m); o.castShadow = false; lampLevel = -1;
      }
    });
    if (e.kind === 'pendant') e.cord = analysePendant(scene);
    return scene;
  }
  async function loadFile(e) {
    if (cache.has(e.file)) return cache.get(e.file);
    const p = (async () => {
      const t0 = performance.now();
      const buf = await fetchBytes(new URL(e.file, BASE).href);
      stats.bytes += buf.byteLength;
      const g = await loader.parseAsync(buf, new URL('./', new URL(e.file, BASE)).href);
      e.loadMs = Math.round(performance.now() - t0);
      return g.scene;
    })();
    cache.set(e.file, p);
    return p;
  }
  async function loadEntry(e) {
    try {
      const scene = await loadFile(e);
      // alias entries share the GLB but need their own template only for bookkeeping
      e.template = e.template || prepTemplate(e, scene);
      e.loaded = true; stats.loaded++;
    } catch (err) { e.failed = true; stats.failed++; console.warn('[models] ' + e.file + ': ' + (err?.message || err)); }
  }

  const t0 = performance.now();
  const ready = (async () => {
    let man;
    try { man = JSON.parse(new TextDecoder().decode(await fetchBytes(new URL('manifest.json', BASE).href))); }
    catch (err) { console.warn('[models] no manifest', err); return { ...stats, ms: 0 }; }
    for (const m of man.models || []) {
      const add = (kind, variant) => { const e = { ...m, kind, variant }; entries.push(e); if (!byKind.has(kind)) byKind.set(kind, []); byKind.get(kind).push(e); };
      add(m.kind, m.variant || 'default');
      for (const [k, v] of m.alias || []) add(k, v);
    }
    try { await MeshoptDecoder.ready; } catch (err) { console.warn('[models] meshopt decoder unavailable; keeping procedural furniture', err); return { ...stats, ms: 0 }; }
    // big furniture first, decor last
    const order = [...new Set(entries.map(e => e.file))].map(f => entries.find(e => e.file === f));
    const decor = e => /^(books|vase|frame|clock|basket|pillows|fruitbowl)$/.test(e.kind) ? 1 : 0;
    order.sort((a, b) => decor(a) - decor(b));
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < order.length) { const e = order[i++]; await loadEntry(e); } }));
    // aliases share the loaded scene of their file
    for (const e of entries) if (!e.loaded && !e.failed) { const src = entries.find(x => x.file === e.file && x.loaded); if (src) { e.template = src.template; e.cord = src.cord; e.loaded = true; } else e.failed = true; }
    stats.ms = Math.round(performance.now() - t0);
    updateLamps();
    return { ...stats };
  })();

  /* ---------- pendant: stretchable cord ---------- */
  // Bakes the template into float geometry and finds the cord: the span between the ceiling canopy and the
  // globe's cap where every vertex lies within ~1 cm of the axis.
  function analysePendant(scene) {
    const parts = [], v = new T.Vector3();
    let minY = 0; const ys = [];
    scene.traverse(o => {
      if (!o.isMesh) return;
      const src = o.geometry, P = src.attributes.position, pos = new Float32Array(P.count * 3);
      for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(o.matrixWorld); pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z; ys.push([v.y, Math.hypot(v.x, v.z)]); minY = Math.min(minY, v.y); }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      for (const name of ['normal', 'uv', 'tangent']) if (src.attributes[name]) {
        const a = src.attributes[name], arr = new Float32Array(a.count * a.itemSize);
        for (let k = 0; k < a.count; k++) for (let c = 0; c < a.itemSize; c++) arr[k * a.itemSize + c] = a.getComponent(k, c);
        g.setAttribute(name, new T.BufferAttribute(arr, a.itemSize));
      }
      if (src.attributes.normal) { const nm = new T.Matrix3().getNormalMatrix(o.matrixWorld); g.attributes.normal.applyNormalMatrix(nm); }
      if (src.index) g.setIndex(src.index.clone());
      parts.push({ g, m: o.material });
    });
    const H2 = minY / 2; // minY < 0 (origin at the top)
    let canopyBottom = 0, capTop = minY;
    for (const [y, r] of ys) { if (r > 0.02 && y > H2) canopyBottom = Math.min(canopyBottom, y); if (r > 0.02 && y < H2) capTop = Math.max(capTop, y); }
    return { parts, canopyBottom, capTop, minY, cache: new Map() };
  }
  function pendantGeometry(e, dropLocal) {
    const c = e.cord, key = Math.round(dropLocal * 100);
    if (c.cache.has(key)) return c.cache.get(key);
    const delta = (-dropLocal) - c.capTop, lo = c.capTop, hi = c.canopyBottom;
    const out = c.parts.map(({ g, m }) => {
      const ng = g.clone(), P = ng.attributes.position;
      for (let k = 0; k < P.count; k++) {
        const y = P.getY(k);
        if (y <= lo) P.setY(k, y + delta);
        else if (y < hi) P.setY(k, y + delta * (hi - y) / (hi - lo));
      }
      ng.computeBoundingSphere(); ng.computeBoundingBox();
      return { g: ng, m };
    });
    c.cache.set(key, out);
    return out;
  }

  /* ---------- placing ---------- */
  function pick(kind, variant) {
    const list = byKind.get(kind); if (!list) return null;
    const ok = list.filter(e => e.loaded);
    if (variant) { const e = ok.find(e => e.variant === variant); if (e) return e; }
    return null;
  }
  function choose(kind, o = {}) {
    const list = (byKind.get(kind) || []).filter(e => e.loaded); if (!list.length) return null;
    if (o.variant) { const e = list.find(e => e.variant === o.variant); if (e) return e; }
    const dv = DEFAULT[kind]?.(H.state?.style, o, list);
    return list.find(e => e.variant === dv) || list[0];
  }
  function has(kind, variant) { return variant ? !!pick(kind, variant) : !!choose(kind); }

  // fit: returns { u, sx, sy, sz, w, h, d } (fitted size in metres)
  function fit(e, o) {
    const B = e.bbox, st = e.stretch || [1.3, 1.3, 1.3];
    const fx = o.w ? o.w / B.w : null, fy = o.h ? o.h / B.h : null, fz = o.d ? o.d / B.d : null;
    let u = 1;
    if (e.kind === 'plant') u = clamp(Math.min(fy ?? 1, fx ?? Infinity, fz ?? Infinity), 0.45, 1.6); // w/d: keep leaves off nearby walls
    else if (UNIFORM[e.kind]) { const r = UNIFORM[e.kind], m = Math.min(fx ?? Infinity, fz ?? Infinity, fy ?? Infinity); u = Number.isFinite(m) ? clamp(m, r[0], r[1]) : 1; }
    const ax = (f, s) => f ? clamp(f / u, Math.min(s, 1 / s), Math.max(s, 1 / s)) : 1;
    const sx = e.kind === 'plant' ? 1 : ax(fx, st[0]), sy = e.kind === 'plant' ? 1 : ax(fy, st[1]), sz = e.kind === 'plant' ? 1 : ax(fz, st[2]);
    return { u, sx, sy, sz, w: B.w * u * sx, h: B.h * u * sy, d: B.d * u * sz };
  }

  function instance(e, f) {
    const root = e.template.clone(true);
    root.scale.set(f.u * f.sx, f.u * f.sy, f.u * f.sz);
    root.traverse(o => { if (o.isMesh) o.userData.sharedGeo = true; });
    return root;
  }

  function place(kind, o = {}) {
    const e = choose(kind, o); if (!e) return null;
    const g = new T.Group(); g.name = 'model:' + e.kind + ':' + e.variant;
    g.position.set(o.x || 0, o.y || 0, o.z || 0); g.rotation.y = o.ry || 0;
    let f;
    if (e.kind === 'pendant') {
      const u = o.w ? clamp(o.w / e.bbox.w, 0.5, 1.3) : 0.8;
      const drop = Math.max(o.drop ?? 0.7, (0.04 - e.cord.canopyBottom) * u);
      for (const { g: geo, m } of pendantGeometry(e, drop / u)) { const mesh = new T.Mesh(geo, m); mesh.castShadow = false; mesh.receiveShadow = true; mesh.userData.sharedGeo = true; mesh.scale.setScalar(u); g.add(mesh); }
      f = { u, sx: 1, sy: 1, sz: 1, w: e.bbox.w * u, h: drop + (e.cord.capTop - e.cord.minY) * u, d: e.bbox.d * u };
    } else {
      f = fit(e, o);
      const m = instance(e, f);
      // keep the back on the footprint's back edge for wall-backed pieces
      if (o.d && ((o.align || e.align) === 'back' || (BACK.has(e.kind) && o.align !== 'centre'))) m.position.z = (f.d - o.d) / 2;
      g.add(m);
      if (o.dress !== false) dress(e, f, g, m.position.z, o);
    }
    g.userData.model = { kind: e.kind, variant: e.variant, file: e.file, w: +f.w.toFixed(3), h: +f.h.toFixed(3), d: +f.d.toFixed(3), z0: g.children[0]?.position.z || 0 };
    return g;
  }

  /* ---------- decor ---------- */
  function put(g, kind, variant, x, y, z, ry = 0, s = 1) {
    const e = pick(kind, variant) || choose(kind); if (!e) return null;
    const m = e.template.clone(true); m.position.set(x, y, z); m.rotation.y = ry; m.scale.setScalar(s);
    // decor receives shadows but casts none: it is small, dense, and would otherwise dominate the shadow passes
    m.traverse(c => { if (c.isMesh) { c.userData.sharedGeo = true; c.castShadow = false; } });
    g.add(m); return m;
  }
  let lampGeo = null;
  function tableLamp(g, x, y, z, s = 1) {
    if (!lampGeo) {
      const prof = [[0, 0], [0.055, 0], [0.06, 0.012], [0.075, 0.07], [0.078, 0.12], [0.06, 0.2], [0.03, 0.25], [0.012, 0.27], [0.012, 0.33], [0, 0.33]].map(([a, b]) => new T.Vector2(a, b));
      const shadeM = new T.MeshStandardMaterial({ color: '#efe7d8', roughness: 0.95, side: T.DoubleSide, emissive: new T.Color('#ffcf8a'), emissiveIntensity: 0 });
      shadeM.userData.lampMax = 1.5; lampMats.add(shadeM);
      lampGeo = {
        base: new T.LatheGeometry(prof, 32), baseM: new T.MeshStandardMaterial({ color: '#d9cbb5', roughness: 0.35 }),
        shade: new T.CylinderGeometry(0.1, 0.14, 0.2, 40, 1, true), shadeM,
      };
      lampLevel = -1; updateLamps();
    }
    const L = new T.Group(); L.position.set(x, y, z); L.scale.setScalar(s);
    const b = new T.Mesh(lampGeo.base, lampGeo.baseM), sh = new T.Mesh(lampGeo.shade, lampGeo.shadeM);
    sh.position.y = 0.36; b.castShadow = sh.castShadow = true; b.receiveShadow = sh.receiveShadow = true;
    b.userData.sharedGeo = sh.userData.sharedGeo = true;
    L.add(b, sh); g.add(L); return L;
  }
  function dress(e, f, g, z0, o) {
    const R = rng(o.seed ?? seedOf(o.x || 0, o.z || 0)), A = e.anchors || {}, sy = f.u * f.sy;
    const W = f.w, D = f.d, top = (A.top ?? e.bbox.h) * sy;
    const jitter = (a = 0.15) => (R() - 0.5) * a;
    switch (e.kind) {
      case 'sofa': {
        // two cushions in one corner, leaning against the back
        const side = R() < 0.5 ? -1 : 1, pe = pick('pillows', 'chevron');
        if (pe) put(g, 'pillows', 'chevron', side * (W / 2 - 0.62), (A.seat ?? 0.41) * sy - 0.03, z0 - D / 2 + 0.36, side * 0.12, 0.92);
        break;
      }
      case 'coffee': {
        put(g, 'books', 'stack', -W * 0.26, top, jitter(0.1), 0.2 + jitter(0.3));
        put(g, 'plant', 'small', W * 0.28, top, jitter(0.08), R() * 6);
        break;
      }
      case 'table': {
        put(g, 'fruitbowl', 'wood', jitter(0.1), top, jitter(0.06), R() * 6);
        put(g, 'vase', 'tall', W * 0.27, top, jitter(0.08), R() * 6, 0.9);
        break;
      }
      case 'desk': {
        put(g, 'books', 'few', -W / 2 + 0.16, top, -D / 2 + 0.11, 0);
        put(g, 'frame', 'black', W / 2 - 0.2, top, -D / 2 + 0.12, -0.35);
        tableLamp(g, W / 2 - 0.12, top, -D / 2 + 0.25, 0.85);
        break;
      }
      case 'nightstand': {
        tableLamp(g, jitter(0.06), top, z0 - 0.04, 0.9);
        if (A.shelf) put(g, 'books', 'stack', jitter(0.06), A.shelf * sy, z0 + jitter(0.04), R() * 0.6 - 0.3, 0.85);
        break;
      }
      case 'media': {
        put(g, 'plant', 'small', W / 2 - 0.14, top, z0, R() * 6);
        put(g, 'books', 'stack', -W / 2 + 0.2, top, z0, 0.15 + jitter(0.2), 0.9);
        break;
      }
      case 'bookshelf': {
        const sh = (A.shelves || []).map(y => y * sy), bz = z0 - D / 2 + 0.1, inner = W - 0.08;
        const fills = [
          [['basket', 'rattan', -inner / 2 + 0.2, 0], ['books', 'few', inner / 2 - 0.12, 0]],
          [['books', 'row', -inner / 2 + 0.29, 0], ['vase', 'jug', inner / 2 - 0.16, 0.6]],
          [['books', 'few', -inner / 2 + 0.11, 0], ['books', 'stack', 0.05, 0.1], ['plant', 'small', inner / 2 - 0.14, 0]],
          [['vase', 'wide', -inner / 2 + 0.16, 0], ['books', 'few', inner / 2 - 0.12, 0], ['books', 'stack', 0, 0.3]],
        ];
        const order = fills.map((_, i) => i); if (R() < 0.5) order.reverse();
        sh.forEach((y, i) => {
          for (const [k, v, x, ry] of fills[order[i % fills.length]]) {
            const de = pick(k, v); if (!de) continue;
            if (de.bbox.w > inner * 0.95 && k === 'books') { put(g, 'books', 'few', x * 0.5, y, bz, ry); continue; }
            const zz = k === 'books' ? bz + 0.005 : z0 - D / 2 + Math.max(0.1, de.bbox.d / 2 + 0.03);
            put(g, k, v, clamp(x, -inner / 2 + de.bbox.w / 2, inner / 2 - de.bbox.w / 2), y, zz, ry);
          }
        });
        break;
      }
    }
  }

  const api = {
    ready, has, place,
    known: kind => byKind.has(kind) || entries.length === 0,
    list: () => entries.map(e => ({ kind: e.kind, variant: e.variant, file: e.file, loaded: !!e.loaded, ms: e.loadMs })),
    stats,
  };
  H.models = api;
  ready.then(r => {
    if (r.loaded) { try { H.rebuildFurniture?.(); } catch (err) { console.error(err); } }
    window.dispatchEvent(new CustomEvent('house-models-ready', { detail: r }));
  });
  return api;
}

/* ---------- self-boot ---------- */
(function boot(t0 = performance.now()) {
  const H = window.HOUSE;
  if (H && H.THREE && H.scene && H.renderer) { try { install(H); } catch (e) { console.error('[models] install failed', e); } return; }
  if (performance.now() - t0 < 60000) setTimeout(() => boot(t0), 120);
})();
