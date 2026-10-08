/**
 * Ons Huis · VR add-on (WebXR)
 *
 * Walk through the house at real scale in a VR headset (Meta Quest browser, PCVR browsers).
 *
 *   <script type="module" src="modules/vr.js"></script>     (after the main app script)
 *
 * Self-boots once window.HOUSE exists, and also exports install(HOUSE).
 * When immersive-vr is not supported (desktop, phones, the claude.ai iframe) it adds nothing:
 * no button, no listeners, no renderer changes.
 *
 * Controls in the headset
 *   left stick      walk, relative to where you look (hold left grip to walk faster)
 *   right stick     snap turn 30°
 *   trigger         on a door: open/close · on a dalmatian: pet
 *   right trigger   anywhere else: hold to aim a teleport arc, release to jump
 */

const CFG = {
  speed: 1.6, fast: 3.2,          // m/s, same as the desktop walk mode
  dead: 0.18,                     // thumbstick dead zone
  snap: Math.PI / 6, snapOn: 0.7, snapOff: 0.3,
  radius: 0.22,                   // body radius against colliders, same as the desktop walk mode
  step: 0.4,                      // max height difference you can step onto (stairs)
  headroom: 2.0,                  // a stair this far above your feet passes overhead
  rayLen: 6,                      // reach of the controller rays (m)
  fadeFrom: 0.16, fadeTo: 0.04,   // head-to-wall distance where the view starts / finishes fading
  thinWall: 0.16,                 // colliders this thin are walls even inside a room rectangle
  eyeFallback: 1.6,               // eye height when the device has no 'local-floor'
  xrShadow: 1024,                 // shadow-map size while presenting
  arcSpeed: 7, arcGravity: 9.8, arcMax: 12,
  doorClosedAngle: 0.35,          // same threshold the app uses for a door that blocks
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ======================================================================================
   Walk physics: 2-D colliders per level + stairs as ramps.
   Mirrors the app's moveWalker() (circle vs. axis-aligned boxes, 3 passes) and adds stairs.
   If the host exposes HOUSE.walkMove(state, dx, dz) it is used instead (see makeWalk()).
   ====================================================================================== */

// Stair runs from the app's buildStairs(): [lowerLevel, x0, x1, zBottom, zTop, yBottom, yTop]
const DEFAULT_STAIRS = [
  [0, 8.24, 9.0, 10.55, 8.3, 0, 2.76],   // entree → overloop
  [1, 8.2, 9.0, 8.3, 10.25, 2.76, 5.39], // overloop → zolder
  [0, 0, 0.92, 7.73, 5.8, 0, 2.76],      // zitkamer → zolder linkervleugel
];
const DEFAULT_FLOORS = [0, 2.76, 5.39];

function normStair(s) {
  let o = null;
  if (Array.isArray(s)) { const [l, x0, x1, zBot, zTop, yBot, yTop] = s; o = { l, x0, x1, zBot, zTop, yBot, yTop }; }
  else if (s && typeof s === 'object') {
    o = { l: s.l ?? s.level ?? s.lvl, x0: s.x0, x1: s.x1, zBot: s.zBot ?? s.z0, zTop: s.zTop ?? s.z1, yBot: s.yBot ?? s.y0, yTop: s.yTop ?? s.y1 };
  }
  if (!o || ![o.l, o.x0, o.x1, o.zBot, o.zTop, o.yBot, o.yTop].every(Number.isFinite) || o.zBot === o.zTop) return null;
  o.minZ = Math.min(o.zBot, o.zTop); o.maxZ = Math.max(o.zBot, o.zTop);
  o.area = (o.x1 - o.x0) * (o.maxZ - o.minZ);
  return o;
}

export function makePhysics(H) {
  const floors = Array.isArray(H.floors) && H.floors.length ? H.floors.map((f, i) => Number.isFinite(f?.y) ? f.y : Number.isFinite(f?.floor) ? f.floor : DEFAULT_FLOORS[i] ?? 0) : DEFAULT_FLOORS;
  const floorY = l => floors[l] ?? 0;
  const stairs = (Array.isArray(H.stairs) && H.stairs.length ? H.stairs : DEFAULT_STAIRS).map(normStair).filter(Boolean);
  const R = CFG.radius;

  const yOn = (s, z) => s.yBot + clamp((z - s.zBot) / (s.zTop - s.zBot), 0, 1) * (s.yTop - s.yBot);
  const inFoot = (s, x, z) => x >= s.x0 && x <= s.x1 && z >= s.minZ && z <= s.maxZ;
  const touches = (s, l) => s.l === l || s.l + 1 === l;
  const overlap = (c, s) => Math.max(0, Math.min(c[1], s.x1) - Math.max(c[0], s.x0)) * Math.max(0, Math.min(c[3], s.maxZ) - Math.max(c[2], s.minZ));
  // the app blocks whole stair footprints and slab holes with one box each; stairs are walkable here, so drop those
  const isStairBlock = c => stairs.some(s => overlap(c, s) >= 0.7 * s.area);
  const cache = [];
  function baseCols(l) {
    const src = (H.colliders && H.colliders[l]) || [];
    let e = cache[l];
    if (!e || e.src !== src || e.n !== src.length) e = cache[l] = { src, n: src.length, list: src.filter(c => !isStairBlock(c)) };
    return e.list;
  }
  // colliders that apply to a walker state; doors only while (nearly) closed, like the app's activeCols()
  function cols(st, withDoors = true) {
    let list = baseCols(st.l);
    const s = st.s >= 0 ? stairs[st.s] : null;
    if (s) list = list.filter(c => !(c[1] > s.x0 + 0.02 && c[0] < s.x1 - 0.02 && c[3] > s.minZ + 0.02 && c[2] < s.maxZ - 0.02));
    if (!withDoors) return list;
    const out = list.slice();
    for (const d of H.doors || []) if (d && d.l === st.l && d.col && !(d.angle >= CFG.doorClosedAngle)) out.push(d.col);
    return out;
  }
  function collide(list, x, z) {
    for (let it = 0; it < 3; it++) for (const c of list) {
      const px = clamp(x, c[0], c[1]), pz = clamp(z, c[2], c[3]), ex = x - px, ez = z - pz, d2 = ex * ex + ez * ez;
      if (d2 >= R * R) continue;
      if (d2 > 1e-10) { const d = Math.sqrt(d2); x += ex / d * (R - d); z += ez / d * (R - d); }
      else {
        const o = [x - c[0] + R, c[1] - x + R, z - c[2] + R, c[3] - z + R], m = Math.min(...o), i = o.indexOf(m);
        if (i === 0) x -= m; else if (i === 1) x += m; else if (i === 2) z -= m; else z += m;
      }
    }
    return [clamp(x, -14, 24), clamp(z, -16, 26)];
  }
  function onStair(i, y) { const s = stairs[i], mid = (floorY(s.l) + floorY(s.l + 1)) / 2; return { l: y >= mid ? s.l + 1 : s.l, y, s: i }; }
  // what you stand on at (x, z) coming from state st; null = can't go there (stair side, stairwell edge)
  function surface(st, x, z, pitch) {
    if (st.s >= 0 && stairs[st.s] && inFoot(stairs[st.s], x, z)) return onStair(st.s, yOn(stairs[st.s], z));
    const cands = []; let blocked = false;
    for (let i = 0; i < stairs.length; i++) {
      const s = stairs[i];
      if (!touches(s, st.l) || !inFoot(s, x, z)) continue;
      const y = yOn(s, z), dy = y - st.y;
      if (dy > CFG.headroom) continue; // walking underneath it
      if (Math.abs(dy) <= CFG.step) cands.push({ i, y, dy }); else blocked = true;
    }
    if (cands.length) {
      cands.sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy));
      let c = cands[0];
      // two runs meet at the same landing edge (stair down and attic stair up): follow the gaze
      if (cands.length > 1 && Math.abs(pitch) > 0.12) c = cands.reduce((a, b) => (pitch < 0 ? (b.y < a.y ? b : a) : (b.y > a.y ? b : a)));
      return onStair(c.i, c.y);
    }
    if (blocked) return null;
    if (st.s < 0) return { l: st.l, y: floorY(st.l), s: -1 };
    const s = stairs[st.s];
    for (const l of [s.l, s.l + 1]) if (Math.abs(floorY(l) - st.y) <= CFG.step) return { l, y: floorY(l), s: -1 };
    return null;
  }
  function step(st, dx, dz, pitch = 0) {
    const go = (mx, mz) => {
      const [x, z] = collide(cols(st), st.x + mx, st.z + mz);
      const sf = surface(st, x, z, pitch);
      return sf ? { x, z, ...sf } : null;
    };
    return go(dx, dz) || ((dx || dz) && (go(dx, 0) || go(0, dz))) || { ...st };
  }
  // where a teleport to (x, z) on the walker's level would put you; null when you can't stand there
  function teleport(st, x, z) {
    const base = st.s >= 0 ? { ...st, s: -1, y: floorY(st.l) } : st;
    const [cx, cz] = collide(cols(base), x, z);
    if (Math.hypot(cx - x, cz - z) > 0.06) return null;
    const sf = surface(base, cx, cz, 0);
    return sf ? { x: cx, z: cz, ...sf } : null;
  }
  // walls fade the view, furniture does not (leaning over a counter is fine): a collider counts as furniture when it
  // stands inside a room's floor rectangle and is not a thin partition
  const rooms = Array.isArray(H.rooms) ? H.rooms : [];
  const furniture = new WeakMap();
  function isFurniture(c, l) {
    let f = furniture.get(c);
    if (f === undefined) {
      const cx = (c[0] + c[1]) / 2, cz = (c[2] + c[3]) / 2, thin = Math.min(c[1] - c[0], c[3] - c[2]) <= CFG.thinWall;
      f = !thin && rooms.some(r => (r.level ?? r.lvl) === l && (r.rects || []).some(q => cx > q.x0 + 0.02 && cx < q.x1 - 0.02 && cz > q.z0 + 0.02 && cz < q.z1 - 0.02));
      furniture.set(c, f);
    }
    return f;
  }
  // signed distance from a point to the nearest wall-like collider (negative = inside)
  function wallDist(st, x, z) {
    let best = Infinity;
    for (const c of cols(st)) {
      if (isFurniture(c, st.l)) continue;
      const dx = Math.max(c[0] - x, 0, x - c[1]), dz = Math.max(c[2] - z, 0, z - c[3]);
      const d = dx || dz ? Math.hypot(dx, dz) : -Math.min(x - c[0], c[1] - x, z - c[2], c[3] - z);
      if (d < best) best = d;
    }
    // head already through a thin wall (it's clear on the far side): still fully faded
    if (best > 0 && segHit(st, st.x, st.z, x, z, true, true) <= 1) return -1;
    return best;
  }
  // first crossing (0..1) of segment a→b with a collider; Infinity when clear
  function segHit(st, ax, az, bx, bz, withDoors, wallsOnly = false) {
    let best = Infinity; const dx = bx - ax, dz = bz - az;
    for (const c of cols(st, withDoors)) {
      if (wallsOnly && isFurniture(c, st.l)) continue;
      let t0 = 0, t1 = 1, ok = true;
      for (const [p, d, lo, hi] of [[ax, dx, c[0], c[1]], [az, dz, c[2], c[3]]]) {
        if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) { ok = false; break; } continue; }
        let u = (lo - p) / d, v = (hi - p) / d; if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) { ok = false; break; }
      }
      if (ok && t0 < best) best = t0;
    }
    return best;
  }
  function settle(st) { const sf = surface({ ...st, s: -1 }, st.x, st.z, 0); return sf ? { ...st, ...sf } : { ...st, y: floorY(st.l), s: -1 }; }
  return { floorY, stairs, cols, step, teleport, wallDist, segHit, settle, isFurniture };
}

/* ======================================================================================
   install
   ====================================================================================== */

export function install(H) {
  if (!H || !H.renderer || !H.THREE || !H.scene || !H.camera) return null;
  if (H.vr) return H.vr;
  const api = { supported: false, active: false, enter: async () => false, exit() { } };
  H.vr = api;
  const xr = typeof navigator !== 'undefined' ? navigator.xr : null;
  if (!xr || typeof xr.isSessionSupported !== 'function' || (typeof isSecureContext !== 'undefined' && !isSecureContext)) return api;
  let busy = false;
  const check = () => {
    if (api.supported || busy) return;
    busy = true;
    Promise.resolve().then(() => xr.isSessionSupported('immersive-vr'))
      .then(ok => { if (ok && !api.supported) { api.supported = true; setup(H, api); } }, () => { })
      .finally(() => { busy = false; });
  };
  check();
  try { xr.addEventListener('devicechange', check); } catch (e) { /* older runtimes */ }
  return api;
}

function setup(H, api) {
  const { THREE, renderer, scene, camera } = H;
  const phys = makePhysics(H);
  api.physics = phys;
  const walk = makeWalk(H, phys);
  const toast = msg => { try { H.ui?.toast?.(msg); } catch (e) { /* no toast UI */ } };

  // scratch objects
  const V3 = THREE.Vector3, v1 = new V3(), v2 = new V3(), q1 = new THREE.Quaternion(), hq = new THREE.Quaternion(), he = new THREE.Euler(0, 0, 0, 'YXZ');
  const raycaster = new THREE.Raycaster();

  let session = null, starting = false, saved = null, rig = null, unTick = null, refType = 'local-floor';
  let st = null, yaw = 0, align = true, snapArmed = true, blink = 0, head = { x: 0, z: 0, yaw: 0, pitch: 0, ok: false };
  let helpT = 0, helpStart = null, xrEnabledBefore = false, ctrls = null, arc = null, fx = null;

  const btn = addButton(H, () => (session ? api.exit() : api.enter()));

  /* ---------- visuals, built once on the first session ---------- */
  function buildVisuals() {
    // fade sphere around the head; the camera is its parent so it follows the XR pose
    const fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
    fade.renderOrder = 10000; fade.frustumCulled = false; fade.visible = false; fade.name = 'vr-fade';
    // label shown next to whatever a ray points at
    const label = makeLabel(THREE, 512, 96, 0.36);
    label.sprite.visible = false;
    // help card (world-locked in front of you for a few seconds)
    const help = makeLabel(THREE, 1024, 300, 0.9);
    help.draw(['VR-bediening', 'Linkerstick: lopen (grip = sneller)', 'Rechterstick: draaien per 30°', 'Trekker op deur: open/dicht · op hond: aaien', 'Rechtertrekker vasthouden: springen'], true);
    help.sprite.visible = false;
    scene.add(label.sprite, help.sprite);
    fx = { fade, label, help };

    // teleport arc + landing ring
    const N = 64, pos = new Float32Array(N * 3), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x8cc5ae, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
    line.frustumCulled = false; line.visible = false; line.renderOrder = 9000;
    // dots along the arc: a 1 px line alone is hard to see in a headset
    const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: 0x8cc5ae, fog: false }), N);
    dots.frustumCulled = false; dots.count = 0; line.add(dots);
    // landing marker: bright ring + soft disc
    const ring = new THREE.Group(); ring.visible = false; ring.renderOrder = 9000;
    ring.add(new THREE.Mesh(new THREE.RingGeometry(0.2, 0.27, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8cc5ae, transparent: true, opacity: 0.95, depthWrite: false, fog: false })));
    ring.add(new THREE.Mesh(new THREE.CircleGeometry(0.2, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8cc5ae, transparent: true, opacity: 0.3, depthWrite: false, fog: false })));
    scene.add(line, ring);
    arc = { N, pos, g, line, dots, ring, target: null };

    ctrls = [0, 1].map(i => {
      const c = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i);
      const rg = new THREE.BufferGeometry().setFromPoints([new V3(0, 0, 0), new V3(0, 0, -1)]);
      const ray = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
      ray.scale.z = 1.2; ray.visible = false; ray.renderOrder = 9000; ray.frustumCulled = false; c.add(ray);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), new THREE.MeshBasicMaterial({ color: 0x8cc5ae, depthTest: false, fog: false }));
      dot.visible = false; dot.renderOrder = 9001; scene.add(dot);
      const C = { i, c, grip, ray, dot, src: null, hand: null, hover: null, aiming: false };
      c.addEventListener('connected', e => { C.src = e.data; C.hand = e.data?.handedness || null; ray.visible = e.data?.targetRayMode === 'tracked-pointer'; });
      c.addEventListener('disconnected', () => { C.src = null; C.hand = null; C.hover = null; C.aiming = false; ray.visible = false; dot.visible = false; });
      c.addEventListener('selectstart', () => onSelectStart(C));
      c.addEventListener('selectend', () => onSelectEnd(C));
      return C;
    });
    // controller models: three's input-profile models when the addon is available, a simple handle otherwise
    import('three/addons/webxr/XRControllerModelFactory.js').then(({ XRControllerModelFactory }) => {
      const f = new XRControllerModelFactory();
      for (const C of ctrls) C.grip.add(f.createControllerModel(C.grip));
    }).catch(() => {
      for (const C of ctrls) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.12, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2f2c, roughness: 0.6 }));
        m.position.z = 0.03; C.grip.add(m);
      }
    });
  }

  /* ---------- session ---------- */
  api.enter = async function enter() {
    if (session || starting) return false;
    starting = true;
    let s;
    try {
      // requestSession must run inside the click's user activation: nothing awaited before it
      s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    } catch (e) {
      starting = false; console.warn('[vr] requestSession failed:', e?.message || e); toast('VR starten lukte niet.'); return false;
    }
    try {
      session = s;
      if (!ctrls) buildVisuals();
      refType = !s.enabledFeatures || s.enabledFeatures.includes('local-floor') ? 'local-floor' : 'local';
      begin(s);
      xrEnabledBefore = renderer.xr.enabled;
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType(refType);
      await renderer.xr.setSession(s);
      api.active = true; setBtn(true); starting = false;
      return true;
    } catch (e) {
      console.warn('[vr] could not start the session:', e?.message || e);
      starting = false; finish();
      try { await s.end(); } catch (e2) { /* already ended */ }
      toast('VR starten lukte niet.');
      return false;
    }
  };
  api.exit = () => { try { session?.end(); } catch (e) { finish(); } };
  // move the VR walker (e.g. a room jump from the app); yaw optional
  api.place = ({ x, z, l = st?.l ?? 0, yaw: y } = {}) => {
    if (!session || !rig || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    st = phys.settle({ x, z, l, y: phys.floorY(l), s: -1 });
    if (Number.isFinite(y)) { yaw = y; rig.rotation.y = y; }
    alignHead(st.x, st.z, lastHead.hx, lastHead.hz); rig.position.y = st.y + (refType === 'local' ? CFG.eyeFallback : 0); blink = 1;
    walk.sync(st); return true;
  };
  // read-only snapshot for tests and other modules
  api.state = () => (rig && st ? { x: st.x, z: st.z, l: st.l, y: st.y, onStair: st.s, yaw, rig: rig.position.toArray(), head: { ...head }, fade: fx.fade.material.opacity, refType, arc: arc.target ? { x: arc.target.x, z: arc.target.z } : null, hover: ctrls.map(c => c.hover ? c.hover.kind : null) } : null);
  // three restores its own state on 'sessionend'; ours follows
  renderer.xr.addEventListener('sessionend', () => { if (saved) finish(); });

  function begin(s) {
    saved = { mode: H.mode, pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, zoom: camera.zoom, parent: camera.parent, shadows: [] };
    walk.enterWalkMode();
    const w = walk.read();
    st = phys.settle({ x: w.x, z: w.z, l: w.l, y: phys.floorY(w.l), s: -1 });
    if (Number.isFinite(w.y)) st.y = w.y;
    yaw = w.yaw; align = true; snapArmed = true; blink = 1; helpStart = null; helpT = 0;

    rig = new THREE.Group(); rig.name = 'vr-rig';
    rig.position.set(st.x, st.y + (refType === 'local' ? CFG.eyeFallback : 0), st.z); rig.rotation.set(0, yaw, 0);
    scene.add(rig);
    if (camera.parent) camera.parent.remove(camera);
    rig.add(camera); camera.position.set(0, 0, 0); camera.quaternion.identity();
    camera.add(fx.fade);
    for (const C of ctrls) rig.add(C.c, C.grip);

    // lighter shadows while presenting: two eyes at 72–90 Hz on a mobile GPU
    scene.traverse(o => {
      const sh = o.isLight && o.castShadow ? o.shadow : null;
      if (sh?.mapSize && sh.mapSize.x > CFG.xrShadow) { saved.shadows.push([sh, sh.mapSize.x, sh.mapSize.y]); sh.mapSize.set(CFG.xrShadow, CFG.xrShadow); resetShadowMap(sh); }
    });
    unTick = H.onTick(tick);
  }

  function finish() {
    if (!saved) return;
    const sv = saved; saved = null;
    unTick?.(); unTick = null;
    const final = st ? { x: st.x, z: st.z, l: st.l, y: st.y, yaw: head.ok ? head.yaw : yaw } : null;
    for (const C of ctrls || []) { rig?.remove(C.c, C.grip); C.hover = null; C.aiming = false; C.dot.visible = false; }
    if (fx) { fx.fade.removeFromParent(); fx.label.sprite.visible = false; fx.help.sprite.visible = false; }
    if (arc) { arc.line.visible = false; arc.ring.visible = false; arc.target = null; }
    rig?.remove(camera); if (rig) scene.remove(rig); rig = null;
    if (sv.parent) sv.parent.add(camera);
    camera.position.copy(sv.pos); camera.quaternion.copy(sv.quat);
    camera.fov = sv.fov; camera.zoom = sv.zoom; camera.updateProjectionMatrix(); // three's XR camera overwrote fov
    for (const [sh, w, h] of sv.shadows) { sh.mapSize.set(w, h); resetShadowMap(sh); }
    renderer.xr.enabled = xrEnabledBefore;
    session = null; starting = false; api.active = false; setBtn(false);
    if (final) walk.restore(final, sv);
  }

  /* ---------- per frame (runs inside the app's loop, before render) ---------- */
  function tick(dt) {
    if (!session || !rig || !renderer.xr.isPresenting) return;
    const frame = renderer.xr.getFrame?.(), ref = renderer.xr.getReferenceSpace?.();
    const pose = frame && ref ? frame.getViewerPose(ref) : null;
    if (!pose) return;
    const p = pose.transform.position, o = pose.transform.orientation;
    hq.set(o.x, o.y, o.z, o.w); he.setFromQuaternion(hq, 'YXZ');
    const hx = p.x, hz = p.z, pitch = he.x;
    if (align) { alignHead(st.x, st.z, hx, hz); align = false; }

    // 1. physical (room-scale) movement: the walker follows the head; walls stop it (the view fades instead)
    let [wx, wz] = headWorld(hx, hz);
    if (Math.abs(wx - st.x) + Math.abs(wz - st.z) > 1e-4) st = walk.step(st, wx - st.x, wz - st.z, pitch);

    // 2. left stick: smooth locomotion relative to the head direction, sliding along walls
    const L = byHand('left'), Rc = byHand('right');
    const [lx, ly] = stick(L), [rx] = stick(Rc);
    const mag = Math.hypot(lx, ly);
    if (mag > CFG.dead) {
      const k = Math.min(1, (mag - CFG.dead) / (1 - CFG.dead)) / mag, f = -ly * k, s = lx * k;
      const hy = yaw + he.y, sp = (button(L, 1) > 0.5 ? CFG.fast : CFG.speed) * dt;
      const dx = (-Math.sin(hy) * f + Math.cos(hy) * s) * sp, dz = (-Math.cos(hy) * f - Math.sin(hy) * s) * sp;
      const ns = walk.step(st, dx, dz, pitch);
      rig.position.x += ns.x - st.x; rig.position.z += ns.z - st.z; st = ns;
    }

    // 3. right stick: snap turn around the head
    if (snapArmed && Math.abs(rx) > CFG.snapOn) {
      snapArmed = false;
      [wx, wz] = headWorld(hx, hz);
      yaw += -Math.sign(rx) * CFG.snap; rig.rotation.y = yaw;
      alignHead(wx, wz, hx, hz);
    } else if (Math.abs(rx) < CFG.snapOff) snapArmed = true;

    // 4. height: floor of the level, or the stair you are on
    rig.position.y = st.y + (refType === 'local' ? CFG.eyeFallback : 0);
    rig.updateMatrixWorld(true);
    [wx, wz] = headWorld(hx, hz);
    head = { x: wx, z: wz, yaw: yaw + he.y, pitch, ok: true };

    // 5. rays, teleport arc
    for (const C of ctrls) updateRay(C);
    updateLabels();
    updateArc();

    // 6. comfort fade: head inside or against a wall, and the teleport blink
    const d = phys.wallDist(st, wx, wz);
    const wallFade = clamp((CFG.fadeFrom - d) / (CFG.fadeFrom - CFG.fadeTo), 0, 1);
    blink = Math.max(0, blink - dt * 4);
    const a = Math.max(wallFade, blink);
    fx.fade.material.opacity = a; fx.fade.visible = a > 0.003;

    // 7. help card for the first seconds
    updateHelp(dt, wx, wz, hx, hz);

    // 8. keep the app's walker in sync (room name, panel, door aim, level)
    walk.sync(st);
  }

  function headWorld(hx, hz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [rig.position.x + c * hx + s * hz, rig.position.z - s * hx + c * hz];
  }
  // move the rig so that the head (local hx, hz) lands on world (x, z)
  function alignHead(x, z, hx, hz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    rig.position.x = x - (c * hx + s * hz); rig.position.z = z - (-s * hx + c * hz);
  }

  function byHand(h) { for (const C of ctrls) if (C.hand === h && C.src) return C; return null; }
  function stick(C) {
    const a = C?.src?.gamepad?.axes; if (!a) return [0, 0];
    return a.length >= 4 ? [a[2] || 0, a[3] || 0] : [a[0] || 0, a[1] || 0];
  }
  function button(C, i) { const b = C?.src?.gamepad?.buttons?.[i]; return b ? b.value || (b.pressed ? 1 : 0) : 0; }
  function pulse(C, k, ms) { try { C?.src?.gamepad?.hapticActuators?.[0]?.pulse?.(k, ms); } catch (e) { /* no haptics */ } }

  /* ---------- rays: doors and dogs ---------- */
  function targetsFor() {
    const out = [];
    for (const d of H.doors || []) if (d && d.l === st.l && (d.pivot || d.grp)) out.push(d.pivot || d.grp);
    for (const g of H.dogs?.dogs || []) if (g?.group) out.push(g.group);
    return out;
  }
  const shown = o => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  function findDoor(obj) {
    for (let o = obj; o; o = o.parent) {
      if (o.userData?.door) return o.userData.door;
      const d = (H.doors || []).find(dd => dd.pivot === o || dd.grp === o); if (d) return d;
    }
    return null;
  }
  function isDog(obj) {
    const groups = (H.dogs?.dogs || []).map(d => d.group);
    for (let o = obj; o; o = o.parent) if (o.userData?.dalmatian || groups.includes(o)) return true;
    return false;
  }
  function pick(C) {
    if (!C.src || C.src.targetRayMode !== 'tracked-pointer' && C.src.targetRayMode !== 'transient-pointer') return null;
    C.c.getWorldPosition(v1); v2.set(0, 0, -1).applyQuaternion(C.c.getWorldQuaternion(q1));
    raycaster.set(v1, v2); raycaster.far = CFG.rayLen; raycaster.near = 0;
    const hits = raycaster.intersectObjects(targetsFor(), true);
    for (const h of hits) {
      if (!shown(h.object)) continue;
      // walls in between? test the floor-plan colliders along the ray's footprint
      const hd = Math.hypot(h.point.x - v1.x, h.point.z - v1.z);
      if (hd > 0.15) { const t = phys.segHit(st, v1.x, v1.z, h.point.x, h.point.z, false); if (t * hd < hd - 0.12) return { kind: 'none', point: h.point.clone(), dist: h.distance * t }; }
      const door = findDoor(h.object);
      if (door) return { kind: 'door', door, point: h.point.clone(), dist: h.distance };
      if (isDog(h.object)) return { kind: 'dog', obj: h.object, point: h.point.clone(), dist: h.distance };
      return null;
    }
    return null;
  }
  function updateRay(C) {
    if (!C.src) { C.dot.visible = false; return; }
    const prev = C.hover?.kind === 'door' ? C.hover.door : C.hover?.kind === 'dog' ? 'dog' : null;
    const h = C.aiming ? null : pick(C);
    C.hover = h && (h.kind === 'door' || h.kind === 'dog') ? h : null;
    const now = C.hover?.kind === 'door' ? C.hover.door : C.hover ? 'dog' : null;
    if (now && now !== prev) pulse(C, 0.25, 25);
    C.ray.visible = C.src.targetRayMode === 'tracked-pointer' && !C.aiming;
    C.ray.scale.z = h ? Math.max(0.05, h.dist) : 1.2;
    C.ray.material.color.set(C.hover ? 0x8cc5ae : 0xffffff);
    C.ray.material.opacity = C.hover ? 0.95 : 0.45;
    C.dot.visible = !!C.hover; if (C.hover) C.dot.position.copy(C.hover.point);
  }
  function updateLabels() {
    // one label, for the ray that points at something (right hand first)
    const C = [...ctrls].sort((a, b) => (a.hand === 'right' ? -1 : 1) - (b.hand === 'right' ? -1 : 1)).find(c => c.hover);
    const L = fx.label;
    if (!C) { L.sprite.visible = false; return; }
    const txt = C.hover.kind === 'door' ? (C.hover.door.open ? 'Trekker: deur sluiten' : 'Trekker: deur openen') : 'Trekker: aaien';
    L.draw([txt]);
    C.c.getWorldPosition(v1);
    L.sprite.position.copy(C.hover.point).lerp(v1, Math.min(0.5, 0.25 / Math.max(0.3, C.hover.dist))).y += 0.12;
    L.sprite.visible = true;
  }
  function onSelectStart(C) {
    if (!session || !saved) return;
    if (C.hover?.kind === 'door') {
      const d = C.hover.door;
      if (typeof H.toggleDoor === 'function') H.toggleDoor(d); else d.open = !d.open; // the app's own animation takes it from here
      pulse(C, 0.6, 60); return;
    }
    if (C.hover?.kind === 'dog') {
      try { (H.dogs?.pet || (() => false))(C.hover.obj); } catch (e) { /* dog API changed */ }
      pulse(C, 0.35, 140); return;
    }
    if (C.hand === 'right' && C.src?.gamepad) { C.aiming = true; C.ray.visible = false; }
  }
  function onSelectEnd(C) {
    if (!C.aiming) return;
    C.aiming = false;
    const t = arc.target; arc.target = null; arc.line.visible = false; arc.ring.visible = false;
    if (t && session) {
      st = t; alignHead(t.x, t.z, lastHead.hx, lastHead.hz); rig.position.y = st.y + (refType === 'local' ? CFG.eyeFallback : 0); blink = 1;
      walk.sync(st);
    }
  }

  /* ---------- teleport arc (right trigger, held) ---------- */
  const lastHead = { hx: 0, hz: 0 };
  function updateArc() {
    const C = ctrls.find(c => c.aiming && c.src);
    if (!C) { arc.line.visible = false; arc.ring.visible = false; arc.target = null; return; }
    const o = C.c.getWorldPosition(new V3()), vel = new V3(0, 0, -1).applyQuaternion(C.c.getWorldQuaternion(q1)).multiplyScalar(CFG.arcSpeed);
    const ground = phys.floorY(st.l), pts = arc.pos;
    let n = 0, target = null, p = o.clone(), x, z;
    const push = q => { pts[n * 3] = q.x; pts[n * 3 + 1] = q.y; pts[n * 3 + 2] = q.z; n++; };
    push(p);
    for (let i = 0; i < arc.N - 1; i++) {
      const dt = 0.03, q = p.clone().addScaledVector(vel, dt); vel.y -= CFG.arcGravity * dt;
      const t = phys.segHit(st, p.x, p.z, q.x, q.z, true);
      if (t <= 1) { push(p.clone().lerp(q, t)); break; }                      // hits a wall: no landing
      if (q.y <= ground) { const k = (p.y - ground) / (p.y - q.y); const land = p.clone().lerp(q, k); push(land); x = land.x; z = land.z; break; }
      push(q); p = q;
      if (Math.hypot(q.x - o.x, q.z - o.z) > CFG.arcMax) break;
    }
    if (x !== undefined) target = phys.teleport(st, x, z);
    arc.target = target;
    arc.g.attributes.position.needsUpdate = true; arc.g.setDrawRange(0, n);
    const col = target ? 0x8cc5ae : 0xe0705c, m4 = new THREE.Matrix4();
    let k = 0;
    for (let i = 1; i < n; i += 2) arc.dots.setMatrixAt(k++, m4.makeTranslation(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
    arc.dots.count = k; arc.dots.instanceMatrix.needsUpdate = true;
    arc.line.material.color.set(col); arc.dots.material.color.set(col);
    arc.line.visible = true;
    arc.ring.visible = !!target; if (target) arc.ring.position.set(target.x, ground + 0.02, target.z);
  }

  /* ---------- help card ---------- */
  function updateHelp(dt, wx, wz, hx, hz) {
    lastHead.hx = hx; lastHead.hz = hz;
    const S = fx.help.sprite;
    if (helpStart === null) {
      helpStart = { x: wx, z: wz };
      const fwd = head.yaw;
      S.position.set(wx - Math.sin(fwd) * 1.4, st.y + 1.45, wz - Math.cos(fwd) * 1.4);
      S.visible = true; S.material.opacity = 1;
    }
    if (!S.visible) return;
    helpT += dt;
    const moved = Math.hypot(wx - helpStart.x, wz - helpStart.z) > 1.2;
    if (helpT > 9 || moved) { S.material.opacity -= dt * 2; if (S.material.opacity <= 0) S.visible = false; }
  }

  function setBtn(on) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'VR stoppen' : 'Bekijk het huis met een VR-bril';
  }
}

/* ======================================================================================
   host adapters
   ====================================================================================== */

// Walker access: prefer the app's API (HOUSE.walker / setWalker / walkMove / setMode), fall back to what is there.
function makeWalk(H, phys) {
  const { THREE, camera } = H;
  const EYE = 1.65;
  const hostStep = typeof H.walkMove === 'function' ? H.walkMove : null;
  return {
    enterWalkMode() {
      if (H.mode === undefined || H.mode === 'walk') return;
      if (typeof H.setMode === 'function') H.setMode('walk'); else document.getElementById('btnWalk')?.click();
    },
    read() {
      const yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y;
      const w = H.walker;
      if (w && Number.isFinite(w.x) && Number.isFinite(w.z)) return { x: w.x, z: w.z, l: w.l | 0, y: w.y, yaw: Number.isFinite(w.yaw) ? w.yaw : yaw };
      // no walker API: the walk-mode camera sits at (walker.x, floor + EYE, walker.z)
      const p = camera.position; let l = 0, best = Infinity;
      for (let i = 0; i < 3; i++) { const d = Math.abs(p.y - EYE - phys.floorY(i)); if (d < best) { best = d; l = i; } }
      return { x: p.x, z: p.z, l, yaw };
    },
    // big moves (a fast lean, tracking jumps) go in small steps so they can't tunnel through a thin wall
    step(st, dx, dz, pitch) {
      const n = Math.min(40, Math.ceil(Math.hypot(dx, dz) / 0.08));
      if (n > 1) { for (let i = 0; i < n; i++) st = this.step1(st, dx / n, dz / n, pitch); return st; }
      return this.step1(st, dx, dz, pitch);
    },
    step1(st, dx, dz, pitch) {
      if (hostStep) {
        try {
          const r = hostStep({ x: st.x, z: st.z, l: st.l, y: st.y, s: st.s }, dx, dz, { pitch });
          if (r && Number.isFinite(r.x) && Number.isFinite(r.z)) return { x: r.x, z: r.z, l: r.l ?? st.l, y: Number.isFinite(r.y) ? r.y : phys.floorY(r.l ?? st.l), s: r.s ?? -1 };
        } catch (e) { /* fall through to the module's own physics */ }
      }
      return phys.step(st, dx, dz, pitch);
    },
    sync(st) {
      const w = H.walker; if (!w) return;
      w.x = st.x; w.z = st.z; w.l = st.l; if ('y' in w) w.y = st.y;
    },
    restore(final, sv) {
      if (typeof H.setWalker === 'function') { try { H.setWalker({ x: final.x, z: final.z, l: final.l, yaw: final.yaw }); } catch (e) { /* ignore */ } }
      else {
        this.sync(final);
        if (H.mode === 'walk') { camera.position.set(final.x, final.y + EYE, final.z); camera.quaternion.setFromEuler(new THREE.Euler(-0.06, final.yaw, 0, 'YXZ')); }
      }
      if (sv.mode !== undefined && sv.mode !== 'walk' && H.mode !== sv.mode) {
        if (typeof H.setMode === 'function') H.setMode(sv.mode); else document.getElementById(sv.mode === 'doll' ? 'btnDoll' : 'btnWalk')?.click();
      }
    },
  };
}

function resetShadowMap(sh) { if (sh.map) { sh.map.dispose(); sh.map = null; } }

// canvas-texture sprite for short Dutch texts in the headset
function makeLabel(THREE, w, h, worldW) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
  sprite.scale.set(worldW, worldW * h / w, 1); sprite.renderOrder = 9500;
  let last = '';
  return {
    sprite,
    draw(lines, card = false) {
      const key = lines.join('\n'); if (key === last) return; last = key;
      ctx.clearRect(0, 0, w, h);
      const pad = h * 0.12, fs = card ? Math.round(h / (lines.length + 1.2)) : Math.round(h * 0.42);
      ctx.font = `600 ${fs}px "Figtree","Segoe UI",system-ui,sans-serif`;
      const tw = card ? w - 2 * pad : Math.min(w - 4, ctx.measureText(lines[0]).width + 2 * pad);
      const x0 = (w - tw) / 2;
      ctx.fillStyle = 'rgba(21,28,25,0.86)';
      roundRect(ctx, x0, 2, tw, h - 4, Math.min(28, h * 0.3)); ctx.fill();
      ctx.textBaseline = 'middle'; ctx.textAlign = card ? 'left' : 'center';
      lines.forEach((t, i) => {
        ctx.fillStyle = card && i === 0 ? '#8cc5ae' : '#e3eae5';
        ctx.font = `${card && i === 0 ? 700 : 500} ${fs}px "Figtree","Segoe UI",system-ui,sans-serif`;
        const y = card ? pad + fs * 0.6 + i * fs * 1.08 : h / 2;
        ctx.fillText(t, card ? x0 + pad : w / 2, y, tw - 2 * pad);
      });
      tex.needsUpdate = true;
    },
  };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// VR button: the app's tool rail when it has one, else next to the view toggle, else a floating button
function addButton(H, onClick) {
  const title = 'Bekijk het huis met een VR-bril';
  const icon = '<svg width="20" height="13" viewBox="0 0 24 16" aria-hidden="true" style="flex:none"><path fill="currentColor" d="M3 1h18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5.2l-2.1-3h-3.4l-2.1 3H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm3.5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm11 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  if (typeof H.ui?.addTool === 'function') {
    try {
      const el = H.ui.addTool({ id: 'vr', label: 'VR', title, icon, onClick });
      if (el instanceof HTMLElement) { el.setAttribute('aria-pressed', 'false'); return el; }
      const found = document.querySelector('[data-tool="vr"]'); if (found) return found;
      return null;
    } catch (e) { /* fall back to our own button */ }
  }
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'btnVR'; b.title = title; b.setAttribute('aria-label', title); b.setAttribute('aria-pressed', 'false');
  b.innerHTML = `${icon}<span>VR</span>`;
  b.style.cssText = 'display:inline-flex;align-items:center;gap:7px';
  b.addEventListener('click', onClick);
  const row = document.querySelector('#topbar .rail-row');
  if (row) {
    const seg = document.createElement('div'); seg.className = 'seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'VR');
    seg.append(b); row.append(seg);
  } else {
    b.style.cssText += ';position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:20;padding:9px 16px;border-radius:999px;' +
      'border:1px solid var(--line,#d0d7cf);background:var(--accent,#2d5a4c);color:var(--accent-ink,#f3f7f4);font-weight:600;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.2))';
    document.body.append(b);
  }
  return b;
}

/* ======================================================================================
   self-boot
   ====================================================================================== */
(function boot(tries = 0) {
  if (typeof window === 'undefined') return;
  if (window.HOUSE?.renderer) { try { install(window.HOUSE); } catch (e) { console.warn('[vr] install failed:', e); } return; }
  if (tries < 600) setTimeout(() => boot(tries + 1), 100);
})();
