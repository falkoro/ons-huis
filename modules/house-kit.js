// house-kit.js: shared helpers for the Ons Huis add-on modules (measure.js, shopping.js).
// Everything is defensive: every HOUSE field is optional and each one has a fallback.
// No network access and no bare imports; THREE comes from HOUSE.THREE.

/* ---------------- boot ---------------- */
const ready = h => !!(h && h.THREE && h.scene && h.camera && h.renderer);
export function whenHouse(fn, timeoutMs = 60000) {
  const t0 = performance.now();
  const go = () => {
    const H = window.HOUSE;
    if (ready(H)) { try { fn(H); } catch (e) { console.error('[house-kit] install failed', e); } return; }
    if (performance.now() - t0 < timeoutMs) setTimeout(go, 120);
  };
  go();
}

/* ---------------- formatting (nl-NL) ---------------- */
const NF = {};
export const num = (v, d = 2) => (NF[d] ||= new Intl.NumberFormat('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })).format(Number.isFinite(v) ? v : 0);
export const metres = v => num(v, 2) + ' m';
export const eur = v => (NF.eur ||= new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' })).format(Number.isFinite(v) ? v : 0);
// "2,10" / "2.10" / "€ 1.234,50" -> number (NaN when empty)
export function parseNum(s) {
  let t = String(s ?? '').replace(/[€\s%]/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const v = Number(t); return Number.isFinite(v) ? v : NaN;
}
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- icons (stroke = currentColor) ---------------- */
const svg = p => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICONS = {
  ruler: svg('<path d="M3 16.5 16.5 3 21 7.5 7.5 21z"/><path d="m7 13 1.8 1.8M9.8 10.2l1.2 1.2M12.6 7.4l1.8 1.8M15.4 4.6l1.2 1.2"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

/* ---------------- shared styles ---------------- */
// Uses the host tokens (--glass, --line, --ink, --accent, ...) with neutral fallbacks so it also works standalone.
const CSS = `
.hk-tools{display:inline-flex;gap:2px;background:var(--glass,rgba(247,248,245,.9));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  border:1px solid var(--line,#d0d7cf);border-radius:999px;padding:3px;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.15));width:max-content;max-width:100%;pointer-events:auto}
.hk-tools button{border:0;background:transparent;border-radius:999px;padding:6px 12px;font:500 14px/1.2 var(--font-body,system-ui);color:var(--ink-2,#56625b);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hk-tools button:hover{color:var(--ink,#1b231f)}
.hk-tools button[aria-pressed="true"]{background:var(--accent,#2d5a4c);color:var(--accent-ink,#fff)}
.hk-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:30;max-width:calc(100vw - 32px);box-sizing:border-box;
  background:var(--ink,#1b231f);color:var(--bg,#fff);font:500 13px/1.35 var(--font-body,system-ui);padding:9px 14px;border-radius:999px;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.2));pointer-events:none;text-align:center}
@media (max-width:420px){.hk-tools button{padding:6px 10px;font-size:13px}}
`;
export function injectCSS(id, css) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.append(s);
}

/* ---------------- fallback roof model (only used when HOUSE gives no ceiling function) ----------------
   Copied from index.html (MR_*, WR_*, COLLAR, dormer). It is applied only when LV matches that house. */
const ROOF = {
  main: { z: 8.23, y: 9.3, k: 0.9, th: 0.3 },
  wing: { z: 3.92, y: 6.2, k: 0.82, th: 0.28, rooms: ['zolderL'] },
  dormer: { x0: 3.9, x1: 6.07, z0: 4.4, z1: 6.62, y: 7.65 },
  collar: 8.02,
};
const near = (a, b, e = 0.02) => Math.abs(a - b) < e;

/* ---------------- kit ---------------- */
const KITS = new WeakMap();
export function getKit(H) {
  let K = KITS.get(H); if (K) return K;
  injectCSS('hk-style', CSS);
  const T = H.THREE;
  const missing = new Set();
  const note = f => { if (!missing.has(f)) { missing.add(f); } };

  /* ---- data ---- */
  function readData() {
    const d = H.data || (note('data'), {});
    let LV = d.LV;
    if (!Array.isArray(LV)) { note('data.LV'); LV = (H.floors || []).map((f, i) => ({ id: f.id ?? i, name: f.name, floor: f.floor ?? f.y, ceil: f.ceil, top: f.top ?? f.ceil })); }
    LV = LV.map((l, i) => ({ id: l.id ?? i, name: l.name ?? `Laag ${i}`, floor: +l.floor || 0, ceil: +(l.ceil ?? (l.floor + 2.5)), top: +(l.top ?? l.ceil ?? (l.floor + 2.75)) }));
    let ROOMS = d.ROOMS;
    if (!Array.isArray(ROOMS)) { note('data.ROOMS'); ROOMS = H.rooms || []; }
    ROOMS = ROOMS.map(r => ({
      id: r.id, name: r.name || r.id, lvl: r.lvl ?? r.level ?? 0,
      rects: (r.rects || []).map(q => Array.isArray(q) ? q.slice(0, 4).map(Number) : [q.x0, q.x1, q.z0, q.z1].map(Number)),
      wet: r.wet ?? /badkamer|^wc|toilet/i.test(r.id + ' ' + r.name),
    }));
    const WALLS = Array.isArray(d.WALLS) ? d.WALLS : (note('data.WALLS'), []);
    const HOLES = d.HOLES || (note('data.HOLES'), {});
    const FLOORS = d.FLOORS || (note('data.FLOORS'), {});
    const PAINTS = Array.isArray(d.PAINTS) ? d.PAINTS : (note('data.PAINTS'), []);
    return { LV, ROOMS, WALLS, HOLES, FLOORS, PAINTS, STYLES: d.STYLES || {}, SKYLIGHT: d.SKYLIGHT || null, raw: d };
  }
  const data = readData();
  const ROOM = Object.fromEntries(data.ROOMS.map(r => [r.id, r]));
  const topL = data.LV.length - 1;
  const roofOK = data.LV.length === 3 && near(data.LV[2].floor, 5.39) && near(data.LV[2].ceil, 8.02) && near(data.LV[1].floor, 2.76);

  function roomAt(l, x, z) {
    for (const r of data.ROOMS) if (r.lvl === l) for (const q of r.rects) if (x >= q[0] && x <= q[1] && z >= q[2] && z <= q[3]) return r;
    return null;
  }
  const hostCeil = typeof H.ceilAt === 'function' ? H.ceilAt : typeof data.raw.ceilAt === 'function' ? data.raw.ceilAt : null;
  if (!hostCeil) note('ceilAt');
  // absolute Y of the finished ceiling above (x,z) on level l (inside room rid)
  function ceilAt(l, x, z, rid) {
    if (hostCeil) { const v = +hostCeil(l, x, z, rid); if (Number.isFinite(v)) return v; }
    const L = data.LV[l]; if (!L) return 2.5;
    if (!roofOK) return L.ceil;
    const rr = rid ?? roomAt(l, x, z)?.id;
    if (ROOF.wing.rooms.includes(rr)) { const w = ROOF.wing; return w.y - Math.abs(z - w.z) * w.k - w.th; }
    if (l === topL) {
      const D = ROOF.dormer;
      if (x >= D.x0 && x <= D.x1 && z >= D.z0 && z <= D.z1) return Math.min(ROOF.collar, D.y);
      const m = ROOF.main; return Math.min(L.ceil, m.y - Math.abs(z - m.z) * m.k - m.th);
    }
    return L.ceil;
  }
  const levelOfY = y => { let l = 0; for (let i = 0; i < data.LV.length; i++) if (y >= data.LV[i].floor - 0.08) l = i; return l; };

  /* ---- live host state ---- */
  function state() {
    if (H.state) return H.state;
    note('state');
    try { return JSON.parse(localStorage.getItem('onshuis.interieur.v1') || 'null') || {}; } catch (e) { return {}; }
  }
  const roomState = id => { const s = state(); return s?.rooms?.[id] || s?.[id] || {}; };
  const mode = () => /walk|rond|loop/i.test(String(H.mode ?? '')) ? 'walk' : 'doll';
  function walker() {
    const w = H.walker;
    if (w && Number.isFinite(+w.x)) return { x: +w.x, z: +w.z, l: +(w.l ?? w.lvl ?? w.level ?? levelOfY(H.camera.position.y - 1.2)) };
    note('walker');
    const p = H.camera.position; return { x: p.x, z: p.z, l: levelOfY(p.y - 1.2) };
  }
  function currentRoomId() {
    if (mode() === 'walk') { const w = walker(); return roomAt(w.l, w.x, w.z)?.id || null; }
    const s = state(); return (s && ROOM[s.sel]) ? s.sel : null;
  }

  /* ---- events ---- */
  const tickFns = new Set(); let ownLoop = false;
  function onTick(fn) {
    if (typeof H.onTick === 'function') return H.onTick(fn);
    note('onTick');
    tickFns.add(fn);
    if (!ownLoop) { ownLoop = true; let last = performance.now(); const f = t => { const dt = Math.min(0.05, (t - last) / 1000); last = t; for (const g of tickFns) { try { g(dt); } catch (e) { console.error(e); } } requestAnimationFrame(f); }; requestAnimationFrame(f); }
    return () => tickFns.delete(fn);
  }
  // HOUSE.on(evt, fn) -> unsubscribe; fallback: poll a cheap signature
  function on(evt, fn) {
    if (typeof H.on === 'function') { const u = H.on(evt, fn); return typeof u === 'function' ? u : () => H.off?.(evt, fn); }
    note('on');
    const sig = evt === 'room' ? () => currentRoomId() : () => { try { return JSON.stringify(state()?.rooms || state()); } catch (e) { return ''; } };
    let prev = sig(); const id = setInterval(() => { const s = sig(); if (s !== prev) { prev = s; try { fn(); } catch (e) { console.error(e); } } }, evt === 'room' ? 300 : 800);
    return () => clearInterval(id);
  }

  /* ---- ui ---- */
  function addTool(opts) {
    const ui = H.ui;
    if (ui && typeof ui.addTool === 'function') {
      try { const b = ui.addTool(opts); if (b) return b; } catch (e) { console.error('[house-kit] ui.addTool failed', e); }
    }
    note('ui.addTool');
    let rail = document.getElementById('hk-tools');
    if (!rail) {
      rail = document.createElement('div'); rail.id = 'hk-tools'; rail.className = 'hk-tools'; rail.setAttribute('role', 'toolbar'); rail.setAttribute('aria-label', 'Gereedschap');
      const top = document.getElementById('topbar');
      if (top) top.append(rail); else { rail.style.cssText = 'position:fixed;left:16px;top:16px;z-index:8'; document.body.append(rail); }
    }
    const b = document.createElement('button'); b.type = 'button'; b.dataset.tool = opts.id; b.setAttribute('aria-pressed', 'false');
    b.innerHTML = (opts.icon && /^\s*</.test(opts.icon) ? opts.icon : '') + `<span>${esc(opts.label)}</span>`;
    b.addEventListener('click', e => opts.onClick?.(e));
    rail.append(b); return b;
  }
  let toastEl = null, toastT = 0;
  function toast(text) {
    if (H.ui && typeof H.ui.toast === 'function') { try { H.ui.toast(text); return; } catch (e) { } }
    note('ui.toast');
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'hk-toast'; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); document.body.append(toastEl); }
    toastEl.textContent = text; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  /* ---- picking ---- */
  const visible = o => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  function pickables() {
    let list = null;
    if (typeof H.pickables === 'function') { try { list = H.pickables(); } catch (e) { list = null; } }
    const whole = !Array.isArray(list); if (whole) { note('pickables'); list = [H.scene]; }
    const out = [];
    const huge = c => { // whole-scene fallback: leave out sky domes and other backdrops
      try { const g = c.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); const s = c.getWorldScale(new T.Vector3()); return g.boundingSphere.radius * Math.max(s.x, s.y, s.z) > 150; } catch (e) { return false; }
    };
    for (const o of list) o?.traverse?.(c => { if (c.isMesh && !c.isInstancedMesh && !c.userData?.hkIgnore && !(whole && (c.isSkinnedMesh || huge(c)))) out.push(c); });
    return out;
  }

  K = { H, T, data, ROOM, roomAt, ceilAt, roofFallback: !hostCeil && roofOK, levelOfY, state, roomState, mode, walker, currentRoomId, onTick, on, addTool, toast, pickables, visible, missing };
  KITS.set(H, K);
  return K;
}
