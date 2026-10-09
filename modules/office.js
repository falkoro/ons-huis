/* office.js — het kantoor/de gamehoek in de zitkamer (add-on voor de woning-walkthrough)
 *
 *  Werkelijkheid (photos/rooms/kantoor_1.jpg, zitkamer_1/2, achterhal_1): de zitkamer is één lange kamer; het "kantoor" staat
 *  langs de linkerwand (x = 0) aan het voorste (hal-)einde, de hoekbank bij het raam. Van voor naar achter: zwarte gamestoel,
 *  zwart bureau met 27"-monitor (vliegtuig-achtergrond, naar de stoel gedraaid), glazen gaming-pc met RGB-fans, 32"-monitor op
 *  een arm, tweede zwarte toren met oranje logo + speaker, dan de flightsim-rig (zwart buisframe, kuipstoel, yoke, gasquadrant
 *  met groen verlichte knoppen), een zwarte draadstoel en het ronde donkergroene hondenbed. Posters hoog boven het bureau (host).
 *  Rechterwand: hoge zwarte kast met glazen deuren in de sprong van de wand, zwart ladeblok met witte laserprinter, blauwe
 *  Helmer-ladekast, tablet. Lichte eiken laminaatvloer, witte wanden (host).
 *
 *  - "Huidig": bovenstaande opstelling. Andere stijlen: opgeruimde designerversie (eiken bureau, mesh-stoel, één monitor,
 *    rig netjes achterin met wandscherm). Wisselt mee met HOUSE.state.style ('change'-event).
 *  - Monitor 2 (32") toont live een vlucht boven de polder (2D-canvas met perspectief + HUD). E / klik = zelf vliegen (Esc = terug).
 *  - Monitor 1 (27") toont het bureaublad met het stream-venster van Asmongold (kanaal "zackrawrr"):
 *      falkoro.github.io / localhost / 127.0.0.1  -> officiële Twitch-embed via CSS3DRenderer ("hole punch") als je dichtbij staat
 *      elders (bv. claude.ai-artifact)            -> geanimeerd voorbeeldbeeld + link naar twitch.tv/zackrawrr
 *    Forceren kan met ?stream=twitch of ?stream=fallback.
 *  - Lichtspill van schermen/RGB (additief, 's avonds sterker). Statische delen per materiaal samengevoegd (≤ 9 draw calls
 *    + 2 schermen + 2 spillvlakken). Loopblokken staan in HOUSE.colliders[0]; HOUSE.office.{dogBed,obstacles,chair} voor de honden.
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

/* Bureaublad van monitor 1 (foto): achtergrond met een watervliegtuig aan een steiger bij zonsondergang, taskbalk met klok,
   en het stream-voorbeeldbeeld in een klein venster rechtsboven. */
function makeDesktop(stream) {
  const W = 640, HH = 360, c = document.createElement('canvas'); c.width = W; c.height = HH;
  const g = c.getContext('2d'), wp = document.createElement('canvas'); wp.width = W; wp.height = HH;
  const SYS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  (function wallpaper(q) {
    const HZ = 178;
    let gr = q.createLinearGradient(0, 0, 0, HZ); gr.addColorStop(0, '#1d2a6b'); gr.addColorStop(0.45, '#8a4f8e'); gr.addColorStop(0.8, '#e8805a'); gr.addColorStop(1, '#ffc46a');
    q.fillStyle = gr; q.fillRect(0, 0, W, HZ);
    gr = q.createRadialGradient(400, 150, 0, 400, 150, 220); gr.addColorStop(0, 'rgba(255,220,150,.75)'); gr.addColorStop(1, 'rgba(255,200,120,0)'); q.fillStyle = gr; q.fillRect(0, 0, W, HZ);
    for (let i = 0; i < 14; i++) { const x = hash(i, 1, 11) * W, y = 20 + hash(i, 2, 11) * 95, w = 50 + hash(i, 3, 11) * 110; q.fillStyle = `rgba(${255},${150 + hash(i, 4, 11) * 60 | 0},${120 + hash(i, 5, 11) * 60 | 0},${0.25 + hash(i, 6, 11) * 0.3})`; q.beginPath(); q.ellipse(x, y, w, 7 + hash(i, 7, 11) * 9, 0, 0, 7); q.fill(); }
    for (const [cc, base, amp, s] of [['#5a5f93', 120, 38, 1], ['#2b2f58', 140, 30, 2], ['#171a36', 158, 22, 3]]) {
      q.fillStyle = cc; q.beginPath(); q.moveTo(0, HZ);
      for (let x = 0; x <= W; x += 16) q.lineTo(x, base + Math.sin(x * 0.021 * s + s) * amp * 0.5 - hash(x / 16 | 0, s, 12) * amp * 0.6);
      q.lineTo(W, HZ); q.closePath(); q.fill();
    }
    gr = q.createLinearGradient(0, HZ, 0, HH); gr.addColorStop(0, '#f2a560'); gr.addColorStop(0.25, '#7a5a8a'); gr.addColorStop(0.6, '#23305e'); gr.addColorStop(1, '#0d1230');
    q.fillStyle = gr; q.fillRect(0, HZ, W, HH - HZ);
    for (let i = 0; i < 60; i++) { const y = HZ + 4 + hash(i, 1, 13) * 150, w = 20 + hash(i, 2, 13) * 90; q.fillStyle = `rgba(255,210,150,${(0.08 + hash(i, 3, 13) * 0.22) * (1 - (y - HZ) / 170)})`; q.fillRect(hash(i, 4, 13) * W, y, w, 1.5); }
    gr = q.createRadialGradient(400, HZ + 10, 0, 400, HZ + 10, 90); gr.addColorStop(0, 'rgba(255,215,160,.6)'); gr.addColorStop(1, 'rgba(255,215,160,0)'); q.fillStyle = gr; q.fillRect(300, HZ, 200, 90);
    // steiger (linksonder, in perspectief)
    q.fillStyle = '#3d2a1b'; q.beginPath(); q.moveTo(0, 300); q.lineTo(236, 232); q.lineTo(262, 236); q.lineTo(0, 345); q.closePath(); q.fill();
    q.fillStyle = '#5c4027'; q.beginPath(); q.moveTo(0, 292); q.lineTo(236, 229); q.lineTo(258, 232); q.lineTo(0, 334); q.closePath(); q.fill();
    q.strokeStyle = 'rgba(0,0,0,.35)'; q.lineWidth = 1; for (let i = 0; i < 14; i++) { const t = i / 14, x = 236 * (1 - t * t), y1 = 229 + (292 - 229) * t * t, y2 = 232 + (334 - 232) * t * t; q.beginPath(); q.moveTo(x, y1); q.lineTo(x + 22 * (1 - t), y2); q.stroke(); }
    for (const [x, y, h] of [[40, 290, 26], [120, 262, 20], [190, 243, 15], [232, 230, 12]]) { q.fillStyle = '#2d1e12'; q.fillRect(x, y - h, 6, h); q.fillStyle = '#3f2b19'; q.fillRect(x, y - h, 2, h); }
    // watervliegtuig (wit met oranje band), drijvers op het water
    q.save(); q.translate(300, 214);
    q.fillStyle = 'rgba(0,0,0,.25)'; q.beginPath(); q.ellipse(4, 30, 54, 5, 0, 0, 7); q.fill();
    q.fillStyle = '#d9dde3'; for (const dy of [22, 27]) { q.beginPath(); q.ellipse(-2 + (dy - 22) * 3, dy, 48, 4.5, 0, 0, 7); q.fill(); }
    q.fillStyle = '#8c9199'; q.fillRect(-20, 6, 3, 18); q.fillRect(14, 6, 3, 18); q.fillRect(-4, 8, 3, 16);
    q.fillStyle = '#f2f3f5'; q.beginPath(); q.moveTo(-58, 0); q.quadraticCurveTo(-52, -10, -30, -11); q.lineTo(28, -12); q.quadraticCurveTo(50, -10, 56, -2); q.quadraticCurveTo(50, 7, 28, 8); q.lineTo(-40, 8); q.quadraticCurveTo(-56, 6, -58, 0); q.closePath(); q.fill();
    q.fillStyle = '#e8732b'; q.fillRect(-40, 1, 72, 3.5);
    q.fillStyle = '#2b3340'; q.beginPath(); q.moveTo(-36, -11); q.lineTo(-18, -16); q.lineTo(8, -16); q.lineTo(16, -11); q.closePath(); q.fill();
    q.fillStyle = '#f2f3f5'; q.beginPath(); q.moveTo(-58, -2); q.lineTo(-72, -26); q.lineTo(-56, -26); q.lineTo(-44, -6); q.closePath(); q.fill();
    q.fillStyle = '#e8e9ec'; q.fillRect(-70, -26, 20, 3); q.fillRect(-26, -22, 64, 5); q.fillStyle = '#c8ccd3'; q.fillRect(-26, -17, 64, 2);
    q.fillStyle = '#1e232b'; q.fillRect(54, -5, 5, 10); q.fillStyle = 'rgba(255,255,255,.5)'; q.fillRect(56, -22, 2, 44);
    q.restore();
  })(wp.getContext('2d'));
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  function draw(dt) {
    stream.draw(dt);
    g.drawImage(wp, 0, 0);
    for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(0,0,0,.35)'; rr(14, 14 + i * 44, 34, 34, 7); g.fill(); g.fillStyle = ['#2d7dff', '#f0b429', '#3ccf7a', '#9146ff', '#e94b3c'][i]; rr(22, 22 + i * 44, 18, 18, 4); g.fill(); }
    // venster met de stream (rechtsboven)
    g.fillStyle = 'rgba(0,0,0,.45)'; rr(354, 36, 272, 184, 7); g.fill();
    g.fillStyle = '#1f1f23'; rr(356, 38, 268, 180, 6); g.fill(); g.fillStyle = '#0e0e10'; g.fillRect(360, 56, 260, 158);
    g.drawImage(stream.canvas, 0, 0, 640, 360, 360, 56, 260, 146);
    g.fillStyle = '#efeff1'; g.font = `600 9px ${SYS}`; g.textAlign = 'left'; g.fillText('Twitch · ' + CHANNEL, 366, 50);
    for (let i = 0; i < 3; i++) { g.fillStyle = ['#ffbd2e', '#28c840', '#ff5f57'][i]; g.beginPath(); g.arc(612 - i * 12, 46, 3.5, 0, 7); g.fill(); }
    // taskbalk
    g.fillStyle = 'rgba(16,18,28,.82)'; g.fillRect(0, HH - 24, W, 24);
    g.fillStyle = '#4da3ff'; for (let i = 0; i < 4; i++) g.fillRect(238 + (i % 2) * 7, HH - 18 + (i / 2 | 0) * 7, 6, 6);
    for (let i = 0; i < 6; i++) { g.fillStyle = ['#ffffff', '#2d7dff', '#9146ff', '#3ccf7a', '#f0b429', '#8a8d93'][i]; rr(262 + i * 26, HH - 19, 15, 15, 3); g.fill(); }
    const d = new Date(); g.fillStyle = '#e9ecf2'; g.font = `500 9px ${SYS}`; g.textAlign = 'right';
    g.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, W - 10, HH - 13); g.fillText(d.toLocaleDateString('nl-NL'), W - 10, HH - 4); g.textAlign = 'left';
  }
  return { canvas: c, draw };
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

/* ---------- onderdelen (lokale assen: een stoel/zitje kijkt naar -z, een scherm naar +z; oorsprong op de vloer) ---------- */
const BLK = '#17171a', BLK2 = '#222327', ALU = '#8f939a', FRM = '#1b1b1e';
const PI = Math.PI, HP = PI / 2;
// monitor: paneel w×h met het beeldvlak op lokaal z = 0; voet op hoogte `top` (bureaublad), arm = monitorarm naar achteren,
// top null = aan de muur (beugel)
function monitor(b, w, h, x, y, z, ry, top, arm) {
  b.push(x, y, z, 0, ry, 0);
  b.box('solid', '#111114', w + 0.024, h + 0.024, 0.022, 0, 0, -0.012);
  b.box('solid', '#1a1a1e', w * 0.55, h * 0.6, 0.04, 0, -0.01, -0.042);
  b.box('glow', '#2a6cff', 0.01, 0.004, 0.002, 0, -h / 2 - 0.004, 0.0);
  const dy = top === null ? 0 : top - y;
  if (top === null) b.box('metal', '#232326', 0.12, 0.12, 0.05, 0, 0, -0.085);
  else if (arm) { b.box('metal', '#232326', 0.05, 0.04, 0.2, 0, -0.03, -0.14); b.box('metal', '#232326', 0.06, -dy + 0.06, 0.06, 0, dy / 2, -0.23); b.box('metal', '#232326', 0.14, 0.03, 0.12, 0, dy + 0.015, -0.2); }
  else { b.box('metal', '#1d1d20', 0.05, -dy - h * 0.4, 0.03, 0, (dy - h * 0.4) / 2, -0.075); b.box('metal', '#1d1d20', 0.24, 0.012, 0.18, 0, dy + 0.006, -0.07); }
  b.pop();
}
// gamestoel (foto): zwart PU-leer, grijze panelen, ronde chroomknop op de rug, 4D-armleggers, zwarte nylon stervoet
function gamingChair(b, x, z, ry) {
  const L = '#121214', L2 = '#2b2c31';
  b.push(x, 0, z, 0, ry, 0);
  for (let k = 0; k < 5; k++) {
    const a = k * PI * 2 / 5;
    b.box('solid', '#1a1a1d', 0.045, 0.035, 0.30, Math.sin(a) * 0.15, 0.085, Math.cos(a) * 0.15, 0, a, 0);
    b.cyl('solid', '#0e0e10', 0.028, 0.028, 0.03, 8, Math.sin(a) * 0.29, 0.03, Math.cos(a) * 0.29, 0, a, HP);
  }
  b.cyl('metal', '#1a1a1d', 0.05, 0.05, 0.06, 10, 0, 0.10, 0); b.cyl('metal', '#2a2a2e', 0.025, 0.03, 0.30, 10, 0, 0.27, 0);
  b.push(0, 0.49, 0);
  b.box('leather', L, 0.52, 0.10, 0.50, 0, 0, 0);
  for (const sx of [-1, 1]) b.box('leather', L2, 0.07, 0.08, 0.46, sx * 0.25, 0.05, 0);
  b.pop();
  for (const sx of [-1, 1]) { b.box('metal', '#1a1a1d', 0.04, 0.20, 0.05, sx * 0.29, 0.60, 0.05); b.box('solid', '#111113', 0.08, 0.03, 0.24, sx * 0.29, 0.71, 0.0); }
  b.push(0, 0.54, 0.24, 0.14, 0, 0);
  b.box('leather', L, 0.50, 0.84, 0.10, 0, 0.42, 0);
  for (const sx of [-1, 1]) {
    b.box('leather', L2, 0.08, 0.60, 0.14, sx * 0.25, 0.36, -0.02);
    b.box('solid', '#060607', 0.05, 0.11, 0.102, sx * 0.12, 0.70, 0);
    b.cyl('metal', '#d6d8dc', 0.045, 0.045, 0.006, 16, sx * 0.292, 0.3, 0.0, 0, 0, HP);
  }
  b.box('leather', L2, 0.26, 0.12, 0.06, 0, 0.66, -0.07); b.box('leather', L2, 0.30, 0.14, 0.05, 0, 0.22, -0.065);
  b.pop(); b.pop();
}
// flightsim-rig (foto): zwart buisframe, kuipstoel, pedalen, yoke op een kolom, gasquadrant links met groen verlichte knoppen
// en een klein schakelpaneeltje. Lokaal: piloot op (0, 0, 0), kijkt naar -z.
function rig(b, x, z, ry) {
  const S = '#121214', S2 = '#1e1e22';
  b.push(x, 0, z, 0, ry, 0);
  for (const sx of [-0.27, 0.27]) b.box('metal', FRM, 0.05, 0.05, 1.15, sx, 0.025, -0.25);
  for (const zz of [-0.78, -0.3, 0.3]) b.box('metal', FRM, 0.59, 0.05, 0.05, 0, 0.025, zz);
  b.box('metal', FRM, 0.44, 0.08, 0.5, 0, 0.1, 0.02);
  b.push(0, 0.24, 0);
  b.box('fabric', S, 0.48, 0.09, 0.48, 0, 0, 0, 0.12, 0, 0);
  for (const sx of [-1, 1]) b.box('fabric', S2, 0.07, 0.11, 0.46, sx * 0.24, 0.05, 0);
  b.push(0, 0.12, 0.22, 0.22, 0, 0);
  b.box('fabric', S, 0.5, 0.82, 0.09, 0, 0.41, 0);
  for (const sx of [-1, 1]) b.box('fabric', S2, 0.08, 0.56, 0.14, sx * 0.25, 0.33, -0.03);
  b.box('fabric', '#2a2a2e', 0.2, 0.14, 0.03, 0, 0.45, -0.06);
  b.pop(); b.pop();
  b.box('solid', BLK, 0.42, 0.025, 0.26, 0, 0.1, -0.68, 0.45, 0, 0);
  for (const sx of [-0.12, 0.12]) b.box('solid', BLK2, 0.09, 0.2, 0.02, sx, 0.2, -0.7, -0.4, 0, 0);
  for (const sx of [-0.26, 0.26]) b.box('metal', FRM, 0.05, 0.66, 0.05, sx, 0.36, -0.46);
  b.box('metal', FRM, 0.62, 0.025, 0.28, 0, 0.69, -0.46);
  b.box('solid', '#1d1d21', 0.26, 0.1, 0.2, 0, 0.755, -0.5);
  b.cyl('metal', ALU, 0.016, 0.016, 0.2, 10, 0, 0.8, -0.31, HP, 0, 0);
  b.box('solid', BLK, 0.09, 0.07, 0.05, 0, 0.8, -0.22);
  for (const sx of [-1, 1]) { b.box('solid', BLK, 0.13, 0.03, 0.035, sx * 0.1, 0.81, -0.22, 0, 0, sx * 0.45); b.box('leather', '#101012', 0.04, 0.13, 0.045, sx * 0.17, 0.87, -0.22, 0, 0, -sx * 0.2); }
  b.box('glow', '#ff2a2a', 0.01, 0.006, 0.01, 0.16, 0.935, -0.22);
  b.box('metal', FRM, 0.05, 0.72, 0.05, -0.42, 0.36, -0.35); b.box('metal', FRM, 0.2, 0.025, 0.3, -0.42, 0.73, -0.35);
  b.box('solid', '#1d1d21', 0.3, 0.1, 0.26, -0.42, 0.79, -0.37);
  ['#2a2a2e', '#2a2a2e', '#d0202a', '#2f6bff', '#2a2a2e', '#f0f0f0'].forEach((kc, i) => { const xx = -0.53 + i * 0.044; b.box('metal', ALU, 0.01, 0.1, 0.01, xx, 0.88, -0.4, -0.25, 0, 0); b.box('solid', kc, 0.026, 0.026, 0.03, xx, 0.93, -0.41); });
  for (let i = 0; i < 7; i++) b.box('glow', '#3dff7a', 0.016, 0.006, 0.016, -0.54 + i * 0.04, 0.842, -0.26);
  b.box('glow', '#2bd36a', 0.26, 0.004, 0.012, -0.42, 0.842, -0.3);
  b.box('solid', '#1d1d21', 0.16, 0.035, 0.12, -0.42, 0.75, -0.14);
  for (let i = 0; i < 6; i++) b.box('glow', '#3dff7a', 0.01, 0.006, 0.01, -0.47 + (i % 3) * 0.05, 0.77, -0.17 + (i / 3 | 0) * 0.05);
  b.pop();
}
// glazen gaming-pc (foto): zwarte kast met glas aan de voor- en zijkant, drie RGB-fans (groen/cyaan/wit), pompblok met lcd
function glassPc(T, b, x, y, z) {
  // kast = achterwand, bodem, deksel en dichte zijkant (naar de muur); voorkant (+x) en zijkant (+z) van glas met een smal frame
  b.box('solid', '#101013', 0.02, 0.48, 0.25, x - 0.22, y + 0.24, z); b.box('solid', '#101013', 0.46, 0.48, 0.02, x, y + 0.24, z - 0.115);
  for (const dy of [0.01, 0.47]) b.box('solid', '#101013', 0.46, 0.02, 0.25, x, y + dy, z);
  b.box('solid', '#101013', 0.02, 0.48, 0.02, x + 0.22, y + 0.24, z + 0.115);
  b.box('solid', '#0c0c0f', 0.3, 0.44, 0.21, x - 0.07, y + 0.24, z - 0.005);                                     // moederbord/voeding
  b.box('solid', '#15151a', 0.26, 0.03, 0.19, x - 0.06, y + 0.3, z - 0.005); b.box('rgb', '#ffffff', 0.26, 0.004, 0.006, x - 0.06, y + 0.316, z + 0.092);
  b.box('glass', '#9fb8c8', 0.004, 0.44, 0.21, x + 0.226, y + 0.24, z - 0.01); b.box('glass', '#9fb8c8', 0.42, 0.44, 0.004, x - 0.01, y + 0.24, z + 0.121);
  [['glow', '#e0ecff', 0.37], ['rgb', '#ffffff', 0.24], ['rgb', '#b8ffd8', 0.11]].forEach(([k, c, dy]) => { b.box('solid', '#15151a', 0.012, 0.12, 0.12, x + 0.15, y + dy + 0.03, z - 0.005); b.geo(k, c, new T.TorusGeometry(0.052, 0.007, 6, 20), x + 0.19, y + dy + 0.03, z - 0.005, 0, HP, 0); b.cyl('solid', '#1a1a1f', 0.022, 0.022, 0.03, 8, x + 0.18, y + dy + 0.03, z - 0.005, 0, 0, HP); });
  b.box('rgb', '#ffffff', 0.006, 0.4, 0.006, x - 0.2, y + 0.24, z + 0.105);
  b.box('solid', '#1a1a1f', 0.07, 0.07, 0.02, x - 0.08, y + 0.3, z + 0.105); b.box('glow', '#2e4068', 0.05, 0.05, 0.002, x - 0.08, y + 0.3, z + 0.116); b.box('glow', '#d8e6ff', 0.02, 0.012, 0.002, x - 0.08, y + 0.3, z + 0.117);
}
// zwarte draadstoel (foto): staalspijlen rond, zitting van zwart hout
function wireStool(T, b, x, z) {
  for (let i = 0; i < 16; i++) { const a = i * PI / 8; b.box('metal', '#111113', 0.006, 0.44, 0.006, x + Math.sin(a) * 0.19, 0.23, z + Math.cos(a) * 0.19, 0.12, a, 0); }
  for (const y of [0.02, 0.44]) b.geo('metal', '#111113', new T.TorusGeometry(0.19, 0.005, 4, 28), x, y, z, HP, 0, 0);
  b.cyl('solid', '#151517', 0.2, 0.2, 0.014, 24, x, 0.452, z);
}
function roundBed(b, x, z) {
  b.cyl('fabric', '#2c4a3e', 0.46, 0.5, 0.2, 28, x, 0.1, z); b.cyl('fabric', '#36584b', 0.35, 0.35, 0.15, 24, x, 0.085, z);
}

/* ---------- "Huidig" (kantoor_1.jpg): alles langs de linkerwand (x = 0), kasten rechts ---------- */
function buildHuidig(T, b) {
  // bureau: zwart laminaat op zwart stalen frame, x 0.03–0.68, z 4.375–6.325
  b.box('solid', '#141416', 1.95, 0.03, 0.65, 0.355, 0.735, 5.35);
  for (const z of [4.42, 6.28]) { for (const x of [0.12, 0.6]) b.box('metal', '#151518', 0.05, 0.70, 0.05, x, 0.36, z); b.box('metal', '#151518', 0.56, 0.03, 0.05, 0.36, 0.015, z); b.box('metal', '#151518', 0.56, 0.03, 0.05, 0.36, 0.705, z); }
  b.box('metal', '#151518', 0.04, 0.04, 1.75, 0.1, 0.62, 5.35);
  // op het bureau: muismat (rood/zwart), muis, controller, mok, toetsenbord
  b.box('fabric', '#3a1416', 0.42, 0.004, 0.36, 0.5, 0.752, 5.95);
  b.box('solid', '#1a1a1d', 0.06, 0.03, 0.1, 0.56, 0.768, 5.98); b.box('glow', '#3a7bff', 0.004, 0.004, 0.05, 0.56, 0.785, 5.97);
  b.box('solid', '#e8e8ea', 0.1, 0.05, 0.14, 0.58, 0.775, 6.2); b.cyl('solid', '#efefef', 0.04, 0.036, 0.095, 12, 0.3, 0.8, 6.1);
  b.box('solid', '#1a1a1d', 0.14, 0.022, 0.44, 0.5, 0.765, 4.92); for (let r = 0; r < 5; r++) b.box('rgb', '#6a6a6a', 0.018, 0.003, 0.4, 0.44 + r * 0.03, 0.777, 4.92);
  // monitor 1 (27", naar de stoel gedraaid), glazen pc, monitor 2 (32") op een arm, tweede toren met speaker
  monitor(b, 0.597, 0.336, 0.42, 1.06, 5.85, HP - 0.4, 0.75, false);
  glassPc(T, b, 0.35, 0.75, 5.3);
  monitor(b, 0.705, 0.397, 0.3, 1.45, 4.9, HP - 0.1, 0.75, true);
  b.box('solid', '#111114', 0.44, 0.44, 0.21, 0.36, 0.97, 4.52); b.box('solid', '#1b1b1f', 0.004, 0.4, 0.17, 0.582, 0.97, 4.52);
  b.box('glow', '#ff7a1a', 0.004, 0.05, 0.05, 0.583, 1.08, 4.52); b.box('glow', '#ff3a1a', 0.004, 0.02, 0.02, 0.584, 1.08, 4.52);
  b.box('solid', '#141416', 0.12, 0.18, 0.12, 0.36, 1.28, 4.52); b.box('fabric', '#2a2a2e', 0.004, 0.14, 0.09, 0.422, 1.28, 4.52);
  b.box('glow', '#33ff66', 0.003, 0.006, 0.006, 0.423, 1.21, 4.55);
  // rig, draadstoel, hondenbed, gamestoel
  rig(b, 1.45, 4.05, HP);
  wireStool(T, b, 1.58, 4.68);
  roundBed(b, 1.3, 5.4);
  gamingChair(b, 0.82, 6.3, -2.45);
  // kabels (zwarte slierten onder het bureau)
  for (let i = 0; i < 4; i++) b.box('solid', '#0c0c0e', 0.012, 0.012, 1.2 + hash(i, 1, 21) * 0.6, 0.14 + hash(i, 2, 21) * 0.4, 0.012, 5.3, 0, hash(i, 3, 21) * 0.3 - 0.15, 0);
  // rechterwand: hoge zwarte kast met glazen deuren in de sprong van de wand (x 3.05–3.6, z 2.95–3.8), ladeblok + printer, Helmer
  b.box('solid', '#121214', 0.55, 0.76, 0.85, 3.325, 0.38, 3.365);
  b.box('solid', '#121214', 0.04, 1.2, 0.85, 3.58, 1.36, 3.365); b.box('solid', '#121214', 0.55, 0.04, 0.85, 3.325, 1.94, 3.365);
  for (const z of [2.955, 3.775]) b.box('solid', '#121214', 0.55, 1.2, 0.03, 3.325, 1.36, z);
  for (const y of [1.14, 1.52]) b.box('solid', '#1b1b1e', 0.5, 0.02, 0.78, 3.33, y, 3.365);
  [['#c23b2e', 3.2, 1.21], ['#2f6bff', 3.5, 1.21], ['#e8e8e8', 3.3, 0.88], ['#f0b429', 3.55, 1.6], ['#2bd17e', 3.25, 1.6]].forEach(([c, z, y]) => b.box('solid', c, 0.12, 0.12, 0.08, 3.4, y + 0.06, z));
  b.box('glass', '#a8c0d0', 0.004, 1.16, 0.8, 3.056, 1.36, 3.365); b.box('solid', '#1a1a1d', 0.01, 1.16, 0.02, 3.054, 1.36, 3.365);
  b.box('solid', '#1a1a1d', 0.56, 0.02, 0.86, 3.325, 0.77, 3.365);
  b.box('solid', '#b08a5c', 0.42, 0.3, 0.5, 3.33, 2.11, 3.25); b.box('solid', '#1d1d20', 0.4, 0.25, 0.3, 3.32, 2.08, 3.65);
  b.box('solid', '#141416', 0.43, 0.74, 1.1, 2.785, 0.37, 4.4);
  for (let r = 0; r < 3; r++) for (const z of [4.14, 4.66]) { b.box('solid', '#1b1b1e', 0.01, 0.2, 0.48, 2.565, 0.14 + r * 0.23, z); b.box('metal', '#c8cacf', 0.008, 0.012, 0.16, 2.558, 0.14 + r * 0.23, z); }
  b.box('solid', '#eeeeee', 0.4, 0.3, 0.42, 2.79, 0.89, 4.3); b.box('solid', '#3a3b40', 0.36, 0.05, 0.3, 2.79, 1.06, 4.3); b.box('solid', '#dcdcdc', 0.3, 0.02, 0.2, 2.78, 0.9, 4.03); b.box('glow', '#4aa3ff', 0.004, 0.004, 0.004, 2.59, 0.98, 4.2);
  b.cyl('solid', '#f2f2f0', 0.1, 0.1, 0.32, 16, 2.82, 0.9, 3.93); b.cyl('solid', '#ff7a2a', 0.035, 0.035, 0.24, 10, 2.66, 0.86, 4.7); b.cyl('solid', '#2a2a2e', 0.03, 0.03, 0.03, 10, 2.66, 0.995, 4.7);
  b.box('solid', '#1a1a1d', 0.14, 0.022, 0.42, 2.72, 0.755, 4.68, 0, 0.1, 0);
  b.box('gloss', '#1a44a6', 0.43, 0.69, 0.28, 2.785, 0.345, 5.92);
  for (let r = 0; r < 6; r++) { b.box('gloss', '#1f4db4', 0.01, 0.1, 0.25, 2.565, 0.08 + r * 0.112, 5.92); b.box('metal', '#d0d2d6', 0.014, 0.01, 0.09, 2.556, 0.08 + r * 0.112, 5.92); }
  b.box('solid', '#1a1a1d', 0.1, 0.02, 0.1, 2.72, 0.7, 6.2); b.box('solid', '#111114', 0.012, 0.2, 0.15, 2.71, 0.81, 6.2, 0, 0, 0.35); b.box('glow', '#9fc7ff', 0.004, 0.17, 0.12, 2.675, 0.812, 6.2, 0, 0, 0.35);
  return {
    stream: [0.432, 1.06, 5.85, HP - 0.4], sim: [0.312, 1.45, 4.9, HP - 0.1], pc: [[0.35, 0.99, 5.3, 0.46, 0.48, 0.25], [0.36, 0.97, 4.52, 0.44, 0.44, 0.21]],
    spill: [[0.7, 0.42, 0.48, 0.754, 5.85, -HP, 0, 'warm'], [1.3, 1.0, 0.012, 1.05, 5.1, 0, HP, 'rgb']],
    cols: [[0, 0.72, 4.35, 6.35], [0.55, 1.75, 3.75, 4.6], [1.35, 1.8, 4.45, 4.9], [0.5, 1.15, 6.0, 6.65], [3.02, 3.62, 2.94, 3.8], [2.55, 3.0, 3.83, 4.97], [2.55, 3.0, 5.76, 6.08]],
    dogBed: { x: 1.3, z: 5.4, r: 0.5, top: 0.16 }, chair: { x: 0.82, z: 6.3, y: 0.52 },
  };
}

/* ---------- andere stijlen: opgeruimde designerversie (eiken bureau, mesh-bureaustoel, één monitor, rig netjes achterin) ---------- */
function buildTidy(T, b) {
  b.box('wood', '#c9a977', 1.6, 0.03, 0.75, 0.405, 0.745, 5.8);
  for (const z of [5.1, 6.5]) { for (const x of [0.1, 0.72]) b.box('gloss', '#e9e9e6', 0.04, 0.70, 0.04, x, 0.365, z); b.box('gloss', '#e9e9e6', 0.66, 0.03, 0.04, 0.41, 0.015, z); b.box('gloss', '#e9e9e6', 0.66, 0.03, 0.04, 0.41, 0.715, z); }
  monitor(b, 0.597, 0.336, 0.33, 1.1, 5.8, HP, 0.76, true);
  b.box('solid', '#15151a', 0.35, 0.38, 0.16, 0.3, 0.19, 5.15);
  b.cyl('solid', '#1a1a1d', 0.07, 0.08, 0.02, 16, 0.2, 0.77, 5.2); b.box('solid', '#1a1a1d', 0.02, 0.38, 0.02, 0.2, 0.96, 5.2, 0, 0, -0.35); b.cyl('solid', '#1a1a1d', 0.05, 0.03, 0.08, 12, 0.33, 1.13, 5.2, 0, 0, 1.2); b.box('glow', '#ffd9a0', 0.03, 0.004, 0.03, 0.34, 1.09, 5.2);
  b.cyl('solid', '#d8d4cc', 0.06, 0.05, 0.1, 12, 0.18, 0.81, 6.42); b.cyl('fabric', '#3f7a3a', 0.1, 0.06, 0.12, 10, 0.18, 0.92, 6.42);
  b.cyl('solid', '#efefef', 0.04, 0.036, 0.095, 12, 0.55, 0.8, 6.2); b.box('solid', '#2b2b30', 0.2, 0.012, 0.27, 0.5, 0.766, 5.85);
  b.box('solid', '#1a1a1d', 0.12, 0.018, 0.36, 0.5, 0.769, 5.5); b.box('solid', '#1a1a1d', 0.06, 0.03, 0.1, 0.62, 0.775, 5.8);
  // mesh-bureaustoel, naar het bureau gekeerd
  b.push(0.98, 0, 5.8, 0, HP, 0);
  for (let k = 0; k < 5; k++) { const a = k * PI * 2 / 5; b.box('solid', '#1a1a1d', 0.04, 0.03, 0.28, Math.sin(a) * 0.14, 0.06, Math.cos(a) * 0.14, 0, a, 0); b.cyl('solid', '#0e0e10', 0.025, 0.025, 0.03, 8, Math.sin(a) * 0.27, 0.03, Math.cos(a) * 0.27, 0, a, HP); }
  b.cyl('metal', '#2a2a2e', 0.025, 0.03, 0.36, 10, 0, 0.27, 0);
  b.box('fabric', '#3a3d44', 0.48, 0.07, 0.46, 0, 0.47, 0.02);
  for (const sx of [-1, 1]) { b.box('metal', '#1a1a1d', 0.03, 0.2, 0.04, sx * 0.26, 0.6, 0.04); b.box('solid', '#111113', 0.07, 0.025, 0.22, sx * 0.26, 0.71, 0.0); }
  b.push(0, 0.5, 0.22, 0.12, 0, 0);
  b.box('fabric', '#2c2f36', 0.46, 0.6, 0.03, 0, 0.36, 0); b.box('solid', '#111113', 0.48, 0.62, 0.012, 0, 0.36, -0.012); b.box('solid', '#111113', 0.04, 0.3, 0.04, 0, 0.1, -0.02);
  b.pop(); b.pop();
  // rig netjes achterin, scherm aan de muur
  rig(b, 1.3, 4.1, HP);
  monitor(b, 0.705, 0.397, 0.05, 1.3, 4.1, HP, null, false);
  return {
    stream: [0.342, 1.1, 5.8, HP], sim: [0.062, 1.3, 4.1, HP], pc: [[0.3, 0.19, 5.15, 0.35, 0.38, 0.16]],
    spill: [[0.7, 0.42, 0.4, 0.764, 5.8, -HP, 0, 'warm'], [0.5, 0.5, 0.26, 0.764, 5.2, -HP, 0, 'lamp']],
    cols: [[0, 0.82, 4.95, 6.65], [0.5, 1.6, 3.8, 4.45]], dogBed: null, chair: { x: 0.98, z: 5.8, y: 0.5 },
  };
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

  /* ---- 3D ---- */
  const mats = {
    solid: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02 }),       // mat zwart plastic / laminaat
    gloss: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.1 }),       // gelakt staal (Helmer, witte poten)
    wood: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 }),
    fabric: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }),
    leather: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 }),       // PU-leer van de gamestoel
    metal: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.6 }),
    glass: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false }),
    glow: new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    rgb: new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
  // schermen (vast; worden bij een stijlwissel alleen verplaatst)
  const sim = makeSimRenderer(), flight = newFlight();
  const simCanvas = document.createElement('canvas'); simCanvas.width = 560; simCanvas.height = 315;
  const simCtx = simCanvas.getContext('2d');
  const simTex = new T.CanvasTexture(simCanvas); simTex.colorSpace = T.SRGBColorSpace; simTex.anisotropy = 4;
  const simScreen = new T.Mesh(new T.PlaneGeometry(0.705, 0.397), new T.MeshBasicMaterial({ map: simTex, toneMapped: false })); simScreen.name = 'office-sim-screen';
  const stream = makeStreamFallback(), desk = makeDesktop(stream);
  const streamTex = new T.CanvasTexture(desk.canvas); streamTex.colorSpace = T.SRGBColorSpace; streamTex.anisotropy = 4;
  const streamMat = new T.MeshBasicMaterial({ map: streamTex, toneMapped: false });
  const holeMat = new T.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: T.NoBlending, toneMapped: false });
  const SW = 0.597, streamScreen = new T.Mesh(new T.PlaneGeometry(SW, 0.336), streamMat); streamScreen.name = 'office-stream-screen';
  // lichtspill van de schermen/RGB op bureau en muur (additief; 's avonds sterker)
  const halo = haloTexture(T), spillOpt = { map: halo, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const spillMats = { warm: new T.MeshBasicMaterial({ ...spillOpt, color: 0xff9a55 }), rgb: new T.MeshBasicMaterial({ ...spillOpt, color: 0x40ff90 }), lamp: new T.MeshBasicMaterial({ ...spillOpt, color: 0xffc070 }) };
  const SPILL = { warm: 0.3, rgb: 0.12, lamp: 0.35 };
  // pc aan/uit (klik op de kast, of op een scherm als hij uit staat): uit = zwarte schermen, geen RGB, geen lichtspill
  const offMat = new T.MeshStandardMaterial({ color: 0x050506, roughness: 0.18, metalness: 0 }), simMat = simScreen.material, hitMat = new T.MeshBasicMaterial({ visible: false });
  let pcOn = true;
  function setPc(on) {
    pcOn = !!on;
    if (!pcOn) setTwitchShown(false);
    simScreen.material = pcOn ? simMat : offMat; if (!twitchShown) streamScreen.material = pcOn ? streamMat : offMat;
    mats.glow.color.setScalar(pcOn ? 1 : 0.03); lastSim = lastStream = -1;
  }
  const pcInteract = { room: ROOM_ID, on: () => pcOn, label: () => (pcOn ? 'pc uitzetten' : 'pc aanzetten'), act: () => setPc(!pcOn) };

  let group = null, lay = null, builtStyle = null, cols = [], api = null;
  const styleOf = () => { try { return H.state?.style || 'huidig'; } catch (e) { return 'huidig'; } };
  function rebuild() {
    const style = styleOf(); if (group && style === builtStyle) return; builtStyle = style;
    if (group) { group.traverse(o => { if (o.isMesh && o !== simScreen && o !== streamScreen) o.geometry.dispose(); }); group.removeFromParent(); }
    if (H.colliders?.[0]) { for (const c of cols) { const i = H.colliders[0].indexOf(c); if (i >= 0) H.colliders[0].splice(i, 1); } }
    const b = makeBuilder(T);
    lay = style === 'huidig' ? buildHuidig(T, b) : buildTidy(T, b);
    group = b.build(mats); group.name = 'office-' + (style === 'huidig' ? 'huidig' : 'tidy');
    for (const [m, p] of [[simScreen, lay.sim], [streamScreen, lay.stream]]) { m.position.set(p[0], p[1], p[2]); m.rotation.set(0, p[3], 0); group.add(m); }
    for (const [w, h, x, y, z, rx, ry, k] of lay.spill) { const m = new T.Mesh(new T.PlaneGeometry(w, h), spillMats[k]); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); m.renderOrder = 2; m.name = 'office-spill'; group.add(m); }
    // turned so its +z (the side you aim from) faces the room (+x), like the glass front of the pc
    for (const [x, y, z, sx, sy, sz] of lay.pc) { const m = new T.Mesh(new T.BoxGeometry(sz, sy, sx), hitMat); m.position.set(x, y, z); m.rotation.y = HP; m.name = 'office-pc-hit'; m.userData.interact = pcInteract; group.add(m); }
    cols = H.colliders?.[0] ? lay.cols.map(c => { const q = c.slice(); H.colliders[0].push(q); return q; }) : [];
    addToRoom(group); group.updateMatrixWorld(true);
    if (api) { api.group = group; api.dogBed = lay.dogBed; api.obstacles = lay.cols; api.chair = lay.chair; }
  }
  rebuild();
  if (typeof H.on === 'function') { try { H.on('change', () => rebuild()); } catch (e) { /* geen events */ } }

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
    const k = SW / 1280; css.obj.matrix.copy(streamScreen.matrixWorld).multiply(new T.Matrix4().makeScale(k, k, k));
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w !== css.w || h !== css.h) { css.w = w; css.h = h; css.r.setSize(w, h); css.layer.style.left = canvas.offsetLeft + 'px'; css.layer.style.top = canvas.offsetTop + 'px'; }
  }
  function setTwitchShown(on) {
    if (twitchShown === on) return; twitchShown = on;
    streamScreen.material = on ? holeMat : pcOn ? streamMat : offMat;
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
    if (!pcOn) setPc(true);
    else if (w === 'sim') enterFly();
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
  drawSimTo(simCtx, 560, 315); simTex.needsUpdate = true;
  desk.draw(0.016); streamTex.needsUpdate = true;
  let simAcc = 0, streamAcc = 0;
  const nightOf = () => { const t = +(H.state?.time ?? 13); return clamp((t - 17) / 3.5, 0, 1) + clamp((7.5 - t) / 2, 0, 1); };

  onTick(dt => {
    dt = Math.min(dt || 0.016, 0.1); clock += dt;
    fpsAvg = lerp(fpsAvg, 1 / Math.max(dt, 1e-3), 0.05); warm += dt;
    if (ENV.phone && warm > 5 && fpsAvg < 40 && !simFrozen) simFrozen = true;
    // RGB-kleurcyclus van de pc-fans (groen ↔ cyaan, foto); lichtspill volgt de tijd van de dag
    hue = 0.41 + 0.09 * Math.sin(clock * 0.5);
    mats.rgb.color.setHSL(hue, 1, pcOn ? 0.55 : 0.02); spillMats.rgb.color.setHSL(hue, 1, 0.5);
    const night = nightOf(); for (const k in spillMats) spillMats[k].opacity = pcOn ? SPILL[k] * (0.2 + 0.8 * night) : 0;
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
    if (pcOn && !simFrozen && dSim !== null && dSim < 30) {
      const rate = mode === 'walk' && dSim < 4.5 && fpsAvg > 45 ? 24 : mode === 'walk' && dSim < 9 ? 12 : 6;
      if (clock - lastSim >= 1 / rate || lastSim < 0) {
        let left = Math.min(simAcc, 0.5); while (left > 1e-4) { const h = Math.min(left, 1 / 20); stepFlight(flight, h, inp); left -= h; }
        simAcc = 0; lastSim = clock; drawSimTo(simCtx, 560, 315); simTex.needsUpdate = true;
      }
    } else simAcc = Math.min(simAcc, 0.5);

    // stream: Twitch-embed of voorbeeldbeeld
    const dStr = viewOf(streamScreen);
    let want = false;
    if (pcOn && TWITCH && !twitchFailed && mode === 'walk' && dStr !== null && dStr < 5 && inRoom(camera.position)) want = true;
    if (want) {
      if (!css) ensureCss();
      if (!wantSince) wantSince = clock; hiddenSince = 0;
      if (css && clock - wantSince > 0.15) setTwitchShown(true);
    } else { wantSince = 0; setTwitchShown(false); if (!hiddenSince) hiddenSince = clock; if (css && clock - hiddenSince > 45) unmountCss(); }
    if (twitchShown && css) { placeCss(); css.r.render(css.scene, camera); }
    streamAcc += dt;
    if (pcOn && !twitchShown && dStr !== null && dStr < 14) {
      const rate = simFrozen ? 4 : dStr < 6 ? 12 : 6;
      if (clock - lastStream >= 1 / rate) { desk.draw(Math.min(streamAcc, 0.5)); streamAcc = 0; lastStream = clock; streamTex.needsUpdate = true; }
    } else streamAcc = Math.min(streamAcc, 0.5);

    // richten (hint onder het vizier)
    aim = null;
    if (mode === 'walk' && (document.pointerLockElement === canvas || !ENV.coarse) && !watch) aim = pickCenter(3.2);
    if (aim) {
      const k = ENV.coarse ? 'Tik' : 'E / klik';
      tag.textContent = !pcOn ? `${k}: pc aanzetten` : aim === 'sim' ? `${k}: vliegen` : twitchShown ? `${k}: bekijk stream` : `${k}: stream-link`;
      tag.hidden = false;
    } else tag.hidden = true;
  });

  api = {
    installed: true, channel: CHANNEL, url: TWITCH_PAGE, streamMode: ENV.stream, group, flight,
    screens: { sim: simScreen, stream: streamScreen }, dogBed: lay.dogBed, obstacles: lay.cols, chair: lay.chair, rebuild,
    get style() { return builtStyle; },
    enterFly, exitFly, setWatch, showLink, setPc, get pcOn() { return pcOn; },
    get flying() { return flying; }, get twitchShown() { return twitchShown; }, get simFrozen() { return simFrozen; },
    stats: () => ({ fps: Math.round(fpsAvg), simFrozen, twitchShown, cssMounted: !!css, aim, style: builtStyle, drawCalls: group.children.length }),
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
