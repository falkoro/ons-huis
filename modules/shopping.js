// shopping.js: "Boodschappenlijst" tool for the Ons Huis walkthrough.
// Self-boots on import (waits for window.HOUSE); also exports install(HOUSE) and computeGeometry(kit).
// Quantities come from the model data (rooms, walls with openings, stair holes, roof slopes) plus the live
// per-room finishes in HOUSE.state, and re-render on HOUSE 'change'.
//
// Geometry rules
//  - Floor m2: union of the room's rects (overlaps counted once) minus the stairwell hole in this floor (HOLES[l],
//    exactly what the app cuts out of the floor mesh) and minus wall/chimney footprints standing inside the room.
//  - Wall m2: every WALLS face is walked in 1 cm steps; the room on that side is found the same way the app assigns
//    the wall colour (roomAt 12 cm off the face). Height = from max(floor, wall bottom) to min(wall top, ceiling at
//    that spot), so sloped attic walls, knee walls and dormer cheeks are exact. Window/door openings are subtracted.
//  - Ceiling m2: room footprint minus the stair hole above, times the roof-slope factor sqrt(1+gradient^2).
//  - Plinten: wall runs that reach the floor, minus door/passage openings and stretches next to a stair hole.
//  - Wet rooms with wall tiling: tiles from the floor to the tile height (minus openings), paint above it, no plinten.
import { whenHouse, getKit, ICONS, num, eur, parseNum, esc, injectCSS } from './house-kit.js';

const SKEY = 'onshuis.boodschappen.v1';
const STEP = 0.01;

/* ================= geometry ================= */
const inRect = (q, x, z) => x >= q[0] && x <= q[1] && z >= q[2] && z <= q[3];
function cells(rects, holes, fn) {
  const xs = new Set(), zs = new Set();
  for (const q of rects) { xs.add(q[0]); xs.add(q[1]); zs.add(q[2]); zs.add(q[3]); }
  for (const h of holes) { xs.add(h[0]); xs.add(h[1]); zs.add(h[2]); zs.add(h[3]); }
  const X = [...xs].sort((a, b) => a - b), Z = [...zs].sort((a, b) => a - b);
  for (let i = 0; i < X.length - 1; i++) for (let j = 0; j < Z.length - 1; j++) {
    const cx = (X[i] + X[i + 1]) / 2, cz = (Z[j] + Z[j + 1]) / 2;
    if (rects.some(q => inRect(q, cx, cz)) && !holes.some(h => inRect(h, cx, cz))) fn(X[i], X[i + 1], Z[j], Z[j + 1]);
  }
}
const unionArea = (rects, holes) => { let a = 0; cells(rects, holes, (x0, x1, z0, z1) => { a += (x1 - x0) * (z1 - z0); }); return a; };

// footprints of walls standing on the floor of level l (rect format [x0,x1,z0,z1])
function wallFootprints(K, l) {
  const L = K.data.LV[l], out = []; if (!L) return out;
  for (const w of K.data.WALLS) {
    const [wl, axis, a0, a1, c0, c1, , o = {}] = w; if (wl !== l) continue;
    const bot = typeof o.bot === 'function' ? o.bot((a0 + a1) / 2) : typeof o.bot === 'number' ? o.bot : L.floor;
    if (bot > L.floor + 0.05) continue; // dormer cheeks etc. stand on the roof, not on the floor
    out.push(axis === 'x' ? [a0, a1, c0, c1] : [c0, c1, a0, a1]);
  }
  return out;
}
const touches = (q, rs) => rs.some(r => q[0] < r[1] && q[1] > r[0] && q[2] < r[3] && q[3] > r[2]);

export function computeGeometry(K) {
  const { LV, ROOMS, WALLS, HOLES } = K.data;
  const G = {};
  // stair holes cut from a floor = HOLES[l], the same cut the app applies to the floor mesh of level l
  const floorHoles = l => HOLES[l] || [];
  for (const r of ROOMS) {
    const fl = LV[r.lvl]?.floor ?? 0;
    const sum = r.rects.reduce((a, q) => a + (q[1] - q[0]) * (q[3] - q[2]), 0); // what the app shows
    const walls = wallFootprints(K, r.lvl).filter(q => touches(q, r.rects));
    const gross = unionArea(r.rects, []), noStair = unionArea(r.rects, floorHoles(r.lvl)), net = unionArea(r.rects, [...floorHoles(r.lvl), ...walls]);
    // ceiling: footprint minus the stair hole above, with slope factor
    let ceil = 0, ceilFlat = 0;
    cells(r.rects, HOLES[r.lvl] || [], (x0, x1, z0, z1) => {
      const h = (x, z) => K.ceilAt(r.lvl, x, z, r.id) - fl;
      const pts = [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [(x0 + x1) / 2, (z0 + z1) / 2]].map(([x, z]) => h(Math.min(Math.max(x, x0 + 1e-4), x1 - 1e-4), Math.min(Math.max(z, z0 + 1e-4), z1 - 1e-4)));
      if (Math.max(...pts) - Math.min(...pts) < 1e-4 && pts[0] > 0.01) { const a = (x1 - x0) * (z1 - z0); ceil += a; ceilFlat += a; return; }
      const nx = Math.max(1, Math.ceil((x1 - x0) / 0.05)), nz = Math.max(1, Math.ceil((z1 - z0) / 0.05)), dx = (x1 - x0) / nx, dz = (z1 - z0) / nz, e = 0.005;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = x0 + (i + 0.5) * dx, z = z0 + (j + 0.5) * dz, hc = h(x, z);
        if (hc <= 0.01) continue;
        const gx = (h(x + e, z) - h(x - e, z)) / (2 * e), gz = (h(x, z + e) - h(x, z - e)) / (2 * e);
        let f = Math.sqrt(1 + gx * gx + gz * gz); if (!(f < 4)) f = 1; // steps (dormer edge) are not slopes
        ceil += dx * dz * f;
      }
    });
    G[r.id] = { r, sum, gross, net, cut: Math.max(0, gross - noStair), wallCut: Math.max(0, noStair - net), ceil, ceilSloped: ceil - ceilFlat > 0.05, strips: [] };
  }
  // walls
  for (const w of WALLS) {
    const [l, axis, a0, a1, c0, c1, ops, o = {}] = w; const L = LV[l]; if (!L) continue;
    const fl = L.floor;
    const topF = typeof o.top === 'function' ? o.top : () => (o.top ?? L.top);
    const botF = typeof o.bot === 'function' ? o.bot : () => (typeof o.bot === 'number' ? o.bot : fl);
    const opsN = (ops || []).map(op => ({ a: op[0], b: op[1], type: op[2], sill: op[3] ?? 0, head: op[4] ?? 2.1 }));
    const holes = floorHoles(l);
    const n = Math.max(1, Math.round((a1 - a0) / STEP)), ds = (a1 - a0) / n;
    for (const side of [0, 1]) {
      const c = side ? c1 + 0.12 : c0 - 0.12, cf = side ? c1 + 0.04 : c0 - 0.04;
      let run = null;
      for (let i = 0; i < n; i++) {
        const s = a0 + (i + 0.5) * ds, x = axis === 'x' ? s : c, z = axis === 'x' ? c : s;
        const r = K.roomAt(l, x, z);
        if (!r || !G[r.id]) { run = null; continue; }
        const lo = Math.max(botF(s), fl) - fl, hi = Math.min(topF(s), K.ceilAt(l, x, z, r.id)) - fl;
        if (!(hi > lo + 0.005)) { run = null; continue; }
        const gaps = []; let door = false, ok = '', open = false;
        for (const op of opsN) if (s > op.a && s < op.b) { if (op.type === 'o' && op.sill < 0.05) open = true; gaps.push([op.sill, op.head]); ok += op.a + ','; if (op.sill < 0.05) door = true; }
        if (open) { run = null; continue; } // open passage: no wall here at all
        const fx = axis === 'x' ? s : cf, fz = axis === 'x' ? cf : s;
        const stair = holes.some(h => inRect(h, fx, fz));
        const skirt = lo < 0.02 && !door && !stair;
        const key = `${r.id}|${lo.toFixed(3)}|${hi.toFixed(3)}|${ok}|${skirt}|${door}`;
        if (run && run.key === key) run.ds += ds;
        else { run = { key, ds, lo, hi, gaps, skirt, door: door && lo < 0.02 }; G[r.id].strips.push(run); }
      }
    }
  }
  return G;
}
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
// wall area of a room between heights y0..y1 above its floor, openings excluded
function wallArea(g, y0 = 0, y1 = 99) {
  let a = 0;
  for (const s of g.strips) {
    let h = ov(s.lo, s.hi, y0, y1);
    for (const [g0, g1] of s.gaps) h -= ov(Math.max(g0, s.lo), Math.min(g1, s.hi), y0, y1);
    a += s.ds * Math.max(0, h);
  }
  return a;
}
const openingArea = g => { let a = 0; for (const s of g.strips) for (const [g0, g1] of s.gaps) a += s.ds * ov(g0, g1, s.lo, s.hi); return a; };
const skirtLen = g => g.strips.reduce((a, s) => a + (s.skirt ? s.ds : 0), 0);
const doorLen = g => g.strips.reduce((a, s) => a + (s.door ? s.ds : 0), 0);

/* ================= settings (per viewer) ================= */
function loadSettings() {
  const d = { v: 1, price: {}, waste: {}, coats: 2, cover: 8, tileH: 2.1, tileWalls: {} };
  try {
    const s = JSON.parse(localStorage.getItem(SKEY) || 'null');
    if (s && s.v === 1) {
      for (const k of ['price', 'waste', 'tileWalls']) if (s[k] && typeof s[k] === 'object') d[k] = s[k];
      for (const k of ['coats', 'cover', 'tileH']) if (Number.isFinite(+s[k]) && +s[k] > 0) d[k] = +s[k];
    }
  } catch (e) { /* storage unavailable */ }
  return d;
}
let saveT = 0;
function saveSettings(S) { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) { } }, 200); }

/* ================= model -> lines ================= */
const lvShort = l => (l === 0 ? 'BG' : `${l}e`);
function buildList(K, G, S) {
  const D = K.data, st = K.state() || {};
  const fName = id => D.FLOORS?.[id]?.name || (id ? String(id) : 'Onbekend');
  const paintName = hex => D.PAINTS.find(p => String(p[1]).toLowerCase() === hex)?.[0] || `Eigen kleur ${hex.toUpperCase()}`;
  const defWaste = key => /visgraat/.test(key) ? 15 : 10;
  const waste = key => { const v = +S.waste[key]; return Number.isFinite(v) && v >= 0 ? v : defWaste(key); };
  const price = key => { const v = +S.price[key]; return Number.isFinite(v) && v > 0 ? v : null; };
  const tileDefault = r => /badkamer|^wc|toilet|douche/i.test(r.id + ' ' + r.name);
  const tiled = r => r.wet && (S.tileWalls[r.id] ?? tileDefault(r));
  const rs = id => st.rooms?.[id] || {};
  const order = D.ROOMS.map(r => r.id);
  const group = (map, key, make) => map.get(key) || map.set(key, make()).get(key);

  const floors = new Map(), wetFloors = new Map(), paints = new Map();
  const plint = { key: 'plint', label: 'Plinten', unit: 'm', rooms: [], qty: 0 };
  const ceiling = { key: 'plafond', label: 'Plafond (incl. dakschuinen)', unit: 'm²', rooms: [], qty: 0 };
  const wallTiles = { key: 'wandtegel', label: 'Wandtegels', unit: 'm²', rooms: [], qty: 0, waste: true };
  for (const id of order) {
    const g = G[id]; if (!g) continue; const r = g.r, s = rs(id), tag = `${r.name} · ${lvShort(r.lvl)}`;
    const ftype = s.floor || '?';
    const fl = group(r.wet ? wetFloors : floors, ftype, () => ({ key: (r.wet ? 'tegelvloer:' : 'vloer:') + ftype, label: fName(ftype), unit: 'm²', rooms: [], qty: 0, waste: true }));
    const fnote = [g.cut > 0.005 ? `excl. trapgat ${num(g.cut, 2)} m²` : '', g.wallCut > 0.02 ? `excl. muurvoet ${num(g.wallCut, 2)} m²` : ''].filter(Boolean).join(', ');
    fl.rooms.push({ id, tag, qty: g.net, note: fnote }); fl.qty += g.net;
    const tl = tiled(r), th = Math.max(0, S.tileH);
    if (!tl) { const L = skirtLen(g); if (L > 0.01) { plint.rooms.push({ id, tag, qty: L, note: doorLen(g) > 0.01 ? `−${num(doorLen(g), 2)} m deur` : '' }); plint.qty += L; } }
    else { const a = wallArea(g, 0, th); wallTiles.rooms.push({ id, tag, qty: a, note: `tot ${num(th, 2)} m` }); wallTiles.qty += a; }
    const hex = String(s.wall || '#ffffff').toLowerCase();
    const wa = wallArea(g, tl ? th : 0, 99);
    if (wa > 0.01) { const p = group(paints, hex, () => ({ key: 'verf:' + hex, label: paintName(hex), hex, unit: 'm²', rooms: [], qty: 0, paint: true })); p.rooms.push({ id, tag, qty: wa, note: tl ? `boven tegels` : '' }); p.qty += wa; }
    if (g.ceil > 0.01) { ceiling.rooms.push({ id, tag, qty: g.ceil, note: g.ceilSloped ? 'schuin deels' : '' }); ceiling.qty += g.ceil; }
  }
  ceiling.paint = true;
  const fin = L => {
    L.wastePct = L.waste ? waste(L.key) : 0;
    L.buy = L.qty * (1 + L.wastePct / 100);
    if (L.paint) { L.liters = L.qty * S.coats / S.cover; L.buyUnit = 'l'; L.buyQty = L.liters; } else { L.buyUnit = L.unit; L.buyQty = L.buy; }
    L.price = price(L.key); L.cost = L.price != null ? L.buyQty * L.price : null;
    return L;
  };
  const sortQ = m => [...m.values()].sort((a, b) => b.qty - a.qty).map(fin);
  const sections = [
    { id: 'vloer', title: 'Vloeren', sub: 'droge ruimtes', lines: sortQ(floors) },
    { id: 'plint', title: 'Plinten', sub: 'deuropeningen en trapgaten afgetrokken', lines: plint.rooms.length ? [fin(plint)] : [] },
    { id: 'verf', title: 'Verf', sub: 'muren per kleur, ramen en deuren afgetrokken', lines: [...sortQ(paints), ...(ceiling.rooms.length ? [fin(ceiling)] : [])], paint: true },
    { id: 'tegel', title: 'Tegels', sub: 'natte ruimtes', lines: [...(wallTiles.rooms.length ? [fin(wallTiles)] : []), ...sortQ(wetFloors)], tiles: true },
  ];
  const wetRooms = D.ROOMS.filter(r => r.wet).map(r => ({ id: r.id, name: r.name, on: tiled(r) }));
  let total = 0, priced = 0, lines = 0;
  for (const s of sections) for (const L of s.lines) { lines++; if (L.cost != null) { total += L.cost; priced++; } }
  return { sections, wetRooms, total, priced, lines, style: D.STYLES?.[st.style]?.name || '' };
}

function asText(M, S) {
  const out = ['Boodschappenlijst Ons Huis (indicatief)', ''];
  for (const s of M.sections) {
    if (!s.lines.length) continue;
    let head = s.title.toUpperCase();
    if (s.paint) head += ` (${num(S.coats, 0)} lagen, ${num(S.cover, 1)} m²/l per laag)`;
    if (s.tiles) head += ` (wand tot ${num(S.tileH, 2)} m)`;
    out.push(head);
    for (const L of s.lines) {
      let t = `- ${L.label}${L.hex ? ` (${L.hex.toUpperCase()})` : ''}: ${num(L.qty, 1)} ${L.unit}`;
      if (L.paint) t += ` = ca. ${num(L.liters, 1)} l`;
      else if (L.wastePct) t += ` + ${num(L.wastePct, 0)}% snijverlies = ${num(L.buy, 1)} ${L.unit}`;
      if (L.price != null) t += ` × ${eur(L.price)}/${L.buyUnit} = ${eur(L.cost)}`;
      out.push(t);
      out.push('    ' + L.rooms.map(r => `${r.tag} ${num(r.qty, 1)} ${L.unit}`).join('; '));
    }
    out.push('');
  }
  out.push(M.priced ? `TOTAAL (indicatief, ${M.priced} van ${M.lines} regels geprijsd): ${eur(M.total)}` : 'TOTAAL: vul prijzen in voor een totaalbedrag');
  out.push('Schattingen uit het 3D-model (±10 cm). Meet na voordat je bestelt.');
  return out.join('\n');
}

/* ================= UI ================= */
const CSS = `
.hk-shop{position:absolute;left:16px;top:var(--hk-shop-top,calc(16px + env(safe-area-inset-top,0px)));bottom:calc(16px + env(safe-area-inset-bottom,0px));width:min(390px,calc(100vw - 32px));z-index:7;
  display:flex;flex-direction:column;box-sizing:border-box;background:var(--surface,#f7f8f5);color:var(--ink,#1b231f);border:1px solid var(--line,#d0d7cf);border-radius:16px;
  box-shadow:var(--shadow,0 12px 32px rgba(0,0,0,.18));overflow:hidden;font:14px/1.4 var(--font-body,system-ui)}
.hk-shop *{box-sizing:border-box}
.hk-shop .hd{display:flex;align-items:flex-start;gap:10px;padding:14px 14px 10px 18px;border-bottom:1px solid var(--line,#d0d7cf)}
.hk-shop .hd .t{flex:1;min-width:0}
.hk-shop .ey{font:500 11px/1 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2,#56625b)}
.hk-shop h2{font:700 22px/1.1 var(--font-display,system-ui);margin:4px 0 0;letter-spacing:-.015em}
.hk-shop .x{border:1px solid var(--line,#d0d7cf);background:var(--surface-2,#edf0eb);color:var(--ink,#111);border-radius:999px;width:34px;height:34px;display:grid;place-items:center;flex:none;padding:0;cursor:pointer}
.hk-shop .bd{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px 18px 8px;flex:1;min-height:0}
.hk-shop section{padding:12px 0 6px;border-bottom:1px solid var(--line,#d0d7cf);min-width:0}
.hk-shop section:last-child{border-bottom:0}
.hk-shop h3{font:500 11px/1.2 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2,#56625b);margin:0 0 8px;display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
.hk-shop h3 small{font:400 12px/1.2 var(--font-body,system-ui);letter-spacing:0;text-transform:none}
.hk-shop .ln{background:var(--surface-2,#edf0eb);border:1px solid var(--line,#d0d7cf);border-radius:var(--r-sm,8px);padding:9px 11px;margin:0 0 8px;min-width:0}
.hk-shop .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:baseline}
.hk-shop .lh{font-weight:600;overflow-wrap:anywhere;display:flex;align-items:center;gap:7px;min-width:0}
.hk-shop .sw{width:14px;height:14px;border-radius:50%;border:1px solid rgba(0,0,0,.2);flex:none}
.hk-shop .q{font:500 13px/1.3 var(--font-mono,monospace);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.hk-shop .rm{font-size:12.5px;color:var(--ink-2,#56625b);margin-top:3px}
.hk-shop .rm .q{font-size:12px;color:var(--ink-2,#56625b)}
.hk-shop .rm span{overflow-wrap:anywhere}
.hk-shop .rm i{font-style:normal;opacity:.85}
.hk-shop .ctl{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line,#d0d7cf);font-size:12.5px;color:var(--ink-2,#56625b)}
.hk-shop .ctl label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.hk-shop .ctl .buy{margin-left:auto;color:var(--ink,#111);font-weight:600}
.hk-shop .in{width:4.6em;border:1px solid var(--line,#d0d7cf);background:var(--surface,#fff);color:var(--ink,#111);border-radius:6px;padding:4px 6px;font:500 13px/1.2 var(--font-mono,monospace);text-align:right;min-width:0}
.hk-shop .in.w{width:3.2em}
.hk-shop .set{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--ink-2,#56625b);margin:0 0 10px}
.hk-shop .set label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.hk-shop .chk{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line,#d0d7cf);background:var(--surface,#fff);border-radius:999px;padding:4px 10px;font-size:12.5px;color:var(--ink,#111)}
.hk-shop .chk input{accent-color:var(--accent,#2d5a4c);margin:0}
.hk-shop .ft{border-top:1px solid var(--line,#d0d7cf);padding:10px 18px calc(12px + env(safe-area-inset-bottom,0px));background:var(--surface,#f7f8f5)}
.hk-shop .tot{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.hk-shop .tot b{font:700 20px/1.1 var(--font-display,system-ui)}
.hk-shop .tot span{font-size:12.5px;color:var(--ink-2,#56625b)}
.hk-shop .note{font-size:12px;color:var(--ink-2,#56625b);margin:6px 0 10px}
.hk-shop .acts{display:flex;gap:8px;flex-wrap:wrap}
.hk-shop .btn{border:1px solid var(--line,#d0d7cf);background:var(--surface,#fff);color:var(--ink,#111);border-radius:var(--r-sm,8px);padding:8px 12px;font:500 13px/1.2 var(--font-body,system-ui);display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.hk-shop .btn.primary{background:var(--accent,#2d5a4c);color:var(--accent-ink,#fff);border-color:var(--accent,#2d5a4c)}
.hk-shop .btn svg{width:16px;height:16px}
.hk-shop textarea{width:100%;height:9em;margin-top:8px;border:1px solid var(--line,#d0d7cf);border-radius:var(--r-sm,8px);background:var(--surface,#fff);color:var(--ink,#111);font:12px/1.4 var(--font-mono,monospace);padding:8px;resize:vertical}
.hk-shop .empty{font-size:13px;color:var(--ink-2,#56625b);margin:0 0 8px}
@media (max-width:760px){
  .hk-shop{left:0;right:0;top:auto;bottom:0;width:auto;max-height:84vh;max-height:84dvh;border-radius:18px 18px 0 0;border-bottom:0;border-left:0;border-right:0}
  .hk-shop .hd{padding:8px 12px 8px 16px;position:relative}
  .hk-shop .hd::before{content:"";position:absolute;left:50%;top:6px;width:40px;height:4px;margin-left:-20px;border-radius:2px;background:var(--line,#ccc)}
  .hk-shop .hd .t{padding-top:8px}
  .hk-shop h2{font-size:19px}
  .hk-shop .bd{padding:2px 14px 8px}
  .hk-shop .ft{padding:8px 14px calc(10px + env(safe-area-inset-bottom,0px))}
}
`;

export function install(H) {
  if (!H) return null;
  if (H.__hkShopping) return H.__hkShopping;
  const K = getKit(H);
  injectCSS('hk-shop-style', CSS);
  const S = loadSettings();
  let G = null; // geometry is static; computed lazily on first open
  const geo = () => (G ||= computeGeometry(K));

  const root = document.getElementById('app') || document.body;
  const el = document.createElement('aside'); el.className = 'hk-shop'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'false'); el.setAttribute('aria-labelledby', 'hk-shop-title');
  el.innerHTML = `<div class="hd"><div class="t"><div class="ey">Indicatief · live uit het model</div><h2 id="hk-shop-title">Boodschappenlijst</h2></div>
    <button type="button" class="x" data-a="close" aria-label="Boodschappenlijst sluiten">${ICONS.close}</button></div>
    <div class="bd"></div>
    <div class="ft"><div class="tot"><span>Totaal indicatief</span><b data-o="total">–</b></div>
    <p class="note" data-o="note"></p>
    <div class="acts"><button type="button" class="btn primary" data-a="copy">${ICONS.copy}<span>Kopieer</span></button></div>
    <textarea data-o="fallback" hidden readonly aria-label="Lijst als tekst"></textarea></div>`;
  root.append(el);
  const bd = el.querySelector('.bd'), q = s => el.querySelector(s);
  let model = null, open = false, raf = 0;

  function lineHTML(L) {
    const qty = `${num(L.qty, 1)} ${L.unit}`;
    const rooms = L.rooms.map(r => `<div class="row rm"><span>${esc(r.tag)}${r.note ? ` <i>· ${esc(r.note)}</i>` : ''}</span><span class="q">${num(r.qty, 1)} ${L.unit}</span></div>`).join('');
    const pid = 'price:' + L.key, wid = 'waste:' + L.key, pv = S.price[L.key];
    const ctl = [];
    if (L.waste) ctl.push(`<label>Snijverlies <input class="in w" data-id="${esc(wid)}" inputmode="decimal" value="${esc(num(L.wastePct, 0))}" aria-label="Snijverlies in procent voor ${esc(L.label)}"> %</label>`);
    ctl.push(`<label>€ <input class="in" data-id="${esc(pid)}" inputmode="decimal" placeholder="prijs" value="${pv > 0 ? esc(num(+pv, 2)) : ''}" aria-label="Prijs per ${L.buyUnit} voor ${esc(L.label)}"> /${L.buyUnit}</label>`);
    const buy = L.paint ? `≈ ${num(L.liters, 1)} l` : L.wastePct ? `kopen ${num(L.buy, 1)} ${L.unit}` : '';
    ctl.push(`<span class="buy">${buy}${L.cost != null ? `${buy ? ' · ' : ''}${eur(L.cost)}` : ''}</span>`);
    return `<div class="ln"><div class="row"><span class="lh">${L.hex ? `<i class="sw" style="background:${esc(L.hex)}"></i>` : ''}${esc(L.label)}</span><span class="q">${qty}</span></div>${rooms}<div class="ctl">${ctl.join('')}</div></div>`;
  }
  function render() {
    raf = 0; if (!open) return;
    model = buildList(K, geo(), S);
    // keep focus, caret and the user's raw text in the input being edited
    const a = document.activeElement, fid = el.contains(a) ? a.dataset?.id : null, raw = fid ? a.value : null;
    let sel = null; try { sel = fid ? [a.selectionStart, a.selectionEnd] : null; } catch (e) { }
    const top = bd.scrollTop;
    let h = '';
    for (const s of model.sections) {
      h += `<section aria-labelledby="hk-s-${s.id}"><h3 id="hk-s-${s.id}">${esc(s.title)} <small>${esc(s.sub)}</small></h3>`;
      if (s.paint) h += `<div class="set"><label>Lagen <input class="in w" data-id="coats" inputmode="decimal" value="${esc(num(S.coats, 0))}" aria-label="Aantal lagen verf"></label><label>Dekking <input class="in w" data-id="cover" inputmode="decimal" value="${esc(num(S.cover, 1))}" aria-label="Dekking in m² per liter per laag"> m²/l per laag</label></div>`;
      if (s.tiles) {
        h += `<div class="set"><label>Tegelhoogte <input class="in w" data-id="tileH" inputmode="decimal" value="${esc(num(S.tileH, 2))}" aria-label="Hoogte wandtegels in meter"> m</label></div>`;
        if (model.wetRooms.length) h += `<div class="set">${model.wetRooms.map(r => `<label class="chk"><input type="checkbox" data-id="tile:${esc(r.id)}" ${r.on ? 'checked' : ''}> ${esc(r.name)}: wand betegelen</label>`).join('')}</div>`;
      }
      h += s.lines.length ? s.lines.map(lineHTML).join('') : `<p class="empty">Niets in deze categorie.</p>`;
      h += `</section>`;
    }
    bd.innerHTML = h;
    bd.scrollTop = top;
    if (fid) {
      const n = bd.querySelector(`[data-id="${CSS_escape(fid)}"]`);
      if (n) { n.focus({ preventScroll: true }); if (raw != null && n.type !== 'checkbox') n.value = raw; if (sel) { try { n.setSelectionRange(sel[0], sel[1]); } catch (e) { } } }
    }
    q('[data-o="total"]').textContent = model.priced ? eur(model.total) : '–';
    q('[data-o="note"]').textContent = (model.priced ? `${model.priced} van ${model.lines} regels hebben een prijs. ` : 'Vul per regel een prijs in voor een totaal. ')
      + 'Alle hoeveelheden zijn schattingen uit het 3D-model (±10 cm); meet na voordat je bestelt.';
  }
  const CSS_escape = s => (window.CSS?.escape ? window.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const schedule = () => { if (open && !raf) raf = requestAnimationFrame(render); };

  bd.addEventListener('input', e => {
    const id = e.target.dataset?.id; if (!id || e.target.type === 'checkbox') return;
    const v = parseNum(e.target.value);
    if (id.startsWith('price:')) { const k = id.slice(6); if (Number.isFinite(v) && v > 0) S.price[k] = v; else delete S.price[k]; }
    else if (id.startsWith('waste:')) { const k = id.slice(6); if (Number.isFinite(v) && v >= 0 && v <= 100) S.waste[k] = v; else delete S.waste[k]; }
    else if (id === 'coats') { if (v > 0 && v <= 10) S.coats = v; }
    else if (id === 'cover') { if (v > 0 && v <= 40) S.cover = v; }
    else if (id === 'tileH') { if (v >= 0 && v <= 4) S.tileH = v; }
    saveSettings(S); schedule();
  });
  bd.addEventListener('change', e => {
    const id = e.target.dataset?.id; if (!id) return;
    if (id.startsWith('tile:')) { S.tileWalls[id.slice(5)] = e.target.checked; saveSettings(S); schedule(); }
    else if (e.target.type !== 'checkbox') schedule(); // after blur the value is re-shown formatted
  });
  el.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') setOpen(false);
    else if (a === 'copy') copy();
  });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn?.focus?.(); } });

  function copy() {
    const text = asText(model || buildList(K, geo(), S), S);
    const ta = q('[data-o="fallback"]');
    const fallback = () => {
      ta.value = text; ta.hidden = false; ta.focus(); ta.select();
      let ok = false; try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
      K.toast(ok ? 'Lijst gekopieerd' : 'Kopiëren lukte niet: de tekst is geselecteerd, kopieer hem zelf (Ctrl/Cmd+C)');
    };
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => { ta.hidden = true; K.toast('Lijst gekopieerd'); }, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  // desktop: dock on the left under the top rail (and the measure chip, if shown) so the host's
  // finishes panel on the right stays usable and the list updates live; phones: bottom sheet (CSS)
  function place() {
    if (!open) return;
    const hr = (el.offsetParent || root).getBoundingClientRect();
    let top = 16;
    for (const n of [document.getElementById('topbar'), document.querySelector('.hk-mchip:not([hidden])')])
      if (n && n.offsetParent) top = Math.max(top, n.getBoundingClientRect().bottom - hr.top + 10);
    if (innerHeight - top < 320) top = 16; // short window: cover the rail instead of squeezing the list
    const v = Math.round(top) + 'px'; if (el.style.getPropertyValue('--hk-shop-top') !== v) el.style.setProperty('--hk-shop-top', v);
  }
  let off = null, placeT = 0;
  function setOpen(on) {
    on = !!on; if (on === open) return;
    open = on; el.hidden = !on;
    btn?.setAttribute?.('aria-pressed', String(on)); btn?.classList?.toggle?.('active', on);
    clearInterval(placeT);
    if (on) { off = K.on('change', schedule); place(); placeT = setInterval(place, 400); render(); q('[data-a="close"]').focus({ preventScroll: true }); }
    else { off?.(); off = null; q('[data-o="fallback"]').hidden = true; }
  }
  const btn = K.addTool({ id: 'boodschappen', label: 'Boodschappenlijst', icon: ICONS.list, title: 'Boodschappenlijst: vloeren, verf, tegels', onClick: () => setOpen(!open) });

  const api = {
    open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!open), get isOpen() { return open; },
    geometry: geo, list: () => buildList(K, geo(), S), text: () => asText(buildList(K, geo(), S), S), settings: S,
    refresh: schedule, get missing() { return [...K.missing]; },
    dispose() { setOpen(false); el.remove(); btn?.remove?.(); delete H.__hkShopping; },
  };
  H.__hkShopping = api; H.shopping = H.shopping || api;
  return api;
}

whenHouse(install);
