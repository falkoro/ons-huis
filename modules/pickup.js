// pickup.js: pick up a piece of furniture in walk mode, carry it in front of you, turn it and put it down somewhere else.
// Self-boots on import (waits for window.HOUSE).
//  - Desktop: aim at a piece, E or click = oppakken; E or click = neerzetten; R (Shift+R back) = a quarter-ish turn (45°),
//    scrolling = 15°; Esc or right-click = annuleren (back where it stood).
//  - Phone: tap a piece = oppakken, tap = neerzetten; the bar has Draaien / Neerzetten / Annuleren.
//  - It stands where you carry it: on the floor straight ahead, pushed against a wall rather than through it. It only goes down
//    inside the house on its own floor, clear of walls, doorways, the stairs and other furniture (a red footprint says why not).
//  - The host (index.html) owns the pieces and remembers the moves per look (HOUSE.furniture); "Terug zetten" puts the current
//    look's moved pieces back (undo in the toast). Moved pieces block the dogs (index.html's obstacles()), not the walker,
//    the same as furniture that was never moved.
import { whenHouse, ICONS, injectCSS } from './house-kit.js';

const CSS = `
#carryBar{position:absolute;left:calc((100% - 372px) / 2);transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:7;
  display:flex;flex-direction:column;align-items:center;gap:7px;width:max-content;max-width:min(520px,calc(100vw - 404px));box-sizing:border-box;text-align:center;
  background:var(--ink,#1b231f);color:var(--bg,#fff);font:500 13px/1.35 var(--font-body,system-ui);padding:9px 12px;border-radius:14px;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.2))}
#carryBar[hidden]{display:none}
#carryBar .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:baseline}
#carryBar .t{font-weight:600}
#carryBar .m{opacity:.85;min-width:0;overflow-wrap:anywhere}
#carryBar .m.bad{color:#ffb4a6;opacity:1}
#carryBar .m kbd{font:500 11px/1 var(--font-mono,monospace);border:1px solid rgba(255,255,255,.35);border-radius:4px;padding:1px 4px}
#carryBar button{border:0;background:rgba(255,255,255,.14);color:inherit;font:600 13px/1 var(--font-body,system-ui);border-radius:999px;padding:8px 13px;cursor:pointer}
#carryBar button.go{background:var(--accent,#2d5a4c);color:var(--accent-ink,#fff)}
@media (max-width:760px){#carryBar{left:50%;bottom:calc(212px + env(safe-area-inset-bottom,0px));max-width:calc(100vw - 24px)}}
`;
const COARSE = matchMedia('(pointer: coarse)').matches;
const ROT_KEY = Math.PI / 4, ROT_WHEEL = Math.PI / 12, LIFT = 0.03;
// a name for the aim label and the toasts: one piece, without the "(nu)" / "+ stoelen" of the item's label
const ONE = { Planten: 'plant', Vloerlampen: 'vloerlamp', Nachtkastjes: 'nachtkastje' };
const nameOf = p => p.i >= 0 && /eettafel|bureau/.test(p.iid) ? 'stoel' : (ONE[p.label] || p.label.replace(/\s*[+(].*$/, '')).toLowerCase();
const cap = s => s[0].toUpperCase() + s.slice(1);

// 2-D helpers; rects are [x0, x1, z0, z1]
const overlap = (a, b) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];
const shrink = (r, m) => [r[0] + m, Math.max(r[0] + m, r[1] - m), r[2] + m, Math.max(r[2] + m, r[3] - m)];
// where the segment a -> b first enters rect c: 0..1, or Infinity when it misses (or starts inside)
function enter(ax, az, bx, bz, c) {
  let t0 = 0, t1 = 1;
  for (const [p, d, lo, hi] of [[ax, bx - ax, c[0], c[1]], [az, bz - az, c[2], c[3]]]) {
    if (Math.abs(d) < 1e-9) { if (p <= lo || p >= hi) return Infinity; continue; }
    let ta = (lo - p) / d, tb = (hi - p) / d; if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 >= t1) return Infinity;
  }
  return t0 > 0 ? t0 : Infinity;
}

function install(H) {
  if (H.pickup || !H.furniture) return;
  const T = H.THREE, canvas = H.renderer.domElement, F = H.furniture;
  injectCSS('pickupStyle', CSS);
  const toast = (t, o) => H.ui?.toast?.(t, o);
  let carry = null;

  /* ---------- picking: the host's picker asks hit(ray, far) in walk mode ---------- */
  const v = new T.Vector3(), hits = [];
  // a wall between the eye and the hit (walls are not in the walk pick list): the piece is in the next room
  const behindWall = (l, x, z) => { const c = H.camera.position, k = 1 - 0.05 / Math.max(0.06, Math.hypot(x - c.x, z - c.z)); return H.colliders[l].some(r => enter(c.x, c.z, c.x + (x - c.x) * k, c.z + (z - c.z) * k, r) < 1); };
  function hit(ray, far) {
    const w = H.walker; let best = null;
    for (const p of F.pieces.values()) {
      if (!p.movable || p.l !== w.l || !ray.ray.intersectBox(p.box, v) || v.distanceTo(ray.ray.origin) > far) continue;
      hits.length = 0;
      // batched pieces: only this piece's triangles of the room's merged meshes (raycasting honours the draw range)
      for (const { mesh, start, count } of p.parts) {
        const dr = mesh.geometry.drawRange, s = dr.start, n = dr.count; dr.start = start; dr.count = count;
        try { ray.intersectObject(mesh, false, hits); } finally { dr.start = s; dr.count = n; }
      }
      for (const o of p.objs) ray.intersectObject(o, true, hits);
      for (const h of hits) if (h.distance <= far && (!best || h.distance < best.distance) && !behindWall(p.l, h.point.x, h.point.z))
        best = { distance: h.distance, point: h.point, mesh: h.object, object: p.tag ||= { id: 'piece:' + p.key, userData: {} }, kind: 'piece', piece: p, name: nameOf(p) };
    }
    return best;
  }

  /* ---------- carrying ---------- */
  const markGeo = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const markMat = new T.MeshBasicMaterial({ color: '#3ecf8e', transparent: true, opacity: 0.35, depthWrite: false });
  const mark = new T.Mesh(markGeo, markMat); mark.userData.helper = true; mark.renderOrder = 2;
  // the footprint turned by ry, relative to the piece's origin
  function turned(f, ry) {
    const c = Math.cos(ry), s = Math.sin(ry), r = [Infinity, -Infinity, Infinity, -Infinity];
    for (const lx of [f[0], f[1]]) for (const lz of [f[2], f[3]]) {
      const x = lx * c + lz * s, z = -lx * s + lz * c;
      r[0] = Math.min(r[0], x); r[1] = Math.max(r[1], x); r[2] = Math.min(r[2], z); r[3] = Math.max(r[3], z);
    }
    return r;
  }
  // why the piece cannot go down at (x, z, ry), '' when it can
  function check(x, z, ry) {
    const w = H.walker, p = carry.p, l = p.l, f = turned(carry.foot, ry), r = [x + f[0], x + f[1], z + f[2], z + f[3]];
    if (w.f) return 'niet op de trap';
    if (w.l !== l) return 'alleen op de verdieping waar het vandaan komt';
    if (!H.roomAt(l, x, z)) return 'alleen binnen in huis';
    const s = shrink(r, 0.03);
    if (H.colliders[l].some(c => overlap(s, c))) return 'staat tegen of in een muur';
    if (H.doors.some(d => d.l === l && overlap(s, d.col))) return 'staat in een deuropening';
    if (H.stairs.some(t => (t.l === l || t.l + 1 === l) && overlap(s, [t.x0, t.x1, t.zMin, t.zMax]))) return 'staat op de trap';
    // ponytail: footprints are axis-aligned boxes shrunk by 6 cm each (chairs tuck under tables); fixed pieces built in place
    // (curtains, the zitkamer corner sofa and media wall) do not block. Oriented boxes if that ever matters.
    const s2 = shrink(r, 0.06);
    for (const q of F.pieces.values()) if (q.movable && q.l === l && overlap(s2, shrink([q.foot.min.x, q.foot.max.x, q.foot.min.z, q.foot.max.z], 0.06))) return 'botst met ' + nameOf(q);
    if (l === 0 && (H.office?.obstacles || []).some(o => overlap(s2, o))) return 'botst met de kantoorhoek';
    return '';
  }
  function tick() {
    if (!carry) return;
    if (H.mode !== 'walk' || H.look !== carry.look) { cancel(); return; }
    const w = H.walker, dx = -Math.sin(w.yaw), dz = -Math.cos(w.yaw), f = turned(carry.foot, carry.ry);
    const front = Math.max(f[0] * dx, f[1] * dx) + Math.max(f[2] * dz, f[3] * dz), back = Math.max(-f[0] * dx, -f[1] * dx) + Math.max(-f[2] * dz, -f[3] * dz);
    const near = Math.max(0.45, back + 0.35);
    // straight ahead at the distance you picked it up from; a wall or closed door on the way stops it (pushed against, not through)
    let d = carry.dist = Math.max(carry.dist, near);
    const reach = d + front, cols = H.colliders[w.l].concat(H.doors.filter(o => o.l === w.l && o.angle < 0.35).map(o => o.col));
    let t = Infinity; for (const c of cols) t = Math.min(t, enter(w.x, w.z, w.x + dx * reach, w.z + dz * reach, c));
    if (t <= 1) d = Math.max(near, t * reach - front - 0.01);
    carry.x = w.x + dx * d; carry.z = w.z + dz * d;
    carry.g.position.set(carry.x, w.y + LIFT, carry.z); carry.g.rotation.y = carry.ry;
    const why = check(carry.x, carry.z, carry.ry);
    if (why !== carry.why || carry.fresh) { carry.why = why; carry.fresh = false; markMat.color.set(why ? '#e5484d' : '#3ecf8e'); say(); }
  }
  function grab(p) {
    if (carry || !p?.movable || H.mode !== 'walk') return false;
    const c = F.carry(p.key); if (!c) return false;
    const w = H.walker, fb = c.foot;
    carry = { p, g: c.group, foot: [fb.min.x, fb.max.x, fb.min.z, fb.max.z], x: p.x, z: p.z, ry: p.ry, dist: Math.min(2.2, Math.hypot(p.x - w.x, p.z - w.z)),
      look: H.look, locked: document.pointerLockElement === canvas, why: '', fresh: true, name: nameOf(p) };
    mark.scale.set(fb.max.x - fb.min.x, 1, fb.max.z - fb.min.z); mark.position.set((fb.min.x + fb.max.x) / 2, 0.005 - LIFT, (fb.min.z + fb.max.z) / 2);
    c.group.add(mark);
    // phone: fold the room sheet away, you want to see where it goes
    if (COARSE) { const h = document.getElementById('sheetHandle'); if (h?.getAttribute('aria-expanded') === 'true') h.click(); }
    bar.hidden = false; tick(); return true;
  }
  function finish() {
    const c = carry; carry = null; bar.hidden = true;
    mark.removeFromParent(); c.g.removeFromParent();
    c.g.traverse(o => { if (o.isMesh && !o.userData.sharedGeo) o.geometry?.dispose(); });
    return c;
  }
  function drop() {
    if (!carry) return false;
    if (carry.why) { bar.animate?.([{ transform: 'translateX(-50%) scale(1.05)' }, { transform: 'translateX(-50%)' }], 260); return true; } // the bar says why
    const c = finish(); F.place(c.p.key, [c.x, c.z, c.ry]); toast(`${cap(c.name)} neergezet`);
    return true;
  }
  function cancel() { if (!carry) return false; const c = finish(); F.place(c.p.key); return true; }
  function rotate(a) { if (!carry) return false; carry.ry += a; tick(); return true; }

  /* ---------- the bar while carrying ---------- */
  const bar = document.createElement('div'); bar.id = 'carryBar'; bar.hidden = true; bar.setAttribute('role', 'status');
  const tEl = document.createElement('span'), mEl = document.createElement('span'), row = (...k) => { const d = document.createElement('div'); d.className = 'row'; d.append(...k); return d; };
  tEl.className = 't'; mEl.className = 'm';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; };
  bar.append(row(tEl, mEl), row(btn('Draaien', '', () => rotate(ROT_KEY)), btn('Neerzetten', 'go', drop), btn('Annuleren', '', cancel)));
  (document.getElementById('toast')?.parentNode || document.body).append(bar);
  function say() {
    tEl.textContent = cap(carry.name);
    mEl.classList.toggle('bad', !!carry.why);
    if (carry.why) mEl.textContent = 'past hier niet: ' + carry.why;
    else if (COARSE) mEl.textContent = 'tik om neer te zetten';
    else mEl.innerHTML = '<kbd>E</kbd>/klik: neerzetten · <kbd>R</kbd>/scrollen: draaien · <kbd>Esc</kbd>: annuleren';
  }

  /* ---------- keys, mouse ---------- */
  const typing = () => { const a = document.activeElement; return !!a && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'range' && a.type !== 'checkbox'; };
  addEventListener('keydown', e => {
    if (!carry || typing()) return;
    if (e.code === 'KeyR') { rotate(e.shiftKey ? -ROT_KEY : ROT_KEY); e.preventDefault(); }
    else if (e.code === 'Escape') { cancel(); e.preventDefault(); }
  });
  // Esc while the mouse is captured only releases it (the browser eats the key): that cancels too
  document.addEventListener('pointerlockchange', () => {
    const on = document.pointerLockElement === canvas;
    if (carry && carry.locked && !on) cancel(); else if (carry) carry.locked = on;
  });
  canvas.addEventListener('pointerdown', e => { if (carry && e.button === 2) { cancel(); e.preventDefault(); } });
  canvas.addEventListener('contextmenu', e => { if (carry) e.preventDefault(); });
  canvas.addEventListener('wheel', e => { if (!carry) return; e.preventDefault(); rotate(e.deltaY > 0 ? -ROT_WHEEL : ROT_WHEEL); }, { passive: false });

  /* ---------- "Terug zetten": the current look's moved pieces back home ---------- */
  const reset = H.ui?.addTool?.({ id: 'terugzetten', label: 'Terug zetten', icon: ICONS.undo, title: 'Verplaatste meubels terug op hun plek', onClick: () => {
    cancel();
    const old = F.setMoves({}), n = Object.keys(old).length;
    toast(n === 1 ? 'Het verplaatste meubel staat weer op zijn plek' : `${n} verplaatste meubels staan weer op hun plek`, { action: 'Ongedaan maken', onAction: () => F.setMoves(old) });
  } });
  const syncReset = () => { if (reset) reset.style.display = Object.keys(F.moves).length ? '' : 'none'; };
  H.on('change', () => { if (carry && H.look !== carry.look) cancel(); syncReset(); });
  syncReset();

  H.onTick(tick);
  H.pickup = { get carrying() { return !!carry; }, get piece() { return carry?.p || null; }, get spot() { return carry && { x: carry.x, z: carry.z, ry: carry.ry, why: carry.why }; },
    hit, grab, drop, cancel, rotate, nameOf };
}

whenHouse(install);
