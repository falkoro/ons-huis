/* office.js — kantoor-/gamehoek in de zitkamer (add-on voor de woning-walkthrough)
 *
 *  - Flightsim-cockpit: stuur, gashendels, pedalen, kuipstoel en een gebogen 21:9-scherm waarop live een vlucht
 *    boven de polder draait (2D-canvas met perspectief: velden, sloten, molens, landingsbaan + HUD).
 *    E / klik op het scherm = zelf vliegen (Esc = terug naar lopen).
 *  - Bureau met pc, 2 monitoren en gamestoel. Monitor 1 toont Asmongold (kanaal "zackrawrr"):
 *      falkoro.github.io / localhost / 127.0.0.1  -> officiële Twitch-embed via CSS3DRenderer ("hole punch")
 *      elders (bv. claude.ai-artifact)            -> geanimeerd voorbeeldbeeld + link naar twitch.tv/zackrawrr
 *    Forceren kan met ?stream=twitch of ?stream=fallback.
 *  - Subtiele RGB-gloed. Statische delen zijn per materiaal samengevoegd (5 draw calls + 3 schermen + 3 gloedvlakken).
 *
 * Laden (na de hoofdmodule):  <script type="module" src="./modules/office.js"></script>
 * Gebruikt alleen de bestaande import map ("three", "three/addons/"). Exporteert install(HOUSE); start zelf op.
 */

const CHANNEL = 'zackrawrr';
const TWITCH_PAGE = 'https://www.twitch.tv/' + CHANNEL;
const TWITCH_HOSTS = ['falkoro.github.io', 'localhost', '127.0.0.1'];
const ROOM_ID = 'zitkamer';
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapP = (v, p) => v - Math.round(v / p) * p;
function hash(i, j, s = 0) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul((s | 0) + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const ENV = (() => {
  const mm = q => { try { return matchMedia(q).matches; } catch (e) { return false; } };
  const coarse = mm('(pointer: coarse)');
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const phone = /Android|iPhone|iPod|Mobile/i.test(ua) || (coarse && Math.min(screen.width || 9999, screen.height || 9999) < 820);
  let q = null; try { q = new URLSearchParams(location.search).get('stream'); } catch (e) { /* geen query */ }
  const stream = q === 'twitch' || q === 'fallback' ? q : (TWITCH_HOSTS.includes(location.hostname) ? 'twitch' : 'fallback');
  const reduced = mm('(prefers-reduced-motion: reduce)');
  return { coarse, phone, stream, reduced };
})();

/* =====================================================================================================
 *  FLIGHT SIM (2D canvas, eigen perspectief)
 * ===================================================================================================== */
const PX = 6000, PN = 8000, RWL = 1800, RWW = 45;           // wereldperiode O-W / Z-N, baanlengte/-breedte (m)
const CE = 120, CN = 260, CANAL = 720, ROADN = 1040, OG = 500, CG = 1700;
const CAM_OFF = -0.05;                                        // camera kijkt iets omlaag t.o.v. de neus
const HZ = 1500;                                              // nevel-afstand
const C = {
  zen: '#4d84c4', hor: '#d6e3ea', haze: [214, 225, 230], ditch: [62, 92, 64],
  greens: [[92, 146, 60], [108, 156, 66], [80, 132, 54], [122, 164, 74], [98, 140, 62], [86, 128, 58]],
  wheat: [196, 182, 104], rape: [222, 204, 70], plough: [126, 102, 78], glass: [172, 190, 186],
  bulbs: [[214, 60, 53], [239, 201, 58], [224, 112, 154], [139, 73, 181], [243, 239, 228], [239, 127, 42]],
  water: [76, 122, 146], road: [112, 112, 108], rwy: [74, 76, 80], mark: [238, 238, 234], grass: [138, 170, 96],
  mill: [72, 58, 48], millCap: [52, 44, 38], sail: [236, 228, 210], white: [238, 240, 240], wall: [214, 204, 188],
  brick: [150, 74, 52], roof: [122, 52, 38], roof2: [86, 92, 98], tree: [54, 86, 44], trunk: [70, 54, 40], hangar: [150, 156, 162],
};
const col = (c, k) => `rgb(${(c[0] + (C.haze[0] - c[0]) * k) | 0},${(c[1] + (C.haze[1] - c[1]) * k) | 0},${(c[2] + (C.haze[2] - c[2]) * k) | 0})`;

function newFlight() { return { e: 20, n: -2650, h: 160, psi: 0.04, phi: 0, theta: -0.045, v: 62, thr: 0.45, vs: 0, t: 0, ap: true }; }

function stepFlight(f, dt, inp) {
  f.t += dt;
  if (f.ap) {
    const s = ((f.n % PN) + PN) % PN, dThr = PN - s;
    let hc, xt = 0;
    if (s < RWL - 250) hc = 24;                                         // lage passage boven de baan
    else if (dThr < 2850) hc = 24 + dThr * 0.0524;                      // 3°-glijpad
    else {                                                              // uitklimmen + S-bochten boven de polder
      const a = s - (RWL - 250), u = a / (PN - 2850 - (RWL - 250));
      hc = Math.min(173, 24 + a * 0.08); xt = 320 * Math.sin(u * Math.PI * 2);
    }
    const err = wrapP(f.e, PX) - xt;
    const psiCmd = clamp(-err * 0.0025, -0.5, 0.5);
    const phiCmd = clamp(wrapP(psiCmd - f.psi, Math.PI * 2) * 2.2, -0.42, 0.42) + 0.025 * Math.sin(f.t * 0.9) + 0.012 * Math.sin(f.t * 2.3 + 1);
    f.phi += (phiCmd - f.phi) * Math.min(1, dt * 1.3);
    f.theta += (clamp((hc - f.h) * 0.012, -0.08, 0.1) - f.theta) * Math.min(1, dt * 0.9);
    f.thr = lerp(f.thr, s < RWL ? 0.62 : dThr < 2850 ? 0.42 : 0.6, Math.min(1, dt * 0.5));
  } else {
    if (Math.abs(inp.roll) > 0.02) f.phi = clamp(f.phi + inp.roll * 1.15 * dt, -1.05, 1.05); else f.phi *= Math.max(0, 1 - dt * 0.7);
    if (Math.abs(inp.pitch) > 0.02) f.theta = clamp(f.theta + inp.pitch * 0.5 * dt, -0.45, 0.45); else f.theta *= Math.max(0, 1 - dt * 0.12);
    f.thr = clamp(f.thr + inp.thr * 0.5 * dt, 0, 1);
  }
  f.v = clamp(f.v + (40 + f.thr * 52 - f.theta * 40 - f.v) * Math.min(1, dt * 0.35), 30, 110);
  f.psi = wrapP(f.psi + 9.81 * Math.tan(f.phi) / f.v * dt, Math.PI * 2);
  const hv = f.v * Math.cos(f.theta);
  f.e += Math.sin(f.psi) * hv * dt; f.n += Math.cos(f.psi) * hv * dt;
  f.vs = f.v * Math.sin(f.theta); f.h += f.vs * dt;
  if (f.h < 12) { f.h = 12; if (f.theta < 0) f.theta = 0; }
  if (f.h > 1500) { f.h = 1500; if (f.theta > 0) f.theta *= 0.9; }
}

function makeSimRenderer() {
  let g, W, H, F, cp, sp, ct, st, fe, fn, fh, LAT;
  const ax = new Float64Array(8), au = new Float64Array(8), aw = new Float64Array(8);
  const bx = new Float64Array(10), bu = new Float64Array(10), bw = new Float64Array(10);
  const NEAR = 1.5, objs = [];
  function tf(pe, pn, py, i) {
    const de = pe - fe, dn = pn - fn, dy = py - fh, zf = de * sp + dn * cp;
    ax[i] = de * cp - dn * sp; aw[i] = zf * ct + dy * st; au[i] = dy * ct - zf * st;
  }
  function fillPoly(n) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, wi = aw[i], wj = aw[j], inI = wi >= NEAR;
      if (inI) { bx[m] = ax[i]; bu[m] = au[i]; bw[m] = wi; m++; }
      if (inI !== (wj >= NEAR)) { const t = (NEAR - wi) / (wj - wi); bx[m] = ax[i] + (ax[j] - ax[i]) * t; bu[m] = au[i] + (au[j] - au[i]) * t; bw[m] = NEAR; m++; }
    }
    if (m < 3) return;
    g.beginPath();
    for (let i = 0; i < m; i++) { const X = F * bx[i] / bw[i], Y = -F * bu[i] / bw[i]; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.fill();
  }
  function gq(e0, n0, e1, n1, y = 0) { tf(e0, n0, y, 0); tf(e1, n0, y, 1); tf(e1, n1, y, 2); tf(e0, n1, y, 3); fillPoly(4); }
  function visible(ec, nc, rad) {                       // grove culling op het middelpunt
    const de = ec - fe, dn = nc - fn, zf = de * sp + dn * cp, fw = zf * ct - fh * st;
    if (fw < -rad) return -1;
    if (Math.abs(de * cp - dn * sp) > Math.max(fw, 0) * LAT + rad) return -1;
    return Math.hypot(de, dn);
  }
  const P = { X: 0, Y: 0, s: 0, w: 0 };
  function proj(pe, pn, py) { tf(pe, pn, py, 0); if (aw[0] < 4) return null; P.w = aw[0]; P.s = F / aw[0]; P.X = F * ax[0] / aw[0]; P.Y = -F * au[0] / aw[0]; return P; }

  function sprite(o) {
    const { X, Y, s, k, kind, seed } = o, t = o.t;
    if (kind === 'mill') {
      g.fillStyle = col(C.mill, k);
      g.beginPath(); g.moveTo(X - 3.6 * s, Y); g.lineTo(X + 3.6 * s, Y); g.lineTo(X + 2 * s, Y - 20 * s); g.lineTo(X - 2 * s, Y - 20 * s); g.fill();
      g.fillRect(X - 5 * s, Y - 7 * s, 10 * s, Math.max(0.6, 0.8 * s));
      g.fillStyle = col(C.millCap, k); g.beginPath(); g.arc(X, Y - 20 * s, 2.8 * s, Math.PI, 0); g.fill();
      const hx = X, hy = Y - 21 * s, a0 = t * 1.3 + seed * 6;
      g.fillStyle = col(C.sail, k);
      for (let q = 0; q < 4; q++) {
        const a = a0 + q * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
        g.beginPath();
        g.moveTo(hx + ca * 2.5 * s, hy + sa * 2.5 * s); g.lineTo(hx + ca * 13 * s, hy + sa * 13 * s);
        g.lineTo(hx + (ca * 13 + nx * 2.4) * s, hy + (sa * 13 + ny * 2.4) * s); g.lineTo(hx + (ca * 2.5 + nx * 2.4) * s, hy + (sa * 2.5 + ny * 2.4) * s); g.fill();
        g.fillRect(hx + ca * 6 * s - 0.4, hy + sa * 6 * s - 0.4, 0.8, 0.8);
      }
    } else if (kind === 'turbine') {
      g.fillStyle = col(C.white, k);
      g.beginPath(); g.moveTo(X - 2.2 * s, Y); g.lineTo(X + 2.2 * s, Y); g.lineTo(X + 1.2 * s, Y - 90 * s); g.lineTo(X - 1.2 * s, Y - 90 * s); g.fill();
      g.fillRect(X - 3 * s, Y - 92 * s, 6 * s, 3 * s);
      const hx = X, hy = Y - 91 * s, a0 = t * 0.9 + seed * 6;
      for (let q = 0; q < 3; q++) {
        const a = a0 + q * Math.PI * 2 / 3, ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
        g.beginPath(); g.moveTo(hx + nx * 1.6 * s, hy + ny * 1.6 * s); g.lineTo(hx + ca * 40 * s, hy + sa * 40 * s); g.lineTo(hx - nx * 1.0 * s, hy - ny * 1.0 * s); g.fill();
      }
    } else if (kind === 'farm' || kind === 'church') {
      if (kind === 'church') {
        g.fillStyle = col(C.brick, k); g.fillRect(X - 7 * s, Y - 9 * s, 14 * s, 9 * s); g.fillRect(X + 6 * s, Y - 24 * s, 5 * s, 24 * s);
        g.fillStyle = col(C.roof2, k);
        g.beginPath(); g.moveTo(X - 8 * s, Y - 9 * s); g.lineTo(X + 7 * s, Y - 9 * s); g.lineTo(X - 0.5 * s, Y - 15 * s); g.fill();
        g.beginPath(); g.moveTo(X + 5.5 * s, Y - 24 * s); g.lineTo(X + 11.5 * s, Y - 24 * s); g.lineTo(X + 8.5 * s, Y - 38 * s); g.fill();
      } else {
        g.fillStyle = col(seed > 0.5 ? C.wall : C.brick, k); g.fillRect(X - 5.5 * s, Y - 5 * s, 11 * s, 5 * s);
        g.fillStyle = col(C.roof, k); g.beginPath(); g.moveTo(X - 6.5 * s, Y - 5 * s); g.lineTo(X + 6.5 * s, Y - 5 * s); g.lineTo(X, Y - 11 * s); g.fill();
        g.fillStyle = col(C.roof2, k); g.beginPath(); g.moveTo(X + 7 * s, Y); g.lineTo(X + 7 * s, Y - 6 * s); g.lineTo(X + 15 * s, Y - 12 * s); g.lineTo(X + 23 * s, Y - 6 * s); g.lineTo(X + 23 * s, Y); g.fill();
      }
      g.fillStyle = col(C.tree, k);
      for (let q = 0; q < 3; q++) { g.beginPath(); g.arc(X - (10 + q * 5) * s, Y - (6 + (q & 1) * 2) * s, (4 + q % 2) * s, 0, 7); g.fill(); }
    } else if (kind === 'tree') {
      g.fillStyle = col(C.trunk, k); g.fillRect(X - 0.4 * s, Y - 4 * s, 0.8 * s + 0.3, 4 * s);
      g.fillStyle = col(C.tree, k); g.beginPath(); g.arc(X, Y - 7 * s, 3.6 * s + 0.4, 0, 7); g.fill();
    } else if (kind === 'hangar') {
      g.fillStyle = col(C.hangar, k); g.beginPath(); g.moveTo(X - 22 * s, Y); g.lineTo(X - 22 * s, Y - 9 * s); g.quadraticCurveTo(X, Y - 17 * s, X + 22 * s, Y - 9 * s); g.lineTo(X + 22 * s, Y); g.fill();
      g.fillStyle = col([96, 100, 104], k); g.fillRect(X - 14 * s, Y - 8 * s, 28 * s, 8 * s);
    }
  }

  function draw(ctx, w, h, f, opt = {}) {
    g = ctx; W = w; H = h;
    F = (H / 2) / Math.tan((opt.vfov || 36) * DEG / 2);
    const th = f.theta + CAM_OFF; cp = Math.cos(f.psi); sp = Math.sin(f.psi); ct = Math.cos(th); st = Math.sin(th);
    fe = f.e; fn = f.n; fh = f.h; const t = f.t;
    const D = Math.hypot(W, H); LAT = (D / 2) / F;
    g.save(); g.translate(W / 2, H / 2); g.rotate(-f.phi);
    const hy = F * Math.tan(th);
    // lucht
    let gr = g.createLinearGradient(0, hy - H * 0.9, 0, hy);
    gr.addColorStop(0, C.zen); gr.addColorStop(1, C.hor); g.fillStyle = gr; g.fillRect(-D, hy - 3 * D, 2 * D, 3 * D);
    // zon
    const sa = 0.55, se = 0.2, sde = Math.sin(sa) * Math.cos(se) * 1e5, sdn = Math.cos(sa) * Math.cos(se) * 1e5, sdy = Math.sin(se) * 1e5;
    if (proj(fe + sde, fn + sdn, fh + sdy)) {
      const r = H * 0.35; gr = g.createRadialGradient(P.X, P.Y, 0, P.X, P.Y, r);
      gr.addColorStop(0, 'rgba(255,250,230,1)'); gr.addColorStop(0.06, 'rgba(255,246,214,.95)'); gr.addColorStop(0.2, 'rgba(255,236,190,.35)'); gr.addColorStop(1, 'rgba(255,236,190,0)');
      g.fillStyle = gr; g.fillRect(P.X - r, P.Y - r, 2 * r, 2 * r);
    }
    // wolken
    const cr = 5200, ci0 = Math.floor((fe - cr) / CG), ci1 = Math.floor((fe + cr) / CG), cj0 = Math.floor((fn - cr) / CG), cj1 = Math.floor((fn + cr) / CG);
    for (let i = ci0; i <= ci1; i++) for (let j = cj0; j <= cj1; j++) {
      const hh = hash(i, j, 41); if (hh > 0.45) continue;
      const ce = i * CG + hash(i, j, 42) * CG, cn = j * CG + hash(i, j, 43) * CG, cy = 620 + hash(i, j, 44) * 220;
      if (!proj(ce, cn, cy)) continue;
      const d = Math.hypot(ce - fe, cn - fn), a = 0.9 * Math.exp(-d / 4200); if (a < 0.05) continue;
      const s = P.s, X = P.X, Y = P.Y; if (Math.abs(X) > D || Math.abs(Y) > D) continue;
      g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      for (let q = 0; q < 5; q++) { const ox = (q - 2) * 55 * s, oy = -Math.abs(Math.sin(q * 1.7 + i)) * 40 * s; g.beginPath(); g.ellipse(X + ox, Y + oy, 70 * s, 38 * s, 0, 0, 7); g.fill(); }
      g.fillStyle = `rgba(214,222,232,${(a * 0.7).toFixed(3)})`; g.beginPath(); g.ellipse(X, Y + 12 * s, 150 * s, 14 * s, 0, 0, 7); g.fill();
    }
    // grond (basis = slootwater/gras, nevel naar de horizon)
    gr = g.createLinearGradient(0, hy, 0, hy + H * 0.8);
    gr.addColorStop(0, col(C.ditch, 0.92)); gr.addColorStop(0.25, col(C.ditch, 0.45)); gr.addColorStop(1, col(C.ditch, 0)); g.fillStyle = gr; g.fillRect(-D, hy, 2 * D, 3 * D);
    // percelen
    const R = 2500, i0 = Math.floor((fe - R) / CE), i1 = Math.floor((fe + R) / CE), j0 = Math.floor((fn - R) / CN), j1 = Math.floor((fn + R) / CN);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const e0 = i * CE, n0 = j * CN, d = visible(e0 + CE / 2, n0 + CN / 2, 150); if (d < 0 || d > 2900) continue;
      const k = 1 - Math.exp(-d / HZ), hh = hash(i, j, 7), ins = d < 1000 ? 2.2 : 0;
      let c;
      if (hh < 0.55) c = C.greens[(hash(i, j, 8) * 6) | 0];
      else if (hh < 0.63) c = C.wheat; else if (hh < 0.73) c = C.plough; else if (hh < 0.78) c = C.rape;
      else if (hh < 0.91) {                                            // bollenveld: stroken
        const a = C.bulbs[(hash(i, j, 9) * 6) | 0], b = C.bulbs[(hash(i, j, 10) * 6) | 0];
        if (d < 1300) { const sw = (CE - 2 * ins) / 6; for (let q = 0; q < 6; q++) { g.fillStyle = col(q & 1 ? b : a, k); gq(e0 + ins + q * sw, n0 + ins, e0 + ins + (q + 1) * sw, n0 + CN - ins); } continue; }
        c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      } else if (hh < 0.935) c = C.glass; else c = C.greens[2];
      g.fillStyle = col(c, k); gq(e0 + ins, n0 + ins, e0 + CE - ins, n0 + CN - ins);
    }
    // vaarten
    for (let q = Math.floor((fe - R) / CANAL); q <= Math.floor((fe + R) / CANAL); q++) {
      const e = q * CANAL + 360; if (visible(e, fn, R) < 0) continue;
      g.fillStyle = col(C.water, 0.25); gq(e - 9, fn - 200, e + 9, fn + R);
    }
    // vliegveld (baan bij e ≡ 0 mod PX, n ∈ [0, RWL] mod PN)
    const e0r = fe - wrapP(fe, PX), nb = fn - (((fn % PN) + PN) % PN);
    const airs = [nb, nb + PN];
    const inAir = (e, n) => { const de = Math.abs(wrapP(e, PX)), sn = ((n % PN) + PN) % PN; return de < 260 && (sn > PN - 1000 || sn < RWL + 300); };
    // wegen (onderbroken rond het vliegveld)
    for (let q = Math.floor((fn - R) / ROADN); q <= Math.floor((fn + R) / ROADN); q++) {
      const n = q * ROADN + 520; g.fillStyle = col(C.road, 0.2);
      if (inAir(e0r, n)) { gq(fe - R, n - 3.5, e0r - 260, n + 3.5); gq(e0r + 260, n - 3.5, fe + R, n + 3.5); } else gq(fe - R, n - 3.5, fe + R, n + 3.5);
    }
    for (const n0 of airs) {
      if (visible(e0r, n0 + RWL / 2, RWL) < 0) continue;
      const d = Math.hypot(e0r - fe, n0 + RWL / 2 - fn), k = clamp(1 - Math.exp(-Math.max(0, d - 600) / HZ), 0, 1);
      g.fillStyle = col(C.grass, k); gq(e0r - 150, n0 - 120, e0r + 150, n0 + RWL + 120);
      g.fillStyle = col([104, 106, 108], k); gq(e0r + 40, n0 + 520, e0r + 120, n0 + 760); gq(e0r + RWW / 2, n0 + 600, e0r + 40, n0 + 616);
      g.fillStyle = col(C.rwy, k); gq(e0r - RWW / 2, n0, e0r + RWW / 2, n0 + RWL);
      g.fillStyle = col(C.mark, k);
      for (let b = 0; b < 6; b++) { const o = 4 + b * 2.9; gq(e0r - o - 1.8, n0 + 6, e0r - o, n0 + 40); gq(e0r + o, n0 + 6, e0r + o + 1.8, n0 + 40); }
      gq(e0r - 13, n0 + 300, e0r - 8, n0 + 345); gq(e0r + 8, n0 + 300, e0r + 13, n0 + 345);
      if (d < 2200) for (let z = n0 + 80; z < n0 + RWL - 60; z += 50) gq(e0r - 0.5, z, e0r + 0.5, z + 28);
      gq(e0r - RWW / 2 + 0.6, n0, e0r - RWW / 2 + 1.4, n0 + RWL); gq(e0r + RWW / 2 - 1.4, n0, e0r + RWW / 2 - 0.6, n0 + RWL);
    }
    // objecten (molens, boerderijen, turbines, bomen) — van ver naar dichtbij
    objs.length = 0;
    const pushObj = (pe, pn, kind, seed, maxD) => {
      if (inAir(pe, pn)) return;
      const d = Math.hypot(pe - fe, pn - fn); if (d > maxD || !proj(pe, pn, 0)) return;
      if (Math.abs(P.X) > D / 2 + 120 * P.s || P.Y < -D || P.Y > D) return;
      objs.push({ X: P.X, Y: P.Y, s: P.s, w: P.w, k: 1 - Math.exp(-d / HZ), kind, seed, t });
    };
    for (let i = Math.floor((fe - R) / OG); i <= Math.floor((fe + R) / OG); i++) for (let j = Math.floor((fn - R) / OG); j <= Math.floor((fn + R) / OG); j++) {
      const hh = hash(i, j, 21), pe = i * OG + 60 + hash(i, j, 22) * 380, pn = j * OG + 60 + hash(i, j, 23) * 380;
      if (hh < 0.12) pushObj(pe, pn, 'mill', hash(i, j, 24), 2800);
      else if (hh < 0.15) pushObj(pe, pn, 'turbine', hash(i, j, 24), 2900);
      else if (hh < 0.42) pushObj(pe, pn, 'farm', hash(i, j, 24), 2400);
      else if (hh < 0.44) pushObj(pe, pn, 'church', hash(i, j, 24), 2600);
    }
    for (let q = Math.floor((fn - 900) / ROADN); q <= Math.floor((fn + 900) / ROADN); q++) {
      const n = q * ROADN + 520 + 8;
      for (let e = Math.floor((fe - 900) / 28) * 28; e < fe + 900; e += 28) pushObj(e, n, 'tree', 0, 900);
    }
    for (const n0 of airs) { const d = Math.hypot(e0r + 160 - fe, n0 + 640 - fn); if (d < 2800 && proj(e0r + 160, n0 + 640, 0)) objs.push({ X: P.X, Y: P.Y, s: P.s, w: P.w, k: 1 - Math.exp(-d / HZ), kind: 'hangar', seed: 0, t }); }
    objs.sort((a, b) => b.w - a.w);
    for (const o of objs) sprite(o);
    // naderingslichten + PAPI
    for (const n0 of airs) {
      for (let z = n0 - 900; z < n0; z += 30) {
        if (!proj(e0r, z, 0.5)) continue;
        const rab = ((t * 2) % 1) * 30 | 0, on = ((n0 - z) / 30 | 0) === 30 - rab;
        const r = Math.max(0.9, 1.6 * P.s) * (on ? 2.4 : 1);
        g.fillStyle = on ? '#ffffff' : 'rgba(255,240,200,.9)'; g.fillRect(P.X - r / 2, P.Y - r / 2, r, r);
      }
      const dz = n0 + 300 - fn;
      if (dz > 60) {
        const ang = Math.atan2(fh, dz) / DEG;
        for (let q = 0; q < 4; q++) {
          if (!proj(e0r - 32 - q * 9, n0 + 300, 0.5)) continue;
          const white = ang > [3.5, 3.17, 2.83, 2.5][q];
          const r = Math.max(1.2, 1.8 * P.s); g.fillStyle = white ? '#ffffff' : '#ff3b30'; g.fillRect(P.X - r / 2, P.Y - r / 2, r, r);
        }
      }
    }
    g.restore();
    if (opt.hud !== false) drawHUD(ctx, W, H, f, F, th, opt.hudScale || W / 560);
  }
  return { draw };
}

function drawHUD(g, W, H, f, F, th, s) {
  const cx = W / 2, cy = H / 2, G = '#8dffb0';
  g.save();
  g.strokeStyle = G; g.fillStyle = G; g.lineWidth = Math.max(1, 1.3 * s); g.lineJoin = 'round'; g.lineCap = 'round';
  g.shadowColor = 'rgba(0,30,12,.85)'; g.shadowBlur = 2.5 * s;
  const font = px => `600 ${Math.round(px * s)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  g.font = font(10); g.textBaseline = 'middle'; g.textAlign = 'center';
  // horizon + pitch-ladder
  g.save(); g.beginPath(); g.rect(cx - 100 * s, cy - 72 * s, 200 * s, 144 * s); g.clip();
  g.translate(cx, cy); g.rotate(-f.phi);
  for (let d = -40; d <= 40; d += 5) {
    const y = F * Math.tan(th - d * DEG); if (Math.abs(y) > 160 * s) continue;
    g.beginPath();
    if (d === 0) { g.moveTo(-96 * s, y); g.lineTo(-14 * s, y); g.moveTo(14 * s, y); g.lineTo(96 * s, y); g.stroke(); continue; }
    const w = 24 * s, gap = 12 * s, tk = (d > 0 ? 4 : -4) * s;
    g.setLineDash(d < 0 ? [4 * s, 3 * s] : []);
    g.moveTo(-gap - w, y + tk); g.lineTo(-gap - w, y); g.lineTo(-gap, y); g.moveTo(gap, y); g.lineTo(gap + w, y); g.lineTo(gap + w, y + tk); g.stroke();
    g.setLineDash([]); g.fillText(String(Math.abs(d)), -gap - w - 9 * s, y); g.fillText(String(Math.abs(d)), gap + w + 9 * s, y);
  }
  g.restore();
  // vliegtuigsymbool
  const wy = cy + F * Math.tan(CAM_OFF);
  g.beginPath(); g.moveTo(cx - 24 * s, wy); g.lineTo(cx - 9 * s, wy); g.lineTo(cx - 4.5 * s, wy + 5 * s); g.lineTo(cx, wy); g.lineTo(cx + 4.5 * s, wy + 5 * s); g.lineTo(cx + 9 * s, wy); g.lineTo(cx + 24 * s, wy); g.stroke();
  // rolhoekschaal
  const r = 84 * s;
  g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG); g.stroke();
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const aa = a * DEG, L = (a % 30 === 0 ? 7 : 4) * s;
    g.beginPath(); g.moveTo(cx + Math.sin(aa) * r, cy - Math.cos(aa) * r); g.lineTo(cx + Math.sin(aa) * (r + L), cy - Math.cos(aa) * (r + L)); g.stroke();
  }
  { const aa = -f.phi; g.beginPath(); g.moveTo(cx + Math.sin(aa) * (r - 1 * s), cy - Math.cos(aa) * (r - 1 * s));
    g.lineTo(cx + Math.sin(aa) * (r - 8 * s) + Math.cos(aa) * 4 * s, cy - Math.cos(aa) * (r - 8 * s) + Math.sin(aa) * 4 * s);
    g.lineTo(cx + Math.sin(aa) * (r - 8 * s) - Math.cos(aa) * 4 * s, cy - Math.cos(aa) * (r - 8 * s) - Math.sin(aa) * 4 * s); g.closePath(); g.fill(); }
  // tapes
  const tape = (x, val, unitPx, step, lab, side, title, digits) => {
    const hh = 66 * s;
    g.save(); g.beginPath(); g.rect(x - 26 * s, cy - hh, 52 * s, 2 * hh); g.clip();
    g.fillStyle = 'rgba(0,20,8,.28)'; g.fillRect(x - 26 * s, cy - hh, 52 * s, 2 * hh); g.fillStyle = G;
    const v0 = Math.floor((val - hh / unitPx) / step) * step;
    for (let v = v0; v <= val + hh / unitPx; v += step) {
      const y = cy - (v - val) * unitPx, big = Math.round(v / step) % lab === 0;
      g.beginPath(); g.moveTo(x + side * 26 * s, y); g.lineTo(x + side * (26 - (big ? 8 : 4)) * s, y); g.stroke();
      if (big) g.fillText(String(Math.round(v)), x - side * 3 * s, y);
    }
    g.restore();
    g.fillStyle = 'rgba(0,18,8,.85)'; g.fillRect(x - 25 * s, cy - 8 * s, 50 * s, 16 * s); g.strokeRect(x - 25 * s, cy - 8 * s, 50 * s, 16 * s);
    g.fillStyle = G; g.font = font(11); g.fillText(String(Math.round(val)).padStart(digits, ' '), x, cy); g.font = font(10);
    g.fillText(title, x, cy + hh + 9 * s);
  };
  const kt = f.v * 1.944, ft = f.h * 3.281;
  tape(46 * s, kt, 1.4 * s, 5, 2, 1, 'KT', 3);
  tape(W - 46 * s, ft, 0.13 * s, 100, 5, -1, 'FT', 4);
  g.fillText(`VS ${f.vs >= 0 ? '+' : '−'}${Math.abs(Math.round(f.vs * 196.85 / 10) * 10)}`, W - 46 * s, cy - 76 * s);
  // koersband
  const hdg = ((f.psi / DEG) % 360 + 360) % 360, hw = 70 * s, ppd = 2.2 * s, ty = 12 * s;
  g.save(); g.beginPath(); g.rect(cx - hw, 0, 2 * hw, 24 * s); g.clip();
  for (let d = Math.floor((hdg - 35) / 5) * 5; d <= hdg + 35; d += 5) {
    const x = cx + (d - hdg) * ppd, dd = ((d % 360) + 360) % 360;
    g.beginPath(); g.moveTo(x, ty + 6 * s); g.lineTo(x, ty + (dd % 10 === 0 ? 1 : 3.5) * s); g.stroke();
    if (dd % 30 === 0) g.fillText({ 0: 'N', 90: 'O', 180: 'Z', 270: 'W' }[dd] || String(dd / 10).padStart(2, '0'), x, ty - 4 * s);
  }
  g.restore();
  g.beginPath(); g.moveTo(cx, ty + 8 * s); g.lineTo(cx - 4 * s, ty + 13 * s); g.lineTo(cx + 4 * s, ty + 13 * s); g.closePath(); g.fill();
  // statusregel
  g.font = font(9.5); g.textAlign = 'left';
  g.fillText(f.ap ? 'AP · HOOGTE · KOERS' : 'HANDMATIG', 10 * s, H - 10 * s);
  g.textAlign = 'right'; g.fillText(`GAS ${Math.round(f.thr * 100)}%`, W - 10 * s, H - 10 * s);
  const sn = ((f.n % PN) + PN) % PN, dThr = PN - sn;
  if (Math.abs(wrapP(f.e, PX)) < 600 && dThr < 4000 && Math.abs(wrapP(f.psi, Math.PI * 2)) < 0.6) { g.textAlign = 'center'; g.fillText(`BAAN 36 · ${(dThr / 1852).toFixed(1).replace('.', ',')} NM`, cx, H - 10 * s); }
  if (f.h < 60 && f.vs < -2 && !f.ap && (f.t * 3) % 1 < 0.6) { g.fillStyle = '#ffb347'; g.textAlign = 'center'; g.font = font(13); g.fillText('TERREIN — OPTREKKEN', cx, cy + 46 * s); }
  g.restore();
}

/* =====================================================================================================
 *  STREAM-VOORBEELDBEELD (canvas; geen echte beelden, gezichten of gebruikersnamen)
 * ===================================================================================================== */
function makeStreamFallback() {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const g = c.getContext('2d');
  const NAMES = ['polderpiloot', 'kaaskop_99', 'nachtuil', 'tulpentrol', 'stroopwafel77', 'dijkgraaf', 'windmolen_wim', 'bitterbal_b', 'koffieleut', 'molenaar_42', 'haringhap', 'klompje', 'grachtgoblin', 'drop_dealer', 'fietsbel'];
  const COLS = ['#ff7f50', '#9acd32', '#1e90ff', '#ff69b4', '#daa520', '#00ced1', '#ba55d3', '#ff4500', '#2ecc71', '#5f9ea0', '#e67e22', '#a78bfa'];
  const TXT = ['KEKW', 'LUL', 'Pog', 'W stream', 'gg', 'monkaS', 'nog 1 pull', 'heal de tank!', 'die boss heeft nog 2%', 'OMEGALUL', 'chat is dit echt', 'wipe incoming', 'let him cook', 'Clap Clap', 'waar is de healer??', 'eerste keer hier, wat een sfeer', 'goede vibes vandaag', 'loot pls', 'LETSGO', 'dit gevecht duurt eeuwig', 'hij ziet de mechanic niet', 'wie heeft de aggro', 'ICANT', 'Sadge', 'nog even volhouden', 'GG EZ'];
  const SYS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const msgs = []; let next = 0, scroll = 0, t = 0, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  function addMsg() {
    const name = NAMES[(rnd() * NAMES.length) | 0], color = COLS[(rnd() * COLS.length) | 0], text = TXT[(rnd() * TXT.length) | 0];
    g.font = `700 10px ${SYS}`; const nw = g.measureText(name + ': ').width;
    g.font = `10px ${SYS}`;
    const lines = []; let line = '', w = 150 - nw;
    for (const word of text.split(' ')) { const test = line ? line + ' ' + word : word; if (line && g.measureText(test).width > w) { lines.push(line); line = word; w = 150; } else line = test; }
    lines.push(line);
    msgs.push({ name, color, nw, lines }); if (msgs.length > 26) msgs.shift();
    scroll += lines.length * 13 + 3;
  }
  for (let i = 0; i < 16; i++) addMsg(); scroll = 0;

  function game(X, Y, w, h) {
    g.save(); g.beginPath(); g.rect(X, Y, w, h); g.clip(); g.translate(X, Y);
    let gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#1b1036'); gr.addColorStop(0.55, '#6b2d5c'); gr.addColorStop(1, '#d9774a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.7)'; for (let i = 0; i < 26; i++) g.fillRect(hash(i, 1, 5) * w, hash(i, 2, 5) * h * 0.45, 1, 1);
    g.fillStyle = 'rgba(255,236,200,.92)'; g.beginPath(); g.arc(w * 0.8, h * 0.24, 13, 0, 7); g.fill();
    const layers = [['#3a1f45', 0.58, 8, 60], ['#28152f', 0.68, 16, 44], ['#160c1d', 0.8, 30, 30]];
    for (let L = 0; L < 3; L++) {
      const [cc, by, spd, amp] = layers[L], off = t * spd, step = 22, i0 = Math.floor(off / step);
      g.fillStyle = cc; g.beginPath(); g.moveTo(0, h);
      for (let i = 0; i <= w / step + 2; i++) { const ii = i0 + i; g.lineTo(ii * step - off, h * by - hash(ii, L, 3) * amp); }
      g.lineTo(w, h); g.closePath(); g.fill();
    }
    g.fillStyle = '#0d0912'; g.fillRect(0, h * 0.86, w, h);
    // drakenbaas (silhouet)
    const dx = w * 0.66, dy = h * 0.42 + Math.sin(t * 1.6) * 6, fl = Math.sin(t * 3.2);
    g.fillStyle = '#0b0710';
    for (const sd of [-1, 1]) { g.beginPath(); g.moveTo(dx, dy - 4); g.lineTo(dx + sd * 40, dy - 30 - fl * 22); g.lineTo(dx + sd * 80, dy - 14 - fl * 30); g.lineTo(dx + sd * 60, dy + 2 - fl * 8); g.lineTo(dx + sd * 36, dy - 2); g.closePath(); g.fill(); }
    g.beginPath(); g.ellipse(dx, dy, 34, 14, -0.1, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(dx - 26, dy - 4); g.quadraticCurveTo(dx - 48, dy - 30, dx - 62, dy - 26); g.lineTo(dx - 76, dy - 20); g.lineTo(dx - 60, dy - 15); g.quadraticCurveTo(dx - 44, dy - 17, dx - 20, dy + 6); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(dx + 30, dy - 2); g.quadraticCurveTo(dx + 64, dy + 12 + Math.sin(t * 2) * 6, dx + 94, dy - 8); g.lineTo(dx + 30, dy + 8); g.closePath(); g.fill();
    g.fillStyle = '#ff3b2f'; g.beginPath(); g.arc(dx - 64, dy - 23, 1.8, 0, 7); g.fill();
    // ridder (silhouet, geen gezicht)
    const kx = w * 0.25, ky = h * 0.86, sw = Math.sin(t * 5) * 0.8;
    g.fillStyle = '#07050a'; g.fillRect(kx - 6, ky - 26, 12, 18); g.fillRect(kx - 6, ky - 8, 4, 8); g.fillRect(kx + 2, ky - 8, 4, 8);
    g.beginPath(); g.arc(kx, ky - 31, 6, 0, 7); g.fill();
    g.beginPath(); g.moveTo(kx - 6, ky - 24); g.lineTo(kx - 16, ky - 10); g.lineTo(kx - 6, ky - 6); g.fill();
    g.save(); g.translate(kx + 6, ky - 20); g.rotate(-0.6 + sw); g.fillRect(0, -1.5, 24, 3); g.restore();
    // spreuk + schadegetal
    const ph = (t % 1.3) / 1.3, bx = lerp(kx + 10, dx - 20, ph), by2 = lerp(ky - 26, dy, ph) - Math.sin(ph * Math.PI) * 30;
    gr = g.createRadialGradient(bx, by2, 0, bx, by2, 12); gr.addColorStop(0, 'rgba(200,240,255,1)'); gr.addColorStop(0.4, 'rgba(110,200,255,.7)'); gr.addColorStop(1, 'rgba(110,200,255,0)');
    g.fillStyle = gr; g.fillRect(bx - 12, by2 - 12, 24, 24);
    const hn = Math.floor(t / 1.3), val = (8000 + hash(hn, 1, 9) * 14000) | 0;
    g.fillStyle = `rgba(255,214,90,${(1 - ph).toFixed(2)})`; g.font = `800 14px ${SYS}`; g.textAlign = 'center';
    g.fillText(val.toLocaleString('nl-NL'), dx - 6 + hash(hn, 2, 9) * 30, dy - 34 - ph * 28);
    // interface
    const hp = 1 - ((t / 80) % 1) * 0.97;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(w * 0.3, 8, w * 0.4, 13); g.fillStyle = '#c0262d'; g.fillRect(w * 0.3 + 1, 9, (w * 0.4 - 2) * hp, 11);
    g.fillStyle = '#fff'; g.font = `700 9px ${SYS}`; g.fillText(`Oude Draak  ${Math.round(hp * 100)}%`, w / 2, 15);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(8, 8, 98, 28);
    g.fillStyle = '#c9b37a'; g.beginPath(); g.moveTo(14, 12); g.lineTo(30, 12); g.lineTo(30, 22); g.lineTo(22, 31); g.lineTo(14, 22); g.closePath(); g.fill();
    g.fillStyle = '#2bbf4a'; g.fillRect(35, 13, 66 * (0.55 + 0.4 * Math.abs(Math.sin(t * 0.3))), 7); g.fillStyle = '#3a7bff'; g.fillRect(35, 23, 50, 5);
    for (let i = 0; i < 6; i++) {
      const sx = w / 2 - 75 + i * 25, sy = h - 28;
      g.fillStyle = '#1d1726'; g.fillRect(sx, sy, 22, 22); g.fillStyle = ['#e0623a', '#4aa3ff', '#9b59d0', '#3ccf7a', '#f2c94c', '#e74c8b'][i]; g.fillRect(sx + 4, sy + 4, 14, 14);
      const cd = (t * 0.5 + i * 0.37) % 1;
      if (cd < 0.5) { g.fillStyle = 'rgba(0,0,0,.65)'; g.beginPath(); g.moveTo(sx + 11, sy + 11); g.arc(sx + 11, sy + 11, 15, -Math.PI / 2, -Math.PI / 2 + (1 - cd * 2) * Math.PI * 2); g.closePath(); g.fill(); }
      g.strokeStyle = '#5d4a7a'; g.lineWidth = 1; g.strokeRect(sx + 0.5, sy + 0.5, 21, 21);
    }
    g.fillStyle = 'rgba(20,14,30,.8)'; g.beginPath(); g.arc(w - 28, 34, 20, 0, 7); g.fill(); g.strokeStyle = '#8a7aa8'; g.stroke();
    g.fillStyle = '#ffd23f'; g.fillRect(w - 30, 32, 4, 4); g.fillStyle = '#ff4040'; g.fillRect(w - 22 + Math.sin(t) * 3, 26, 3, 3);
    g.restore();
  }

  function draw(dt) {
    t += dt; next -= dt; if (next <= 0) { addMsg(); next = 0.6 + rnd() * 1.0; }
    scroll = Math.max(0, scroll - dt * (40 + scroll * 6));
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#0e0e10'; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#18181b'; g.fillRect(0, 0, 640, 26);
    g.fillStyle = '#9146ff'; rr(8, 5, 16, 16, 3); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(13, 9); g.lineTo(20, 13); g.lineTo(13, 17); g.closePath(); g.fill();
    g.fillStyle = '#efeff1'; g.font = `600 11px ${SYS}`; g.fillText('Volgend', 34, 17); g.fillText('Bladeren', 88, 17);
    g.fillStyle = '#2b2b30'; rr(220, 5, 200, 16, 4); g.fill(); g.fillStyle = '#8a8a94'; g.font = `10px ${SYS}`; g.fillText('Zoeken', 228, 16);
    g.fillStyle = '#3a3a42'; g.beginPath(); g.arc(624, 13, 8, 0, 7); g.fill();
    game(8, 32, 456, 256);
    g.fillStyle = '#e91916'; rr(16, 40, 36, 16, 3); g.fill(); g.fillStyle = '#fff'; g.font = `800 10px ${SYS}`; g.fillText('LIVE', 22, 52);
    g.fillStyle = 'rgba(0,0,0,.6)'; rr(56, 40, 92, 16, 3); g.fill(); g.fillStyle = '#e6e6ea'; g.font = `600 9px ${SYS}`; g.fillText('VOORBEELDBEELD', 62, 51);
    // info
    g.fillStyle = '#9146ff'; g.beginPath(); g.arc(28, 316, 18, 0, 7); g.fill();
    g.fillStyle = '#1f1f23'; g.beginPath(); g.arc(28, 316, 16, 0, 7); g.fill();
    g.save(); g.beginPath(); g.arc(28, 316, 16, 0, 7); g.clip(); g.fillStyle = '#5c5c66';
    g.beginPath(); g.arc(28, 311, 5.5, 0, 7); g.fill(); g.beginPath(); g.ellipse(28, 328, 11, 8, 0, 0, 7); g.fill(); g.restore();
    g.fillStyle = '#efeff1'; g.font = `700 13px ${SYS}`; g.fillText('zackrawrr · Twitch', 54, 306);
    g.fillStyle = '#bf94ff'; g.font = `600 10.5px ${SYS}`; g.fillText('Asmongold', 54, 321);
    g.fillStyle = '#adadb8'; g.font = `10.5px ${SYS}`; g.fillText('Live: MMO-raid & reacties — klik voor de echte stream', 54, 336);
    g.fillStyle = '#9146ff'; rr(392, 298, 66, 22, 4); g.fill(); g.fillStyle = '#fff'; g.font = `700 10.5px ${SYS}`; g.fillText('♥ Volgen', 404, 313);
    // chat
    g.fillStyle = '#18181b'; g.fillRect(472, 26, 168, 334);
    g.fillStyle = '#2f2f35'; g.fillRect(472, 26, 1, 334); g.fillRect(472, 50, 168, 1);
    g.fillStyle = '#efeff1'; g.font = `700 9.5px ${SYS}`; g.textAlign = 'center'; g.fillText('STREAMCHAT', 556, 42); g.textAlign = 'left';
    g.save(); g.beginPath(); g.rect(472, 52, 168, 274); g.clip();
    let y = 322 + scroll;
    for (let i = msgs.length - 1; i >= 0 && y > 50; i--) {
      const m = msgs[i], hgt = m.lines.length * 13; let ly = y - hgt + 10;
      g.fillStyle = m.color; g.font = `700 10px ${SYS}`; g.fillText(m.name + ':', 478, ly);
      g.fillStyle = '#dedee3'; g.font = `10px ${SYS}`;
      m.lines.forEach((ln, q) => { g.fillText(ln, q ? 478 : 478 + m.nw, ly); ly += 13; });
      y -= hgt + 3;
    }
    g.restore();
    g.fillStyle = '#2b2b30'; rr(478, 332, 156, 20, 4); g.fill(); g.fillStyle = '#7a7a85'; g.font = `10px ${SYS}`; g.fillText('Verstuur een bericht', 486, 345);
  }
  return { canvas: c, draw };
}

function makeCodeScreen() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  g.fillStyle = '#1e1f26'; g.fillRect(0, 0, 512, 288);
  g.fillStyle = '#16171c'; g.fillRect(0, 0, 92, 288); g.fillRect(0, 0, 512, 18);
  g.fillStyle = '#2a2c36'; g.fillRect(92, 0, 96, 18);
  g.font = '9px ui-monospace, Consolas, monospace'; g.fillStyle = '#c8c8d0'; g.fillText('vliegplan.lua', 100, 12);
  for (let i = 0; i < 14; i++) { g.fillStyle = i === 3 ? '#3b4a6b' : '#16171c'; g.fillRect(4, 26 + i * 15, 84, 12); g.fillStyle = '#8b8d98'; g.fillRect(12 + (i % 3) * 6, 30 + i * 15, 30 + hash(i, 1, 2) * 40, 4); }
  const pal = ['#c678dd', '#61afef', '#98c379', '#e5c07b', '#d19a66', '#abb2bf', '#56b6c2', '#e06c75'];
  for (let l = 0; l < 17; l++) {
    const y = 28 + l * 12; g.fillStyle = '#4b4e5a'; g.fillText(String(l + 1).padStart(2, ' '), 98, y + 4);
    let x = 120 + (hash(l, 3, 4) * 3 | 0) * 12;
    const n = 2 + (hash(l, 5, 4) * 5 | 0);
    for (let q = 0; q < n && x < 420; q++) { const w = 12 + hash(l, q, 6) * 50; g.fillStyle = pal[(hash(l, q, 7) * pal.length) | 0]; g.fillRect(x, y, w, 4); x += w + 6; }
  }
  g.fillStyle = '#121318'; g.fillRect(92, 236, 420, 52); g.fillStyle = '#2bd17e'; g.font = '9px ui-monospace, Consolas, monospace';
  g.fillText('> sim verbonden · EHAM → EHRD · ATIS ok', 100, 252); g.fillText('> autopiloot: HOOGTE 570 FT · KOERS 360', 100, 266);
  g.fillStyle = '#9aa0b0'; g.fillText('_', 100, 280);
  return c;
}

/* =====================================================================================================
 *  GEOMETRIE: per materiaal samengevoegde vertex-color meshes
 * ===================================================================================================== */
function makeBuilder(T) {
  const lists = new Map(), stack = [new T.Matrix4()];
  const m4 = new T.Matrix4(), q = new T.Quaternion(), eu = new T.Euler(), p = new T.Vector3(), one = new T.Vector3(1, 1, 1), c = new T.Color();
  const local = (x, y, z, rx = 0, ry = 0, rz = 0) => m4.compose(p.set(x, y, z), q.setFromEuler(eu.set(rx, ry, rz)), one);
  function add(key, geo, color, x, y, z, rx, ry, rz) {
    const gg = geo.index ? geo.toNonIndexed() : geo.clone(); geo.dispose();
    for (const n of Object.keys(gg.attributes)) if (n !== 'position' && n !== 'normal') gg.deleteAttribute(n);
    gg.applyMatrix4(stack[stack.length - 1].clone().multiply(local(x, y, z, rx, ry, rz)));
    c.set(color); const n = gg.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    gg.setAttribute('color', new T.BufferAttribute(a, 3));
    if (!lists.has(key)) lists.set(key, []); lists.get(key).push(gg);
  }
  return {
    box: (k, cl, w, h, d, x, y, z, rx, ry, rz) => add(k, new T.BoxGeometry(w, h, d), cl, x, y, z, rx, ry, rz),
    cyl: (k, cl, rt, rb, h, seg, x, y, z, rx, ry, rz) => add(k, new T.CylinderGeometry(rt, rb, h, seg), cl, x, y, z, rx, ry, rz),
    geo: (k, cl, geo, x, y, z, rx, ry, rz) => add(k, geo, cl, x, y, z, rx, ry, rz),
    push(x, y, z, rx, ry, rz) { stack.push(stack[stack.length - 1].clone().multiply(local(x, y, z, rx, ry, rz))); },
    pop() { if (stack.length > 1) stack.pop(); },
    build(mats) {
      const group = new T.Group();
      for (const [key, list] of lists) {
        let n = 0; for (const gg of list) n += gg.attributes.position.count;
        const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), cl = new Float32Array(n * 3);
        let o = 0;
        for (const gg of list) { pos.set(gg.attributes.position.array, o * 3); nor.set(gg.attributes.normal.array, o * 3); cl.set(gg.attributes.color.array, o * 3); o += gg.attributes.position.count; gg.dispose(); }
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(nor, 3)); geo.setAttribute('color', new T.BufferAttribute(cl, 3));
        geo.computeBoundingSphere();
        const mesh = new T.Mesh(geo, mats[key]); mesh.name = 'office-' + key;
        mesh.castShadow = key !== 'rgb' && key !== 'glow'; mesh.receiveShadow = key !== 'rgb' && key !== 'glow';
        group.add(mesh);
      }
      return group;
    },
  };
}

function curvedPlane(T, w, h, R, seg) {
  const g = new T.PlaneGeometry(w, h, seg, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const a = p.getX(i) / R; p.setXYZ(i, R * Math.sin(a), p.getY(i), R * (1 - Math.cos(a))); }
  g.computeVertexNormals(); g.computeBoundingSphere(); return g;
}

function buildCorner(T, b) {
  const BLK = '#17171a', BLK2 = '#222327', ALU = '#8f939a', FAB = '#141416', FAB2 = '#1d1d21', ACC = '#c9c9cc';
  /* ---------- flightsim-cockpit (x ≈ 1.12–1.72, z ≈ 4.68–6.08) ---------- */
  const RX = 1.42;
  b.push(RX, 0, 0);
  for (const sx of [-0.30, 0.30]) b.box('metal', BLK2, 0.06, 0.06, 1.26, sx, 0.03, 5.40);
  for (const z of [4.80, 5.38, 6.00]) b.box('metal', BLK2, 0.66, 0.05, 0.06, 0, 0.03, z);
  for (const sx of [-0.30, 0.30]) for (const z of [4.80, 6.00]) b.box('solid', '#0c0c0e', 0.09, 0.012, 0.09, sx, 0.006, z);
  for (const sx of [-0.335, 0.335]) b.box('rgb', '#ffffff', 0.008, 0.012, 1.18, sx, 0.035, 5.40);
  // monitorstandaard + gebogen 34"-behuizing
  b.box('metal', BLK2, 0.07, 1.0, 0.07, 0, 0.56, 4.70);
  b.box('metal', BLK2, 0.40, 0.05, 0.36, 0, 0.03, 4.70);
  b.box('solid', BLK, 0.30, 0.20, 0.06, 0, 1.10, 4.735);
  const R = 1.8, SW = 0.80, SH = 0.343, NS = 8;
  for (let k = 0; k < NS; k++) {
    const a = ((k + 0.5) / NS - 0.5) * (SW + 0.03) / R, x = R * Math.sin(a), z = 4.80 + R * (1 - Math.cos(a));
    b.box('solid', BLK, (SW + 0.03) / NS + 0.004, SH + 0.03, 0.03, x + Math.sin(a) * 0.018, 1.10, z - Math.cos(a) * 0.018, 0, -a, 0);
  }
  b.box('glow', '#ff3355', 0.03, 0.004, 0.004, 0.36, 0.935, 4.81 + 0.035);
  // pedalen
  b.box('solid', BLK, 0.46, 0.025, 0.28, 0, 0.12, 5.05, 0.5, 0, 0);
  b.box('solid', BLK2, 0.12, 0.08, 0.20, 0, 0.13, 5.06);
  for (const sx of [-0.13, 0.13]) { b.box('metal', ALU, 0.09, 0.22, 0.02, sx, 0.22, 5.05, -0.35, 0, 0); b.box('solid', BLK, 0.02, 0.10, 0.03, sx, 0.16, 5.09, -0.35, 0, 0); }
  // stuurdeck + yoke
  for (const sx of [-0.27, 0.27]) b.box('metal', BLK2, 0.05, 0.64, 0.05, sx, 0.38, 5.09);
  b.box('metal', BLK2, 0.66, 0.025, 0.30, 0, 0.71, 5.09);
  b.box('solid', '#202024', 0.26, 0.10, 0.20, 0, 0.775, 5.06);
  b.cyl('metal', ALU, 0.018, 0.018, 0.22, 10, 0, 0.79, 5.27, Math.PI / 2, 0, 0);
  b.box('solid', BLK, 0.10, 0.06, 0.04, 0, 0.80, 5.39);
  b.box('solid', BLK, 0.30, 0.03, 0.03, 0, 0.80, 5.40);
  for (const sx of [-1, 1]) {
    b.box('fabric', '#101012', 0.04, 0.13, 0.045, sx * 0.15, 0.84, 5.40, 0, 0, -sx * 0.15);
    b.box('glow', '#ff2a2a', 0.012, 0.006, 0.012, sx * 0.158, 0.908, 5.40);
  }
  b.box('glow', '#33ccff', 0.05, 0.004, 0.012, 0, 0.827, 5.39);
  // gashendels (rechts) en schakelpaneel (links)
  b.box('solid', '#202024', 0.12, 0.07, 0.16, 0.22, 0.758, 5.08);
  [['#111111', -0.035], ['#2f6bff', 0], ['#d0202a', 0.035]].forEach(([kc, dx], i) => {
    b.box('metal', ALU, 0.012, 0.11, 0.012, 0.22 + dx, 0.83, 5.08 - i * 0.012, -0.3, 0, 0);
    b.box('solid', kc, 0.026, 0.024, 0.034, 0.22 + dx, 0.885, 5.06 - i * 0.012);
  });
  b.box('solid', '#202024', 0.14, 0.04, 0.16, -0.22, 0.745, 5.08);
  for (let i = 0; i < 6; i++) b.box('glow', i % 3 === 1 ? '#3dff7a' : '#ffb020', 0.012, 0.008, 0.012, -0.265 + (i % 3) * 0.045, 0.769, 5.04 + (i / 3 | 0) * 0.06);
  // kuipstoel
  b.box('metal', BLK2, 0.44, 0.10, 0.50, 0, 0.12, 5.70);
  b.push(0, 0.26, 5.70);
  b.box('fabric', FAB, 0.48, 0.08, 0.48, 0, 0, 0, 0.1, 0, 0);
  for (const sx of [-1, 1]) { b.box('fabric', FAB2, 0.07, 0.10, 0.46, sx * 0.24, 0.05, 0); b.box('solid', '#9a9ca3', 0.012, 0.102, 0.40, sx * 0.205, 0.05, 0); }
  b.push(0, 0.12, 0.22, 0.2, 0, 0);
  b.box('fabric', FAB, 0.50, 0.80, 0.09, 0, 0.40, 0);
  for (const sx of [-1, 1]) { b.box('fabric', FAB2, 0.08, 0.55, 0.14, sx * 0.25, 0.33, -0.03); b.box('solid', '#060607', 0.05, 0.10, 0.092, sx * 0.12, 0.66, 0); }
  b.box('solid', '#d8d8d8', 0.20, 0.03, 0.092, 0, 0.55, 0);
  b.pop(); b.pop();
  b.pop();

  /* ---------- bureau (x 1.90–2.995, z 4.62–5.32) ---------- */
  b.box('solid', '#d9d9d5', 1.095, 0.025, 0.70, 2.4475, 0.7375, 4.97);
  for (const x of [1.96, 2.94]) {
    b.box('metal', '#151518', 0.05, 0.70, 0.05, x, 0.375, 4.97);
    b.box('metal', '#151518', 0.06, 0.03, 0.62, x, 0.015, 4.97);
    b.box('metal', '#151518', 0.05, 0.03, 0.62, x, 0.71, 4.97);
  }
  b.box('metal', '#151518', 0.98, 0.04, 0.02, 2.45, 0.60, 4.70);
  b.box('rgb', '#ffffff', 1.0, 0.008, 0.012, 2.45, 0.72, 5.31);
  b.box('rgb', '#ffffff', 1.0, 0.008, 0.012, 2.45, 0.72, 4.635);
  b.box('fabric', '#202024', 0.80, 0.004, 0.32, 2.45, 0.752, 5.12);
  b.box('solid', '#1a1a1d', 0.44, 0.022, 0.14, 2.40, 0.765, 5.11);
  b.box('rgb', '#ffffff', 0.446, 0.006, 0.146, 2.40, 0.757, 5.11);
  for (let r = 0; r < 4; r++) b.box('rgb', '#6a6a6a', 0.40, 0.003, 0.018, 2.40, 0.777, 5.06 + r * 0.032);
  b.box('solid', '#1a1a1d', 0.06, 0.03, 0.10, 2.74, 0.768, 5.11);
  b.box('rgb', '#ffffff', 0.004, 0.004, 0.06, 2.74, 0.785, 5.10);
  b.cyl('solid', '#efefef', 0.04, 0.036, 0.095, 12, 2.92, 0.80, 4.98);
  b.cyl('solid', '#2b1a10', 0.035, 0.035, 0.002, 12, 2.92, 0.847, 4.98);
  // monitor 1 (27", stream)
  b.push(2.63, 1.09, 4.80, 0, -0.187, 0);
  b.box('solid', '#111114', 0.62, 0.358, 0.025, 0, 0, -0.014);
  b.box('solid', '#18181b', 0.36, 0.22, 0.05, 0, -0.01, -0.05);
  b.box('metal', '#1d1d20', 0.04, 0.26, 0.03, 0, -0.21, -0.075);
  b.box('metal', '#1d1d20', 0.22, 0.012, 0.16, 0, -0.334, -0.06);
  b.box('solid', '#0b0b0d', 0.09, 0.03, 0.035, 0, 0.195, -0.008);
  b.box('glow', '#3050ff', 0.012, 0.012, 0.002, 0, 0.195, 0.011);
  b.pop();
  // monitor 2 (24")
  b.push(2.10, 1.065, 4.84, 0, 0.386, 0);
  b.box('solid', '#111114', 0.55, 0.318, 0.022, 0, 0, -0.013);
  b.box('solid', '#18181b', 0.32, 0.20, 0.045, 0, -0.01, -0.045);
  b.box('metal', '#1d1d20', 0.04, 0.24, 0.03, 0, -0.19, -0.07);
  b.box('metal', '#1d1d20', 0.20, 0.012, 0.15, 0, -0.309, -0.06);
  b.pop();
  // pc-tower (glazen zijkant naar de kamer)
  b.box('solid', '#121215', 0.22, 0.48, 0.48, 2.81, 0.25, 4.93);
  b.box('solid', '#1b2230', 0.004, 0.44, 0.44, 2.698, 0.255, 4.93);
  for (const y of [0.37, 0.20]) b.geo('rgb', '#ffffff', new T.TorusGeometry(0.055, 0.008, 6, 18), 2.81, y, 4.688);
  b.box('rgb', '#ffffff', 0.004, 0.44, 0.008, 2.697, 0.255, 4.714);
  b.box('rgb', '#ffffff', 0.004, 0.44, 0.008, 2.697, 0.255, 5.146);
  b.box('rgb', '#8a8a8a', 0.003, 0.03, 0.26, 2.699, 0.23, 4.95);
  b.box('glow', '#66ffcc', 0.003, 0.012, 0.012, 2.699, 0.42, 5.08);

  /* ---------- gamestoel ---------- */
  b.push(2.42, 0, 5.74, 0, 0.12, 0);
  for (let k = 0; k < 5; k++) {
    const a = k * Math.PI * 2 / 5;
    b.box('metal', '#1a1a1d', 0.045, 0.035, 0.30, Math.sin(a) * 0.15, 0.085, Math.cos(a) * 0.15, 0, a, 0);
    b.cyl('solid', '#0e0e10', 0.028, 0.028, 0.03, 8, Math.sin(a) * 0.29, 0.03, Math.cos(a) * 0.29, 0, a, Math.PI / 2);
  }
  b.cyl('metal', '#1a1a1d', 0.05, 0.05, 0.06, 10, 0, 0.10, 0);
  b.cyl('metal', '#2a2a2e', 0.025, 0.03, 0.30, 10, 0, 0.27, 0);
  b.push(0, 0.49, 0);
  b.box('fabric', FAB, 0.52, 0.10, 0.50, 0, 0, 0);
  for (const sx of [-1, 1]) { b.box('fabric', FAB2, 0.07, 0.07, 0.46, sx * 0.25, 0.06, 0); b.box('solid', ACC, 0.012, 0.072, 0.42, sx * 0.215, 0.06, 0); }
  b.pop();
  for (const sx of [-1, 1]) { b.box('metal', '#1a1a1d', 0.04, 0.20, 0.05, sx * 0.29, 0.60, 0.05); b.box('solid', '#111113', 0.08, 0.03, 0.24, sx * 0.29, 0.71, 0.0); }
  b.push(0, 0.54, 0.24, 0.14, 0, 0);
  b.box('fabric', FAB, 0.50, 0.84, 0.10, 0, 0.42, 0);
  for (const sx of [-1, 1]) {
    b.box('fabric', FAB2, 0.08, 0.60, 0.14, sx * 0.25, 0.36, -0.02);
    b.box('solid', ACC, 0.012, 0.56, 0.142, sx * 0.212, 0.36, -0.02);
    b.box('solid', '#060607', 0.05, 0.11, 0.102, sx * 0.12, 0.70, 0);
  }
  b.box('fabric', '#26262a', 0.26, 0.12, 0.06, 0, 0.66, -0.07);
  b.box('fabric', '#26262a', 0.30, 0.14, 0.05, 0, 0.22, -0.065);
  b.pop(); b.pop();
}

function haloTexture(T) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,.42)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
}

/* =====================================================================================================
 *  INSTALL
 * ===================================================================================================== */
const CSS = `
#officeTag{position:fixed;left:50%;top:50%;z-index:5;transform:translate(-50%,22px);background:var(--ink,#141414);color:var(--bg,#fff);font:500 12px/1 var(--font-body,system-ui,sans-serif);padding:5px 9px;border-radius:999px;pointer-events:none;white-space:nowrap}
#officeWatch{position:fixed;left:50%;bottom:92px;z-index:6;transform:translateX(-50%);border:0;border-radius:999px;padding:9px 16px;font:600 13px/1 var(--font-body,system-ui,sans-serif);background:#9146ff;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer}
#officeWatch:focus-visible,#officeLink button:focus-visible,#officeLink a:focus-visible,#officeFly button:focus-visible{outline:2px solid #fff;outline-offset:2px}
#officeLink{position:fixed;left:50%;bottom:140px;z-index:2147482000;transform:translateX(-50%);width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:#18181b;color:#efeff1;border:1px solid #3a2f55;border-radius:14px;padding:14px 16px;font:400 13px/1.45 var(--font-body,system-ui,sans-serif);box-shadow:0 12px 40px rgba(0,0,0,.45)}
#officeLink .t{margin:0 0 6px;font-weight:600}
#officeLink .u{display:block;user-select:all;-webkit-user-select:all;background:#0e0e10;border:1px solid #2f2f35;border-radius:8px;padding:6px 8px;font:500 12px/1.3 var(--font-mono,ui-monospace,Consolas,monospace);word-break:break-all;cursor:text}
#officeLink .r{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
#officeLink a,#officeLink button{border:0;border-radius:999px;padding:7px 13px;font:600 12px/1 inherit;cursor:pointer;text-decoration:none}
#officeLink a{background:#9146ff;color:#fff}#officeLink button{background:#2f2f35;color:#efeff1}
#officeToast{position:fixed;left:50%;bottom:90px;z-index:2147482001;transform:translateX(-50%);max-width:calc(100vw - 32px);background:var(--ink,#141414);color:var(--bg,#fff);padding:8px 14px;border-radius:999px;font:500 13px/1.3 var(--font-body,system-ui,sans-serif);user-select:text;-webkit-user-select:text}
#officeFly{position:fixed;inset:0;z-index:2147483000;background:#000;touch-action:none;user-select:none;-webkit-user-select:none}
#officeFly canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
#officeFly .top{position:absolute;left:12px;right:12px;top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;pointer-events:none}
#officeFly .ttl{font:600 13px/1 var(--font-body,system-ui,sans-serif);color:#eafff0;background:rgba(0,0,0,.35);padding:7px 11px;border-radius:999px}
#officeFly button{pointer-events:auto;border:0;border-radius:999px;padding:8px 13px;font:600 13px/1 var(--font-body,system-ui,sans-serif);background:rgba(255,255,255,.92);color:#111;cursor:pointer}
#officeFly kbd{font:600 11px/1 var(--font-mono,ui-monospace,monospace);background:#e4e4e4;border-radius:4px;padding:2px 4px;margin-left:6px}
#officeFly .help{position:absolute;left:50%;top:56px;transform:translateX(-50%);max-width:calc(100vw - 32px);text-align:center;font:500 12px/1.4 var(--font-body,system-ui,sans-serif);color:#eafff0;background:rgba(0,0,0,.35);padding:6px 12px;border-radius:12px;pointer-events:none}
#officeFly .tch{position:absolute;right:12px;bottom:56px;display:flex;flex-direction:column;gap:8px}
@media (pointer:fine){#officeFly .tch{display:none}}
@media (max-width:560px){#officeFly .help{font-size:11px}}
`;

export function install(H) {
  if (!H) return null;
  if (H.office && H.office.installed) return H.office;
  const T = H.THREE;
  if (!T || !H.scene || !H.camera || !H.renderer) { console.warn('[office] HOUSE mist THREE/scene/camera/renderer — niet geïnstalleerd'); return null; }
  const camera = H.camera, renderer = H.renderer, canvas = renderer.domElement;

  /* ---- shims ---- */
  let onTick = typeof H.onTick === 'function' ? fn => H.onTick(fn) : null;
  if (!onTick) {
    const fns = new Set(); let last = performance.now();
    const loop = now => { const dt = Math.min(0.05, (now - last) / 1000); last = now; for (const fn of fns) { try { fn(dt); } catch (e) { console.warn('[office]', e); } } requestAnimationFrame(loop); };
    requestAnimationFrame(loop); onTick = fn => { fns.add(fn); return () => fns.delete(fn); };
  }
  const addToRoom = obj => { if (typeof H.addToRoom === 'function') { try { return H.addToRoom(ROOM_ID, obj); } catch (e) { /* val terug */ } } H.scene.add(obj); return obj; };
  const getMode = () => { try { const m = H.mode; return typeof m === 'string' ? m : 'walk'; } catch (e) { return 'walk'; } };
  const roomRects = (H.rooms || []).find(r => r.id === ROOM_ID)?.rects || [{ x0: 0, x1: 3.62, z0: 0, z1: 3.8 }, { x0: 0, x1: 3.0, z0: 3.8, z1: 7.73 }];
  const inRoom = pos => {
    if (pos.y < -0.2 || pos.y > 2.6) return false;
    if (typeof H.roomAt === 'function') { try { return H.roomAt(0, pos.x, pos.z) === ROOM_ID; } catch (e) { /* rects */ } }
    return roomRects.some(r => pos.x >= r.x0 && pos.x <= r.x1 && pos.z >= r.z0 && pos.z <= r.z1);
  };
  const shown = o => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  const toast = msg => {
    if (H.ui && typeof H.ui.toast === 'function') { try { H.ui.toast(msg); return; } catch (e) { /* eigen toast */ } }
    let el = document.getElementById('officeToast');
    if (!el) { el = document.createElement('div'); el.id = 'officeToast'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 6000);
  };

  if (!document.getElementById('office-style')) { const st = document.createElement('style'); st.id = 'office-style'; st.textContent = CSS; document.head.append(st); }

  /* ---- 3D-hoek ---- */
  const mats = {
    solid: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
    fabric: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    metal: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 }),
    glow: new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    rgb: new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
  const b = makeBuilder(T); buildCorner(T, b);
  const group = b.build(mats); group.name = 'office-corner';

  // schermen
  const sim = makeSimRenderer(), flight = newFlight();
  const simCanvas = document.createElement('canvas'); simCanvas.width = 560; simCanvas.height = 240;
  const simCtx = simCanvas.getContext('2d');
  const simTex = new T.CanvasTexture(simCanvas); simTex.colorSpace = T.SRGBColorSpace; simTex.anisotropy = 4;
  const simScreen = new T.Mesh(curvedPlane(T, 0.80, 0.343, 1.8, 16), new T.MeshBasicMaterial({ map: simTex, toneMapped: false }));
  simScreen.position.set(1.42, 1.10, 4.80); simScreen.name = 'office-sim-screen'; group.add(simScreen);

  const stream = makeStreamFallback();
  const streamTex = new T.CanvasTexture(stream.canvas); streamTex.colorSpace = T.SRGBColorSpace; streamTex.anisotropy = 4;
  const streamMat = new T.MeshBasicMaterial({ map: streamTex, toneMapped: false });
  const holeMat = new T.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: T.NoBlending, toneMapped: false });
  const streamScreen = new T.Mesh(new T.PlaneGeometry(0.598, 0.336), streamMat);
  streamScreen.position.set(2.63, 1.09, 4.80); streamScreen.rotation.y = -0.187; streamScreen.name = 'office-stream-screen'; group.add(streamScreen);

  const codeTex = new T.CanvasTexture(makeCodeScreen()); codeTex.colorSpace = T.SRGBColorSpace;
  const codeScreen = new T.Mesh(new T.PlaneGeometry(0.531, 0.299), new T.MeshBasicMaterial({ map: codeTex, toneMapped: false }));
  codeScreen.position.set(2.10, 1.065, 4.84); codeScreen.rotation.y = 0.386; codeScreen.name = 'office-code-screen'; group.add(codeScreen);

  // RGB-gloed
  const haloMat = new T.MeshBasicMaterial({ map: haloTexture(T), color: 0xb040ff, transparent: true, opacity: 0.32, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [w, h, x, y, z, rx, ry] of [[1.35, 1.0, 2.45, 0.004, 4.97, -Math.PI / 2, 0], [0.95, 1.5, 1.42, 0.004, 5.40, -Math.PI / 2, 0], [1.3, 0.9, 2.996, 0.55, 4.97, 0, -Math.PI / 2]]) {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), haloMat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); m.renderOrder = 2; m.name = 'office-glow'; group.add(m);
  }
  addToRoom(group);
  group.updateMatrixWorld(true);

  /* ---- DOM ---- */
  const tag = document.createElement('div'); tag.id = 'officeTag'; tag.hidden = true; document.body.append(tag);
  const watchBtn = document.createElement('button'); watchBtn.id = 'officeWatch'; watchBtn.type = 'button'; watchBtn.hidden = true; watchBtn.textContent = 'Bekijk stream'; watchBtn.setAttribute('aria-pressed', 'false');
  document.body.append(watchBtn);
  let linkCard = null;
  function showLink() {
    if (document.pointerLockElement) document.exitPointerLock();
    toast('Asmongold live: ' + TWITCH_PAGE);
    if (!linkCard) {
      linkCard = document.createElement('div'); linkCard.id = 'officeLink'; linkCard.setAttribute('role', 'dialog'); linkCard.setAttribute('aria-label', 'Link naar de stream');
      linkCard.innerHTML = `<p class="t">Asmongold streamt op Twitch als <b>${CHANNEL}</b></p><span class="u" tabindex="0">${TWITCH_PAGE}</span>` +
        `<div class="r"><button type="button">Sluiten</button><a href="${TWITCH_PAGE}" target="_blank" rel="noopener noreferrer">Open op Twitch ↗</a></div>`;
      linkCard.querySelector('button').addEventListener('click', () => { linkCard.hidden = true; });
      linkCard.addEventListener('keydown', e => { if (e.key === 'Escape') linkCard.hidden = true; });
      document.body.append(linkCard);
    }
    linkCard.hidden = false; linkCard.querySelector('a').focus({ preventScroll: true });
  }

  /* ---- Twitch (CSS3D hole punch) ---- */
  const TWITCH = ENV.stream === 'twitch';
  let css = null, cssLoading = false, twitchFailed = false, twitchShown = false, wantSince = 0, hiddenSince = 0, watch = false;
  async function ensureCss() {
    if (css || cssLoading || twitchFailed) return; cssLoading = true;
    try {
      const { CSS3DRenderer, CSS3DObject } = await import('three/addons/renderers/CSS3DRenderer.js');
      const r = new CSS3DRenderer(), layer = r.domElement; layer.classList.add('office-css3d');
      const behind = !!(renderer.getContext().getContextAttributes() || {}).alpha;
      Object.assign(layer.style, { position: 'absolute', left: '0px', top: '0px', pointerEvents: 'none', zIndex: behind ? '0' : '2' });
      const parent = canvas.parentElement || document.body; parent.insertBefore(layer, canvas);
      if (behind) { if (getComputedStyle(canvas).position === 'static') canvas.style.position = 'relative'; canvas.style.zIndex = '1'; }
      const iframe = document.createElement('iframe');
      iframe.src = `https://player.twitch.tv/?channel=${CHANNEL}&parent=${encodeURIComponent(location.hostname)}&muted=true&autoplay=true`;
      iframe.title = `Twitch-stream van ${CHANNEL} (Asmongold)`;
      iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      Object.assign(iframe.style, { width: '1280px', height: '720px', border: '0', background: '#000' });
      const obj = new CSS3DObject(iframe); iframe.style.pointerEvents = 'none'; obj.matrixAutoUpdate = false;
      const scene = new T.Scene(); scene.add(obj);
      css = { r, layer, iframe, obj, scene, behind, w: 0, h: 0 };
    } catch (e) { twitchFailed = true; console.warn('[office] Twitch-speler niet beschikbaar, voorbeeldbeeld blijft staan:', e); }
    cssLoading = false;
  }
  function unmountCss() { if (!css) return; css.iframe.src = 'about:blank'; css.layer.remove(); css = null; }
  function placeCss() {
    streamScreen.updateWorldMatrix(true, false);
    const k = 0.598 / 1280; css.obj.matrix.copy(streamScreen.matrixWorld).multiply(new T.Matrix4().makeScale(k, k, k));
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w !== css.w || h !== css.h) { css.w = w; css.h = h; css.r.setSize(w, h); css.layer.style.left = canvas.offsetLeft + 'px'; css.layer.style.top = canvas.offsetTop + 'px'; }
  }
  function setTwitchShown(on) {
    if (twitchShown === on) return; twitchShown = on;
    streamScreen.material = on ? holeMat : streamMat;
    if (css) { css.obj.visible = on; css.r.render(css.scene, camera); }
    watchBtn.hidden = !on;
    if (!on) setWatch(false);
  }
  function setWatch(on) {
    on = !!on && twitchShown; if (watch === on) return; watch = on;
    if (on && document.pointerLockElement) document.exitPointerLock();
    if (css) { css.iframe.style.pointerEvents = on ? 'auto' : 'none'; css.layer.style.zIndex = on || !css.behind ? '2' : '0'; } // kijkmodus: speler bovenop (klikbaar, niet afgedekt)
    canvas.style.pointerEvents = on ? 'none' : '';
    watchBtn.textContent = on ? 'Terug naar lopen' : 'Bekijk stream'; watchBtn.setAttribute('aria-pressed', String(on));
  }
  watchBtn.addEventListener('click', () => setWatch(!watch));
  document.addEventListener('pointerlockchange', () => {
    if (watch || flying) setTimeout(() => { const ws = document.getElementById('walkStart'); if (ws && (watch || flying)) ws.hidden = true; }, 0);
  });

  /* ---- vliegen (volledig scherm) ---- */
  let flying = false, flyUi = null, savedLayers = 0;
  const flyKeys = {}, stick = { x: 0, y: 0, id: null, x0: 0, y0: 0 };
  let thrHold = 0;
  function buildFlyUi() {
    const el = document.createElement('div'); el.id = 'officeFly'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Vliegen boven de polder');
    el.innerHTML = `<canvas aria-hidden="true"></canvas><div class="top"><span class="ttl">Vliegen · boven de polder</span><button type="button" class="exit">Terug naar lopen<kbd>Esc</kbd></button></div>` +
      `<div class="tch"><button type="button" data-thr="1">Gas +</button><button type="button" data-thr="-1">Gas −</button><button type="button" class="ap">Autopiloot</button></div>` +
      `<div class="help">${ENV.coarse ? 'Sleep om te sturen · Gas +/− rechts' : 'W/S of ↑/↓ klimmen/dalen · A/D of ←/→ bocht · R/F gas · P autopiloot · slepen = sturen'}</div>`;
    document.body.append(el);
    const cv = el.querySelector('canvas'), ctx = cv.getContext('2d');
    el.querySelector('.exit').addEventListener('click', exitFly);
    el.querySelector('.ap').addEventListener('click', () => { flight.ap = !flight.ap; });
    for (const bt of el.querySelectorAll('[data-thr]')) {
      const v = +bt.dataset.thr;
      bt.addEventListener('pointerdown', e => { thrHold = v; flight.ap = false; e.stopPropagation(); });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) bt.addEventListener(ev, () => { thrHold = 0; });
    }
    cv.addEventListener('pointerdown', e => { stick.id = e.pointerId; stick.x0 = e.clientX; stick.y0 = e.clientY; stick.x = stick.y = 0; try { cv.setPointerCapture(e.pointerId); } catch (er) { /* ok */ } });
    cv.addEventListener('pointermove', e => { if (e.pointerId !== stick.id) return; const R = Math.min(innerWidth, innerHeight) * 0.18; stick.x = clamp((e.clientX - stick.x0) / R, -1, 1); stick.y = clamp((e.clientY - stick.y0) / R, -1, 1); if (Math.abs(stick.x) + Math.abs(stick.y) > 0.05) flight.ap = false; });
    const end = e => { if (e.pointerId === stick.id) { stick.id = null; stick.x = stick.y = 0; } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    const resize = () => { const w = Math.min(innerWidth, 1600), sc = w / innerWidth, h = Math.min(Math.round(innerHeight * sc), 1000); cv.width = Math.round(w); cv.height = h; };
    addEventListener('resize', () => { if (flying) resize(); });
    return { el, cv, ctx, resize };
  }
  function releaseHostKeys() {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']) {
      try { window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code })); } catch (e) { /* ok */ }
    }
  }
  function enterFly() {
    if (flying) return;
    if (!flyUi) flyUi = buildFlyUi();
    flying = true; setWatch(false); tag.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
    releaseHostKeys();
    savedLayers = camera.layers.mask; camera.layers.set(30);      // hoofdrender tekent niets zolang het overlay alles bedekt
    Object.assign(flight, newFlight(), { t: flight.t, ap: true });
    for (const k in flyKeys) flyKeys[k] = false;
    flyUi.resize(); flyUi.el.hidden = false; flyUi.el.querySelector('.exit').focus({ preventScroll: true });
  }
  function exitFly() {
    if (!flying) return; flying = false;
    camera.layers.mask = savedLayers || 1;
    flyUi.el.hidden = true; stick.id = null; stick.x = stick.y = 0; thrHold = 0;
    Object.assign(flight, newFlight(), { t: flight.t, ap: true });
    lastSim = -1;
  }

  /* ---- richten / klikken ---- */
  const ray = new T.Raycaster(), ndc = new T.Vector2(), targets = [simScreen, streamScreen];
  let aim = null;
  const which = o => (o === simScreen ? 'sim' : o === streamScreen ? 'stream' : null);
  function pickCenter(far) { ndc.set(0, 0); ray.setFromCamera(ndc, camera); ray.far = far; const h = ray.intersectObjects(targets, false).find(x => shown(x.object)); return h ? which(h.object) : null; }
  function pickAt(cx, cy, far) {
    const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera); ray.far = far; const h = ray.intersectObjects(targets, false).find(x => shown(x.object)); return h ? which(h.object) : null;
  }
  function activate(w) {
    if (w === 'sim') enterFly();
    else if (w === 'stream') { if (twitchShown) setWatch(!watch); else showLink(); }
  }
  const typing = () => { const a = document.activeElement; return !!a && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'range' && a.type !== 'checkbox'; };
  const FLYCODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'KeyF', 'KeyQ', 'KeyZ'];
  addEventListener('keydown', e => {
    if (flying) {
      e.stopImmediatePropagation();
      if (e.code === 'Escape') { exitFly(); return; }
      if (e.code === 'KeyP') { flight.ap = !flight.ap; return; }
      if (FLYCODES.includes(e.code)) { flyKeys[e.code] = true; flight.ap = false; if (e.code.startsWith('Arrow')) e.preventDefault(); }
      return;
    }
    if (watch && e.code === 'Escape') { setWatch(false); return; }
    if (e.code === 'KeyE' && aim && getMode() === 'walk' && !typing() && !e.repeat) { e.stopImmediatePropagation(); activate(aim); }
  }, true);
  addEventListener('keyup', e => { if (flyKeys[e.code]) flyKeys[e.code] = false; }, true);
  addEventListener('blur', () => { for (const k in flyKeys) flyKeys[k] = false; });

  let tap = null, passSynthetic = false;
  addEventListener('pointerdown', e => {
    if (flying || e.target !== canvas || getMode() !== 'walk' || (e.button !== undefined && e.button !== 0)) { tap = null; return; }
    const locked = document.pointerLockElement === canvas;
    const w = locked ? pickCenter(4) : pickAt(e.clientX, e.clientY, 4);
    tap = w ? { w, x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
  }, true);
  addEventListener('pointerup', e => {
    if (passSynthetic || !tap || e.pointerId !== tap.id) return;
    const tp = tap; tap = null;
    if (Math.hypot(e.clientX - tp.x, e.clientY - tp.y) > 8 || performance.now() - tp.t > 450) return;
    e.stopImmediatePropagation(); e.preventDefault();
    passSynthetic = true;                                            // laat de host zijn 'down'-status opruimen zonder actie
    try { canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: e.pointerId, clientX: e.clientX + 10000, clientY: e.clientY, bubbles: true })); } catch (er) { /* ok */ }
    passSynthetic = false;
    activate(tp.w);
  }, true);

  /* ---- zichtbaarheid / prestaties ---- */
  const frustum = new T.Frustum(), pm = new T.Matrix4(), sph = new T.Sphere(), wp = new T.Vector3(), nrm = new T.Vector3(), wq = new T.Quaternion(), tmp = new T.Vector3();
  function viewOf(mesh) {
    if (!shown(mesh)) return null;
    mesh.getWorldPosition(wp); const d = wp.distanceTo(camera.position);
    nrm.set(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(wq));
    if (nrm.dot(tmp.subVectors(camera.position, wp)) <= 0) return null;
    camera.updateMatrixWorld(); pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    sph.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    return frustum.intersectsSphere(sph) ? d : null;
  }
  let fpsAvg = 60, warm = 0, simFrozen = false, lastSim = -1, lastStream = -1, clock = 0, hue = 0;
  const inp = { roll: 0, pitch: 0, thr: 0 };
  const drawSimTo = (ctx, w, h, opt) => { try { sim.draw(ctx, w, h, flight, opt); } catch (e) { console.warn('[office] sim', e); } };
  drawSimTo(simCtx, 560, 240); simTex.needsUpdate = true;
  stream.draw(0.016); streamTex.needsUpdate = true;
  let simAcc = 0, streamAcc = 0;

  onTick(dt => {
    dt = Math.min(dt || 0.016, 0.1); clock += dt;
    fpsAvg = lerp(fpsAvg, 1 / Math.max(dt, 1e-3), 0.05); warm += dt;
    if (ENV.phone && warm > 5 && fpsAvg < 40 && !simFrozen) simFrozen = true;
    // RGB-kleurcyclus (paars ↔ roze ↔ blauw)
    hue = 0.83 + 0.17 * Math.sin(clock * 0.35);
    mats.rgb.color.setHSL(((hue % 1) + 1) % 1, 1, 0.55); haloMat.color.setHSL(((hue % 1) + 1) % 1, 1, 0.5);
    const mode = getMode();

    if (flying) {
      inp.roll = clamp((flyKeys.KeyD || flyKeys.ArrowRight ? 1 : 0) - (flyKeys.KeyA || flyKeys.ArrowLeft ? 1 : 0) + stick.x, -1, 1);
      inp.pitch = clamp((flyKeys.KeyW || flyKeys.ArrowUp ? 1 : 0) - (flyKeys.KeyS || flyKeys.ArrowDown ? 1 : 0) - stick.y, -1, 1);
      inp.thr = (flyKeys.KeyR ? 1 : 0) - (flyKeys.KeyF ? 1 : 0) + thrHold;
      let left = dt; while (left > 1e-4) { const h = Math.min(left, 1 / 30); stepFlight(flight, h, inp); left -= h; }
      const { cv, ctx } = flyUi; drawSimTo(ctx, cv.width, cv.height, { vfov: 50, hudScale: clamp(Math.min(cv.width / 900, cv.height / 520), 1, 2.4) });
      return;
    }

    // simulatie loopt altijd door (goedkoop); tekenen alleen als het scherm in beeld is
    simAcc += dt;
    const dSim = viewOf(simScreen);
    if (!simFrozen && dSim !== null && dSim < 30) {
      const rate = mode === 'walk' && dSim < 4.5 && fpsAvg > 45 ? 24 : mode === 'walk' && dSim < 9 ? 12 : 6;
      if (clock - lastSim >= 1 / rate || lastSim < 0) {
        let left = Math.min(simAcc, 0.5); while (left > 1e-4) { const h = Math.min(left, 1 / 20); stepFlight(flight, h, inp); left -= h; }
        simAcc = 0; lastSim = clock; drawSimTo(simCtx, 560, 240); simTex.needsUpdate = true;
      }
    } else simAcc = Math.min(simAcc, 0.5);

    // stream: Twitch-embed of voorbeeldbeeld
    const dStr = viewOf(streamScreen);
    let want = false;
    if (TWITCH && !twitchFailed && mode === 'walk' && dStr !== null && dStr < 5 && inRoom(camera.position)) want = true;
    if (want) {
      if (!css) ensureCss();
      if (!wantSince) wantSince = clock; hiddenSince = 0;
      if (css && clock - wantSince > 0.15) setTwitchShown(true);
    } else { wantSince = 0; setTwitchShown(false); if (!hiddenSince) hiddenSince = clock; if (css && clock - hiddenSince > 45) unmountCss(); }
    if (twitchShown && css) { placeCss(); css.r.render(css.scene, camera); }
    streamAcc += dt;
    if (!twitchShown && dStr !== null && dStr < 14) {
      const rate = simFrozen ? 4 : dStr < 6 ? 12 : 6;
      if (clock - lastStream >= 1 / rate) { stream.draw(Math.min(streamAcc, 0.5)); streamAcc = 0; lastStream = clock; streamTex.needsUpdate = true; }
    } else streamAcc = Math.min(streamAcc, 0.5);

    // richten (hint onder het vizier)
    aim = null;
    if (mode === 'walk' && (document.pointerLockElement === canvas || !ENV.coarse) && !watch) aim = pickCenter(3.2);
    if (aim) {
      const k = ENV.coarse ? 'Tik' : 'E / klik';
      tag.textContent = aim === 'sim' ? `${k}: vliegen` : twitchShown ? `${k}: bekijk stream` : `${k}: stream-link`;
      tag.hidden = false;
    } else tag.hidden = true;
  });

  const api = {
    installed: true, channel: CHANNEL, url: TWITCH_PAGE, streamMode: ENV.stream, group, flight,
    screens: { sim: simScreen, stream: streamScreen, code: codeScreen },
    enterFly, exitFly, setWatch, showLink,
    get flying() { return flying; }, get twitchShown() { return twitchShown; }, get simFrozen() { return simFrozen; },
    stats: () => ({ fps: Math.round(fpsAvg), simFrozen, twitchShown, cssMounted: !!css, aim, drawCalls: group.children.length }),
  };
  H.office = api;
  return api;
}

/* ---- zelf opstarten ---- */
(function boot(tries = 0) {
  const H = typeof window !== 'undefined' ? window.HOUSE : null;
  if (H && H.scene && H.camera && H.renderer) {
    if (H.office && H.office.installed) return;
    if (!H.THREE) { import('three').then(m => { H.THREE = H.THREE || m; install(H); }).catch(e => console.warn('[office] three niet gevonden', e)); return; }
    try { install(H); } catch (e) { console.warn('[office] installatie mislukt', e); }
    return;
  }
  if (tries < 600) setTimeout(() => boot(tries + 1), 100);
})();
