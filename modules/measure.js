// measure.js: "Meten" tool for the Ons Huis walkthrough.
// Self-boots on import (waits for window.HOUSE); also exports install(HOUSE).
//  - Click/tap two points on any surface; the line, end dots and label ("2,37 m") stay until "Wis".
//  - Snaps to wall corners/edges, floor/ceiling junctions and window/door reveals within ~5 cm
//    (radius grows to max 12 cm when far away in the dollhouse so it stays usable); Shift locks to an axis.
//  - Walk mode: aim with the crosshair and press E or tap/click. Dollhouse: mouse or touch pointer.
//  - While active, door clicks / E are suspended and orbit drags keep working (only short clicks place points).
//  - A chip shows the current room's inner width x depth and ceiling height.
import { whenHouse, getKit, ICONS, num, esc, injectCSS } from './house-kit.js';

const CSS = `
.hk-mov{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden;contain:strict}
.hk-mov svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.hk-mov line{stroke-linecap:round}
.hk-mov .halo{stroke:var(--surface,#fff);stroke-width:6;opacity:.85}
.hk-mov .ln{stroke:var(--accent,#2d5a4c);stroke-width:2.4}
.hk-mov .live .ln{stroke-dasharray:7 5}
.hk-mov .lock .ln{stroke:var(--brass,#9a7531)}
.hk-mov .dot{fill:var(--accent,#2d5a4c);stroke:var(--surface,#fff);stroke-width:2}
.hk-mov .lock .dot{fill:var(--brass,#9a7531)}
.hk-mov .snap{fill:none;stroke:var(--brass,#9a7531);stroke-width:2.2}
.hk-mov .snapc{fill:var(--brass,#9a7531)}
.hk-mlbl{position:absolute;left:0;top:0;background:var(--ink,#1b231f);color:var(--bg,#fff);font:600 12.5px/1 var(--font-mono,ui-monospace,monospace);
  padding:5px 8px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.28);font-variant-numeric:tabular-nums;will-change:transform}
.hk-mlbl.live{background:var(--accent,#2d5a4c);color:var(--accent-ink,#fff)}
.hk-mchip{position:absolute;left:16px;top:16px;z-index:5;max-width:min(460px,calc(100% - 32px));box-sizing:border-box;
  background:var(--glass,rgba(247,248,245,.9));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line,#d0d7cf);
  border-radius:14px;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.15));padding:8px 10px 8px 12px;color:var(--ink,#1b231f);font:13px/1.35 var(--font-body,system-ui)}
.hk-mchip .r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.hk-mchip .r1 svg{flex:none;color:var(--accent,#2d5a4c)}
.hk-mchip .rn{font-weight:600;overflow-wrap:anywhere}
.hk-mchip .dims{font:500 12px/1.3 var(--font-mono,ui-monospace,monospace);color:var(--ink-2,#56625b);font-variant-numeric:tabular-nums}
.hk-mchip .r2{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;flex-wrap:wrap}
.hk-mchip .tip{font-size:12px;color:var(--ink-2,#56625b);min-width:0}
.hk-mchip .tip kbd{font:500 11px/1 var(--font-mono,monospace);border:1px solid var(--line,#ccc);border-bottom-width:2px;border-radius:4px;padding:1px 4px;background:var(--surface,#fff);color:var(--ink,#111)}
.hk-mchip .btns{display:flex;gap:6px;margin-left:auto}
.hk-mchip button{border:1px solid var(--line,#d0d7cf);background:var(--surface,#fff);color:var(--ink,#1b231f);border-radius:999px;padding:5px 10px;font:500 12.5px/1 var(--font-body,system-ui);display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.hk-mchip button:disabled{opacity:.45;cursor:default}
.hk-mchip button svg{width:14px;height:14px}
.hk-mchip .cnt{font:500 11px/1 var(--font-mono,monospace);color:var(--ink-2,#56625b)}
.hk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

const SNAP_MIN = 0.05, SNAP_MAX = 0.12, SNAP_PX = 9; // metres / screen px
const AX = ['x', 'y', 'z'];

/* ---------- snapping features from the house data ---------- */
// Each feature is an axis-aligned plane patch {ax, v, b:{x:[lo,hi],y:[..],z:[..]}}. A coordinate snaps when the
// hit point is within R of the plane AND its projection lies inside the patch (+-R). 2 snapped axes = edge, 3 = corner.
function buildPlanes(K) {
  const D = K.data, out = [];
  const add = (ax, v, x, y, z) => out.push({ ax, v, b: { x, y, z } });
  const BIG = [-60, 60];
  D.LV.forEach(L => add('y', L.floor, BIG, [L.floor, L.floor], BIG));
  // flat ceilings, per room rect (sloped rooms are skipped)
  for (const r of D.ROOMS) {
    const L = D.LV[r.lvl]; if (!L) continue;
    for (const q of r.rects) {
      const cx = (q[0] + q[1]) / 2, cz = (q[2] + q[3]) / 2, y = K.ceilAt(r.lvl, cx, cz, r.id);
      if (Math.abs(K.ceilAt(r.lvl, q[0] + 0.05, q[2] + 0.05, r.id) - y) < 0.01 && Math.abs(K.ceilAt(r.lvl, q[1] - 0.05, q[3] - 0.05, r.id) - y) < 0.01)
        add('y', y, [q[0], q[1]], [y, y], [q[2], q[3]]);
    }
  }
  for (const w of D.WALLS) {
    const [l, axis, a0, a1, c0, c1, ops, o = {}] = w; const L = D.LV[l]; if (!L) continue;
    const fl = L.floor, topF = typeof o.top === 'function' ? o.top : () => (o.top ?? L.top);
    let yt = -Infinity; for (let i = 0; i <= 24; i++) yt = Math.max(yt, topF(a0 + (a1 - a0) * i / 24));
    for (const b of o.brk || []) if (b >= a0 && b <= a1) yt = Math.max(yt, topF(b));
    const A = axis === 'x' ? 'x' : 'z', C = axis === 'x' ? 'z' : 'x';
    const box = (along, across, ys) => (A === 'x' ? { x: along, z: across, y: ys } : { z: along, x: across, y: ys });
    const put = (ax, v, bx) => add(ax, v, bx.x, bx.y, bx.z);
    put(C, c0, box([a0, a1], [c0, c0], [fl, yt])); put(C, c1, box([a0, a1], [c1, c1], [fl, yt])); // faces
    put(A, a0, box([a0, a0], [c0, c1], [fl, yt])); put(A, a1, box([a1, a1], [c0, c1], [fl, yt])); // end caps
    for (const op of ops || []) {
      const [oa, ob, , sill = 0, head = 2.1] = op, y0 = fl + sill, y1 = Math.min(fl + head, yt);
      if (y1 <= y0) continue;
      put(A, oa, box([oa, oa], [c0, c1], [y0, y1])); put(A, ob, box([ob, ob], [c0, c1], [y0, y1])); // jambs / reveals
      if (sill > 0.001) put('y', y0, box([oa, ob], [c0, c1], [y0, y0]));
      if (fl + head < yt - 0.001) put('y', fl + head, box([oa, ob], [c0, c1], [fl + head, fl + head]));
    }
  }
  // stairwell openings in the slabs
  for (const [k, list] of Object.entries(D.HOLES || {})) {
    const l = +k, L = D.LV[l]; if (!L || !Array.isArray(list)) continue;
    const ys = [L.ceil, L.top];
    for (const h of list) {
      add('x', h[0], [h[0], h[0]], ys, [h[2], h[3]]); add('x', h[1], [h[1], h[1]], ys, [h[2], h[3]]);
      add('z', h[2], [h[0], h[1]], ys, [h[2], h[2]]); add('z', h[3], [h[0], h[1]], ys, [h[3], h[3]]);
    }
  }
  return out;
}

function roomDims(K, r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, hmin = Infinity, hmax = -Infinity;
  const fl = K.data.LV[r.lvl]?.floor ?? 0, n = 12;
  for (const q of r.rects) {
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[3]);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const h = K.ceilAt(r.lvl, q[0] + (q[1] - q[0]) * i / n, q[2] + (q[3] - q[2]) * j / n, r.id) - fl;
      hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    }
  }
  return { w: x1 - x0, d: z1 - z0, hmin: Math.max(0, hmin), hmax, multi: r.rects.length > 1 };
}

export function install(H) {
  if (!H) return null;
  if (H.__hkMeasure) return H.__hkMeasure;
  const K = getKit(H), T = K.T, cam = H.camera, cvs = H.renderer.domElement;
  injectCSS('hk-measure-style', CSS);
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const planes = buildPlanes(K);

  /* ---------- DOM ---------- */
  const stage = cvs.parentElement || document.body;
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  const NS = 'http://www.w3.org/2000/svg';
  const ov = document.createElement('div'); ov.className = 'hk-mov'; ov.hidden = true; ov.setAttribute('aria-hidden', 'true');
  const svgEl = document.createElementNS(NS, 'svg');
  const gSeg = document.createElementNS(NS, 'g'), gSnap = document.createElementNS(NS, 'g');
  svgEl.append(gSeg, gSnap); ov.append(svgEl); stage.append(ov);
  const snapRing = document.createElementNS(NS, 'rect'), snapDot = document.createElementNS(NS, 'circle');
  snapRing.setAttribute('class', 'snap'); snapDot.setAttribute('class', 'snapc'); snapDot.setAttribute('r', '2.5');
  gSnap.append(snapRing, snapDot);

  const appEl = document.getElementById('app') || stage;
  const chip = document.createElement('div'); chip.className = 'hk-mchip'; chip.hidden = true;
  chip.setAttribute('role', 'region'); chip.setAttribute('aria-label', 'Meten');
  chip.innerHTML = `<div class="r1">${ICONS.ruler}<b class="rn"></b><span class="dims"></span></div>
    <div class="r2"><span class="tip"></span><span class="btns"><span class="cnt"></span>
    <button type="button" data-a="undo" title="Laatste punt of meting weghalen">${ICONS.undo}<span>Terug</span></button>
    <button type="button" data-a="clear" title="Alle metingen wissen">${ICONS.trash}<span>Wis</span></button></span></div>
    <div class="hk-sr" aria-live="polite"></div>`;
  appEl.append(chip);
  const $c = s => chip.querySelector(s);
  const sr = $c('.hk-sr');
  chip.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'undo') undo(); else if (a === 'clear') clearAll();
  });

  /* ---------- state ---------- */
  const ms = [];          // done: {a, b, lock}
  let cur = null;         // {a} first point placed
  let preview = null;     // snapped point under pointer / crosshair
  let active = false, shift = false, frame = 0, lastXY = null, hoverDirty = false;
  let list = [], listAge = -1e9;

  /* ---------- picking ---------- */
  const rc = new T.Raycaster(), ndc = new T.Vector2();
  const saved = new Map(); // door meshes whose raycast we suspended -> original fn
  const matVisible = o => { const m = o.material; if (!m) return true; const ms_ = Array.isArray(m) ? m : [m]; return ms_.some(x => x.visible !== false && !(x.transparent && x.opacity < 0.05)); };
  function refreshList() { list = K.pickables(); listAge = performance.now(); }
  function cast(cx, cy) {
    if (performance.now() - listAge > 1500) refreshList();
    const r = cvs.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    cam.updateMatrixWorld(); rc.setFromCamera(ndc, cam); rc.far = 400;
    const hits = [];
    for (const o of list) { if (!K.visible(o)) continue; (saved.get(o) || o.raycast).call(o, rc, hits); }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.find(h => matVisible(h.object)) || null;
  }
  function snapHit(hit) {
    if (!hit) return null;
    const p = hit.point.clone();
    const ph = cvs.clientHeight || innerHeight, pxW = 2 * Math.tan((cam.fov || 50) * Math.PI / 360) * hit.distance / ph;
    const R = Math.min(SNAP_MAX, Math.max(SNAP_MIN, SNAP_PX * pxW));
    const best = { x: null, y: null, z: null };
    for (const P of planes) {
      const d = Math.abs(p[P.ax] - P.v); if (d > R) continue;
      const b = P.b;
      if (P.ax !== 'x' && (p.x < b.x[0] - R || p.x > b.x[1] + R)) continue;
      if (P.ax !== 'y' && (p.y < b.y[0] - R || p.y > b.y[1] + R)) continue;
      if (P.ax !== 'z' && (p.z < b.z[0] - R || p.z > b.z[1] + R)) continue;
      if (!best[P.ax] || d < best[P.ax].d) best[P.ax] = { v: P.v, d };
    }
    let n = 0; for (const a of AX) if (best[a]) { p[a] = best[a].v; n++; }
    let kind = n >= 3 ? 'hoek' : n === 2 ? 'rand' : 'vrij';
    if (kind === 'vrij') { // furniture etc.: snap to a vertex of the hit triangle
      try {
        const o = hit.object, pos = o.geometry?.attributes?.position, f = hit.face;
        if (pos && f && !o.isSkinnedMesh) {
          let bd = R, bv = null; const v = new T.Vector3();
          for (const i of [f.a, f.b, f.c]) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const d = v.distanceTo(hit.point); if (d < bd) { bd = d; bv = v.clone(); } }
          if (bv) { p.copy(bv); kind = 'punt'; }
        }
      } catch (e) { /* geometry without plain positions */ }
    }
    return { p, kind };
  }
  const centerXY = () => { const r = cvs.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  /* ---------- doors: suspend clicks/E on doors while measuring ---------- */
  const doorish = o => { for (let p = o; p && p !== H.scene; p = p.parent) { const u = p.userData; if (u && (u.door || u.handle || u.klink || u.isDoor)) return true; } return false; };
  function suspendDoors(on) {
    if (on) {
      if (typeof H.setInteractive === 'function') { try { H.setInteractive(false); } catch (e) { } }
      H.scene.traverse(o => { if (o.isMesh && !saved.has(o) && doorish(o)) { saved.set(o, o.raycast); o.raycast = () => { }; } });
    } else {
      if (typeof H.setInteractive === 'function') { try { H.setInteractive(true); } catch (e) { } }
      for (const [o, f] of saved) o.raycast = f; saved.clear();
    }
  }

  /* ---------- measuring ---------- */
  let lockAx = null;
  function constrain(a, p) {
    lockAx = null; if (!shift) return p.clone();
    const d = p.clone().sub(a); let ax = 'x'; for (const k of AX) if (Math.abs(d[k]) > Math.abs(d[ax])) ax = k;
    const q = a.clone(); q[ax] = p[ax]; lockAx = ax; return q;
  }
  const AXNAME = { x: 'breedte (x)', y: 'hoogte', z: 'diepte (z)' };
  function place(sp) {
    if (!sp) { K.toast('Geen oppervlak geraakt'); return; }
    if (!cur) { cur = { a: sp.p.clone() }; say('Eerste punt gezet'); }
    else {
      const b = constrain(cur.a, sp.p), d = b.distanceTo(cur.a);
      if (d < 0.005) return;
      ms.push({ a: cur.a, b, lock: lockAx }); cur = null;
      say('Gemeten: ' + num(d) + ' m' + (ms[ms.length - 1].lock ? ', ' + AXNAME[ms[ms.length - 1].lock] : ''));
    }
    syncChip();
  }
  const placeAt = (x, y) => place(snapHit(cast(x, y)));
  const placeAtCenter = () => place(snapHit(cast(...centerXY())));
  function cancel() { if (cur) { cur = null; say('Meting geannuleerd'); syncChip(); } }
  function undo() { if (cur) cancel(); else if (ms.length) { ms.pop(); say('Laatste meting weggehaald'); syncChip(); } }
  function clearAll() { const n = ms.length + (cur ? 1 : 0); ms.length = 0; cur = null; if (n) say('Alle metingen gewist'); syncChip(); }
  function say(t) { sr.textContent = t; }

  /* ---------- input ---------- */
  const ptrs = new Set(); let gest = null;
  cvs.addEventListener('pointerdown', e => {
    if (!active) return;
    ptrs.add(e.pointerId); shift = e.shiftKey;
    if (ptrs.size === 1) gest = { x: e.clientX, y: e.clientY, t: performance.now(), multi: false, button: e.button, type: e.pointerType };
    else if (gest) gest.multi = true;
  });
  function pointerUp(e) {
    const had = ptrs.delete(e.pointerId);
    if (!active || !had || !gest || ptrs.size) return;
    const g = gest; gest = null;
    if (e.type === 'pointercancel' || g.multi) return;
    const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y), quick = performance.now() - g.t < 450;
    const locked = document.pointerLockElement === cvs;
    shift = e.shiftKey;
    if (K.mode() === 'walk') {
      if (locked) { if (g.button === 2) cancel(); else if (g.button === 0) placeAtCenter(); return; }
      if (g.button !== 0 || g.type === 'mouse') return;          // unlocked mouse click: the host grabs the mouse first
      if (moved > 8 || !quick) return;                          // touch drag = look around
      placeAtCenter();
    } else {
      if (g.button !== 0 || moved > 6 || !quick) return;       // orbit / pan drag
      placeAt(e.clientX, e.clientY);
    }
  }
  cvs.addEventListener('pointerup', pointerUp);
  cvs.addEventListener('pointercancel', pointerUp);
  addEventListener('pointerup', e => { if (ptrs.delete(e.pointerId) && !ptrs.size) gest = null; }); // released outside the canvas
  cvs.addEventListener('pointermove', e => {
    if (!active) return;
    if (e.pointerType === 'mouse') { lastXY = { x: e.clientX, y: e.clientY }; hoverDirty = true; }
    if (shift !== e.shiftKey) { shift = e.shiftKey; hoverDirty = true; }
  });
  cvs.addEventListener('pointerleave', () => { lastXY = null; hoverDirty = true; });
  const typing = () => { const a = document.activeElement; return !!a && (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && !/^(range|checkbox|radio|button)$/.test(a.type)) || !!a?.isContentEditable; };
  addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Shift') { shift = true; hoverDirty = true; }
    if (typing()) return;
    if (e.code === 'KeyE' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation(); e.preventDefault(); // keep the host from toggling a door
      if (e.repeat) return;
      if (K.mode() === 'walk') placeAtCenter(); else if (lastXY) placeAt(lastXY.x, lastXY.y);
    } else if (e.key === 'Escape') { if (cur) { cancel(); e.stopPropagation(); } }
    else if (e.key === 'Backspace' && (cur || ms.length)) { e.preventDefault(); undo(); }
  }, true);
  addEventListener('keyup', e => { if (e.key === 'Shift') { shift = false; hoverDirty = true; } }, true);
  addEventListener('blur', () => { shift = false; });

  /* ---------- drawing (SVG overlay, constant pixel width, always faces the camera) ---------- */
  const pool = [], lbls = [];
  const _a = new T.Vector3(), _b = new T.Vector3(), _m = new T.Vector3();
  function segEl(i) {
    if (pool[i]) return pool[i];
    const g = document.createElementNS(NS, 'g');
    const mk = (tag, cls) => { const e = document.createElementNS(NS, tag); e.setAttribute('class', cls); g.append(e); return e; };
    const s = { g, halo: mk('line', 'halo'), ln: mk('line', 'ln'), d0: mk('circle', 'dot'), d1: mk('circle', 'dot'), cls: '' };
    s.d0.setAttribute('r', '4.5'); s.d1.setAttribute('r', '4.5');
    gSeg.append(g); pool[i] = s; return s;
  }
  function lblEl(i) {
    if (lbls[i]) return lbls[i];
    const d = document.createElement('div'); d.className = 'hk-mlbl'; ov.append(d); lbls[i] = { d, txt: '', cls: '' }; return lbls[i];
  }
  // camera-space clip against the near plane, then project; returns screen coords or null
  function toCam(v, out) { return out.copy(v).applyMatrix4(cam.matrixWorldInverse); }
  function scr(vc, W, Hh) { const p = vc.clone().applyMatrix4(cam.projectionMatrix); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh]; }
  function projSeg(a, b, W, Hh) {
    const n = -(cam.near + 1e-3);
    toCam(a, _a); toCam(b, _b);
    const ina = _a.z < n, inb = _b.z < n;
    if (!ina && !inb) return null;
    if (!ina) _a.lerp(_b, (n - _a.z) / (_b.z - _a.z)); else if (!inb) _b.lerp(_a, (n - _b.z) / (_a.z - _b.z));
    return { p0: scr(_a, W, Hh), p1: scr(_b, W, Hh), ina, inb };
  }
  function projPt(v, W, Hh) { toCam(v, _m); return _m.z < -cam.near ? scr(_m, W, Hh) : null; }
  function drawItem(i, a, b, cls, text, W, Hh) {
    const s = segEl(i), L = lblEl(i);
    const pr = projSeg(a, b, W, Hh);
    if (!pr) { s.g.style.display = 'none'; L.d.style.display = 'none'; return; }
    s.g.style.display = '';
    if (s.cls !== cls) { s.g.setAttribute('class', cls); s.cls = cls; }
    for (const ln of [s.halo, s.ln]) { ln.setAttribute('x1', pr.p0[0].toFixed(1)); ln.setAttribute('y1', pr.p0[1].toFixed(1)); ln.setAttribute('x2', pr.p1[0].toFixed(1)); ln.setAttribute('y2', pr.p1[1].toFixed(1)); }
    s.d0.style.display = pr.ina ? '' : 'none'; s.d1.style.display = pr.inb ? '' : 'none';
    s.d0.setAttribute('cx', pr.p0[0].toFixed(1)); s.d0.setAttribute('cy', pr.p0[1].toFixed(1));
    s.d1.setAttribute('cx', pr.p1[0].toFixed(1)); s.d1.setAttribute('cy', pr.p1[1].toFixed(1));
    const mid = projPt(_m.copy(a).add(b).multiplyScalar(0.5), W, Hh) || [(pr.p0[0] + pr.p1[0]) / 2, (pr.p0[1] + pr.p1[1]) / 2];
    if (!text) { L.d.style.display = 'none'; return; }
    L.d.style.display = '';
    const lc = 'hk-mlbl' + (cls.includes('live') ? ' live' : '');
    if (L.cls !== lc) { L.d.className = lc; L.cls = lc; }
    if (L.txt !== text) { L.d.textContent = text; L.txt = text; }
    L.d.style.transform = `translate(${mid[0].toFixed(1)}px,${mid[1].toFixed(1)}px) translate(-50%,-50%)`;
  }
  function draw() {
    const W = ov.clientWidth, Hh = ov.clientHeight; if (!W || !Hh) return;
    cam.updateMatrixWorld();
    let i = 0;
    for (const m of ms) drawItem(i++, m.a, m.b, m.lock ? 'lock' : '', num(m.a.distanceTo(m.b)) + ' m', W, Hh);
    if (cur) {
      const b = preview ? constrain(cur.a, preview.p) : cur.a;
      const d = b.distanceTo(cur.a);
      drawItem(i++, cur.a, b, 'live' + (lockAx ? ' lock' : ''), preview ? num(d) + ' m' : '', W, Hh);
    }
    for (let j = i; j < pool.length; j++) { pool[j].g.style.display = 'none'; lbls[j].d.style.display = 'none'; }
    // snap marker: square = corner, ring = edge, dot = free / vertex
    const sp = preview && projPt(cur ? constrain(cur.a, preview.p) : preview.p, W, Hh);
    if (sp) {
      const k = preview.kind, s = k === 'hoek' ? 12 : k === 'rand' ? 10 : 0;
      snapRing.style.display = s ? '' : 'none'; snapDot.style.display = '';
      if (s) { snapRing.setAttribute('x', (sp[0] - s / 2).toFixed(1)); snapRing.setAttribute('y', (sp[1] - s / 2).toFixed(1)); snapRing.setAttribute('width', s); snapRing.setAttribute('height', s); snapRing.setAttribute('rx', k === 'rand' ? s / 2 : 1.5); }
      snapDot.setAttribute('cx', sp[0].toFixed(1)); snapDot.setAttribute('cy', sp[1].toFixed(1));
    } else { snapRing.style.display = 'none'; snapDot.style.display = 'none'; }
  }

  /* ---------- room chip ---------- */
  const dimsCache = new Map();
  let chipRoom = undefined, chipMode = '', chipTopT = 0;
  function syncChip(force) {
    if (!active) return;
    const rid = K.currentRoomId(), md = K.mode();
    if (force || rid !== chipRoom || md !== chipMode) {
      chipRoom = rid; chipMode = md;
      const r = rid && K.ROOM[rid];
      if (r) {
        if (!dimsCache.has(rid)) dimsCache.set(rid, roomDims(K, r));
        const d = dimsCache.get(rid);
        const flat = d.hmax - d.hmin < 0.02;
        const ceil = flat ? `plafond ${num(d.hmax)} m` : d.hmin < 0.1 ? `schuin plafond, max ${num(d.hmax)} m` : `schuin plafond ${num(d.hmin)}–${num(d.hmax)} m`;
        $c('.rn').textContent = r.name;
        $c('.dims').textContent = `${d.multi ? 'max. ' : ''}${num(d.w)} × ${num(d.d)} m · ${ceil}`;
        $c('.dims').title = d.multi ? 'Samengestelde ruimte: buitenste binnenmaten (breedte × diepte)' : 'Binnenmaten (breedte × diepte)';
      } else { $c('.rn').textContent = md === 'walk' ? 'Buiten / gang' : 'Geen kamer gekozen'; $c('.dims').textContent = ''; }
      const kb = !COARSE;
      $c('.tip').innerHTML = md === 'walk'
        ? (kb ? 'Richt het vizier, <kbd>E</kbd> of klik: punt · <kbd>Shift</kbd>: as vast · <kbd>Esc</kbd>: annuleren' : 'Richt het vizier en tik: punt')
        : (kb ? 'Klik twee punten · <kbd>Shift</kbd>: as vast · <kbd>Esc</kbd>: annuleren' : 'Tik twee punten · slepen draait');
    }
    const n = ms.length;
    $c('.cnt').textContent = n ? `${n} meting${n === 1 ? '' : 'en'}` : '';
    $c('[data-a="undo"]').disabled = !n && !cur;
    $c('[data-a="clear"]').disabled = !n && !cur;
  }
  function placeChip() {
    const tb = document.getElementById('topbar'), host = chip.offsetParent || appEl;
    const hr = host.getBoundingClientRect();
    let top = 16;
    if (tb && tb.offsetParent) top = tb.getBoundingClientRect().bottom - hr.top + 10;
    const v = Math.round(top) + 'px'; if (chip.style.top !== v) chip.style.top = v;
  }

  /* ---------- loop ---------- */
  K.onTick(() => {
    if (!active) return;
    frame++;
    if (K.mode() === 'walk') { if (frame % 2 === 0) preview = snapHit(cast(...centerXY())); }
    else if (hoverDirty) { hoverDirty = false; preview = lastXY ? snapHit(cast(lastXY.x, lastXY.y)) : null; }
    draw();
    const t = performance.now();
    if (t - chipTopT > 300) { chipTopT = t; placeChip(); syncChip(); }
    if (frame % 90 === 0) suspendDoors(true); // doors rebuilt by the host get suspended too
  });
  const offRoom = K.on('room', () => syncChip(true));

  /* ---------- tool button ---------- */
  function setActive(on) {
    on = !!on; if (on === active) return;
    active = on;
    btn?.setAttribute?.('aria-pressed', String(on)); btn?.classList?.toggle?.('active', on);
    ov.hidden = !on; chip.hidden = !on;
    suspendDoors(on);
    if (on) { refreshList(); placeChip(); syncChip(true); hoverDirty = true; }
    else { cur = null; preview = null; gest = null; ptrs.clear(); }
  }
  const btn = K.addTool({ id: 'meten', label: 'Meten', icon: ICONS.ruler, title: 'Meten: afstand tussen twee punten', onClick: () => setActive(!active) });

  const api = {
    setActive, toggle: () => setActive(!active), get active() { return active; },
    clear: clearAll, undo, cancel,
    get measurements() { return ms.map(m => ({ a: m.a.toArray(), b: m.b.toArray(), d: m.a.distanceTo(m.b), lock: m.lock })); },
    // test hooks: snap a world point / place a point programmatically
    snapPoint: (x, y, z) => { const p = new T.Vector3(x, y, z); return snapHit({ point: p, distance: cam.position.distanceTo(p), object: null, face: null }); },
    placeAtScreen: (x, y) => placeAt(x, y), placeAtCenter,
    get preview() { return preview && { p: preview.p.toArray(), kind: preview.kind }; },
    get pending() { return cur ? cur.a.toArray() : null; },
    pickAtScreen: (x, y) => { const h = cast(x, y), s = snapHit(h); return s && { p: s.p.toArray(), kind: s.kind, raw: h.point.toArray(), door: doorish(h.object) }; },
    get missing() { return [...K.missing]; },
    dispose() { setActive(false); offRoom?.(); ov.remove(); chip.remove(); btn?.remove?.(); delete H.__hkMeasure; },
  };
  H.__hkMeasure = api; H.measure = H.measure || api;
  return api;
}

whenHouse(install);
