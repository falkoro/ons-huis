/* garden.js — de achtertuin van Ons Huis (add-on voor de woning-walkthrough)
 *
 *  - Jacuzzi (Wellis Malaga, 218 x 218 x 90 cm) op een houten vlonder met opstap: vierkante kuip met afgeschuinde hoeken,
 *    ombouw van grijze horizontale planken met antracieten hoekstijlen (logo-paneel licht 's avonds mee), brede witte
 *    acrylrand, gevormde schaal met hoekzitjes, dieper middenzitje, zijzitjes, ligplek, filterhoek, grijze hoofdsteunen,
 *    ~30 chroomjets, waterval, bedieningspaneel. Onder water: dieptetint, bewegende caustieken (shell-shader).
 *    Grijs vinyl deksel (2 helften, taps, stiksels, banden) dat met E / klik / tik dubbelvouwt en op de dekselbeugel
 *    achter de kuip komt te staan (coverIt); knop "Jacuzzi" in de werkbalk doet hetzelfde.
 *    Open: water met bewegende rimpels, Fresnel-spiegeling en schuim; "bubbels aan/uit" via het water (bubblesIt):
 *    roering, extra rimpels, schuim langs de wanden en opstijgende bubbels uit de lage jets. Lichte damp ('s avonds meer).
 *    's Avonds LED: 45 s kleurcyclus over waterlijn-LED's, de grote LED, het water en de schaal (alleen kleur/sterkte,
 *    nooit het aantal lichten; HOUSE.garden.setLed overrulet).
 *  - Schuurtje (berging 2016, x 6.0–9.4 / z −10.9…−8.4) + strookberging, houten rabatdelen, deur, raampje,
 *    EPDM-dak met boeiboord, zinken goot, regenpijp en regenton. Buurpand 2022 achter de haag als context.
 *  - Achterhaag met instanced bladkaarten, gazon met instanced graspollen (wind + afstandsvervaging),
 *    borders met schors, hortensia's, buxusbollen, siergrassen, lavendel, rode esdoorn, olijf in pot,
 *    de bloesemboom en de grote boom van de buren (buiten het perceel, als decor).
 *  - Terras: loungehoek, eettafel met vier stoelen, zweefparasol, bbq, plantenbakken. Staptegels naar de
 *    jacuzzi en naar de schuur. Tuinverlichting (lichtsnoer, palen) die 's avonds brandt.
 *  - Prestaties: alles statisch is per materiaal samengevoegd; gras/blad/bubbels/stoom zijn instanced;
 *    geen allocaties per frame; minder dichtheid op telefoons (pointer: coarse).
 *
 * Laden (na de hoofdmodule):  <script type="module" src="./modules/garden.js"></script>
 * Gebruikt alleen de bestaande import map ("three"). Exporteert install(HOUSE); start zelf op.
 * Host-placeholders: de schuurdozen van de host worden weggeknipt (driehoeken binnen hun bounding box,
 * zie hideHostShed) en hun colliders verwijderd, zie HOST-PATCH.md voor de nette oplossing.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180, PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ENV = (() => {
  const mm = q => { try { return matchMedia(q).matches; } catch (e) { return false; } };
  const coarse = mm('(pointer: coarse)');
  return { coarse, reduced: mm('(prefers-reduced-motion: reduce)') };
})();
// dichtheden (telefoon = helft of minder)
const Q = ENV.coarse
  ? { grass: 2800, hedge: 900, foliage: 0.45, bubbles: 64, steam: 24, tex: 256, lights: false, fade: [3, 6] }
  : { grass: 9500, hedge: 2600, foliage: 1.0, bubbles: 160, steam: 48, tex: 512, lights: true, fade: [3.5, 7.5] };

/* =====================================================================================================
 *  CANVAS-TEXTUREN (procedureel, geen downloads)
 * ===================================================================================================== */
function mkCanvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true }); return c; } // CPU canvas: pixels are read back (noise, normal maps), which on a GPU canvas waits for the GPU
function tex(c, su = 1, sv = su, srgb = true) {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / su, 1 / sv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
function noise(ctx, w, h, n, amp, R) { for (let i = 0; i < n; i++) { ctx.fillStyle = `rgba(${R() < .5 ? 0 : 255},${R() < .5 ? 0 : 255},${R() < .5 ? 0 : 255},${(R() * amp).toFixed(3)})`; ctx.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2); } }
// hoogte-canvas (grijs) -> normal map (Sobel, tileable)
function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data, out = mkCanvas(w, h), ctx = out.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.sqrt(dx * dx + dy * dy + 1), i = (y * w + x) * 4;
    d[i] = 128 + (-dx / l) * 127; d[i + 1] = 128 + (dy / l) * 127; d[i + 2] = 128 + (1 / l) * 127; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); return out;
}
// horizontale planken (grain langs U); returns { map, nor }
function texWood(seed, hue, sat, light, planks, opts = {}) {
  const S = Q.tex, c = mkCanvas(S), x = c.getContext('2d'), hc = mkCanvas(S), hx = hc.getContext('2d'), R = rng(seed), ph = S / planks;
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, S, S);
  for (let p = 0; p < planks; p++) {
    const y0 = p * ph, l = light + (R() - .5) * 14, h = hue + (R() - .5) * 8;
    x.fillStyle = hsl(h, sat, l); x.fillRect(0, y0, S, ph);
    for (let g = 0; g < 70; g++) { // nerf
      const yy = y0 + R() * ph, w = 0.6 + R() * 1.6, a = 0.08 + R() * 0.18; x.strokeStyle = hsl(h, sat + 5, l + (R() < .5 ? -14 : 10), a); x.lineWidth = w;
      x.beginPath(); x.moveTo(0, yy); for (let k = 1; k <= 8; k++) x.lineTo(k * S / 8, yy + Math.sin(k * 1.7 + R() * 2) * (1 + R() * 2)); x.stroke();
    }
    if (opts.knots !== false && R() < 0.45) { const kx = R() * S, ky = y0 + ph * (0.3 + R() * 0.4), r = 3 + R() * 6; const gr = x.createRadialGradient(kx, ky, 0, kx, ky, r); gr.addColorStop(0, hsl(h, sat, l - 22)); gr.addColorStop(1, hsl(h, sat, l, 0)); x.fillStyle = gr; x.beginPath(); x.ellipse(kx, ky, r * 1.6, r, 0, 0, PI * 2); x.fill(); }
    // naad
    const gap = opts.gap ?? 2; x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, y0 + ph - gap, S, gap); x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, y0, S, 1);
    hx.fillStyle = '#404040'; hx.fillRect(0, y0 + ph - gap, S, gap); hx.fillStyle = '#9a9a9a'; hx.fillRect(0, y0, S, 2);
    if (opts.rabat) { const g2 = hx.createLinearGradient(0, y0, 0, y0 + ph); g2.addColorStop(0, '#5a5a5a'); g2.addColorStop(1, '#b0b0b0'); hx.fillStyle = g2; hx.fillRect(0, y0, S, ph - gap); x.fillStyle = 'rgba(0,0,0,.28)'; x.fillRect(0, y0, S, ph * 0.14); }
  }
  noise(x, S, S, S * 6, 0.09, R);
  return { map: c, nor: normalFromHeight(hc, opts.rabat ? 1.2 : 1.6) };
}
// grijs vinyl spa-deksel: 2 vakken naast elkaar (één helft), stiksels, bolling in de hoogte
function texCover() {
  const W = Q.tex, H = Q.tex / 2, c = mkCanvas(W, H), x = c.getContext('2d'), hc = mkCanvas(W, H), hx = hc.getContext('2d'), R = rng(5);
  x.fillStyle = '#5d6165'; x.fillRect(0, 0, W, H); hx.fillStyle = '#404040'; hx.fillRect(0, 0, W, H);
  const m = W * 0.035;
  for (let p = 0; p < 2; p++) {
    const x0 = p * W / 2 + m, x1 = (p + 1) * W / 2 - m, y0 = m, y1 = H - m;
    const g = x.createRadialGradient((x0 + x1) / 2, (y0 + y1) / 2, 0, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 0.7);
    g.addColorStop(0, '#767a7f'); g.addColorStop(0.7, '#62666a'); g.addColorStop(1, '#45484c'); x.fillStyle = g; x.beginPath(); x.roundRect(x0, y0, x1 - x0, y1 - y0, m * 1.2); x.fill();
    // hoogte: zachte bolling
    const hg = hx.createRadialGradient((x0 + x1) / 2, (y0 + y1) / 2, 0, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 0.62);
    hg.addColorStop(0, '#d0d0d0'); hg.addColorStop(0.6, '#a8a8a8'); hg.addColorStop(1, '#505050'); hx.fillStyle = hg; hx.beginPath(); hx.roundRect(x0, y0, x1 - x0, y1 - y0, m * 1.2); hx.fill();
    // stiksel
    x.setLineDash([3, 3]); x.strokeStyle = 'rgba(205,210,215,.8)'; x.lineWidth = 2; x.beginPath(); x.roundRect(x0 + 3, y0 + 3, x1 - x0 - 6, y1 - y0 - 6, m); x.stroke(); x.setLineDash([]);
  }
  x.strokeStyle = 'rgba(0,0,0,.5)'; x.lineWidth = 4; x.beginPath(); x.moveTo(W / 2, 0); x.lineTo(W / 2, H); x.stroke();
  noise(x, W, H, W * 4, 0.07, R);
  return { map: c, nor: normalFromHeight(hc, 1.3) };
}
// caustieken: dunne lichte lijnen waar een som van sinussen door nul gaat (tileable, grijs)
function texCaustic() {
  const S = 256, c = mkCanvas(S), x = c.getContext('2d'), img = x.createImageData(S, S), d = img.data;
  const waves = [[2, 3, 1.0, 0.0], [-3, 2, 0.8, 1.3], [4, -1, 0.6, 2.1], [1, 5, 0.5, 0.7], [-2, -4, 0.45, 2.9]];
  for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
    const u = xx / S, v = y / S; let h = 0; for (const [a, b, amp, ph] of waves) h += amp * Math.sin(2 * PI * (a * u + b * v) + ph);
    const k = Math.pow(1 - Math.min(1, Math.abs(h) / 1.1), 5) * 255, i = (y * S + xx) * 4; d[i] = d[i + 1] = d[i + 2] = k; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0); return c;
}
// schuimvlekken (grijs, tileable): zachte blobs
function texFoam() {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), R = rng(57); x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
  for (let i = 0; i < 240; i++) { const r = 3 + R() * 9, cx = R() * S, cy = R() * S, a = 0.5 + R() * 0.5; for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) { const g = x.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(cx + ox - r, cy + oy - r, 2 * r, 2 * r); } }
  return c;
}
function texSpeckle(base, a, b, n = 2500) {
  const S = 256, c = mkCanvas(S), x = c.getContext('2d'), R = rng(13);
  x.fillStyle = base; x.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) { x.fillStyle = R() < .5 ? a : b; const r = 0.6 + R() * 1.3; x.beginPath(); x.arc(R() * S, R() * S, r, 0, PI * 2); x.fill(); }
  return c;
}
// graspol: enkele halmen met alpha
function texTuft() {
  const W = 128, H = 256, c = mkCanvas(W, H), x = c.getContext('2d'), R = rng(21);
  for (let b = 0; b < 17; b++) {
    const x0 = W * (0.15 + R() * 0.7), top = H * (0.02 + R() * 0.3), bend = (R() - .5) * 50, w0 = 2.5 + R() * 3.5, hue = 78 + R() * 14, l0 = 17 + R() * 4, l1 = 24 + R() * 6;
    const g = x.createLinearGradient(0, H, 0, top); g.addColorStop(0, hsl(hue, 30, l0)); g.addColorStop(1, hsl(hue + 4, 32, l1)); x.fillStyle = g;
    x.beginPath(); x.moveTo(x0 - w0 / 2, H);
    x.quadraticCurveTo(x0 + bend * 0.3 - w0 / 4, (H + top) / 2, x0 + bend, top);
    x.quadraticCurveTo(x0 + bend * 0.3 + w0 / 4, (H + top) / 2, x0 + w0 / 2, H); x.closePath(); x.fill();
  }
  return c;
}
// gazon-ondergrond: gemaaid gras, laagfrequente vlekken (geler / donkerder, 1-3 m) en fijne korrel; tegel = 4 x 4 m
function texLawn() {
  const S = 512, c = mkCanvas(S), x = c.getContext('2d'), R = rng(77);
  x.fillStyle = '#44602c'; x.fillRect(0, 0, S, S);
  const patch = (cx, cy, r, col, a) => { for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S], [S, S], [-S, -S], [S, -S], [-S, S]]) { const g = x.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r); g.addColorStop(0, col + a + ')'); g.addColorStop(1, col + '0)'); x.fillStyle = g; x.fillRect(cx + ox - r, cy + oy - r, 2 * r, 2 * r); } };
  for (let i = 0; i < 16; i++) patch(R() * S, R() * S, S * (0.12 + R() * 0.22), R() < 0.5 ? 'rgba(96,110,52,' : 'rgba(48,74,30,', 0.3 + R() * 0.3);
  for (let i = 0; i < 9; i++) patch(R() * S, R() * S, S * (0.04 + R() * 0.07), 'rgba(118,112,60,', 0.16 + R() * 0.16);   // dorre plekjes
  for (let i = 0; i < 2600; i++) { x.fillStyle = hsl(80 + R() * 16, 28 + R() * 12, 18 + R() * 16, 0.35); x.fillRect(R() * S, R() * S, 1 + R() * 2, 2 + R() * 4); }
  noise(x, S, S, S * 5, 0.05, R);
  return c;
}
// berkenbast: wit-grijs met donkere horizontale lenticellen en wat zwarte plekken onderin
function texBirch() {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), R = rng(91);
  x.fillStyle = '#d9d6cf'; x.fillRect(0, 0, S, S); noise(x, S, S, 700, 0.07, R);
  for (let i = 0; i < 26; i++) { x.fillStyle = `rgba(40,36,34,${(0.45 + R() * 0.45).toFixed(2)})`; x.fillRect(R() * S, R() * S, 8 + R() * 36, 1 + R() * 2); }
  for (let i = 0; i < 5; i++) { x.fillStyle = 'rgba(36,32,30,.55)'; x.beginPath(); x.ellipse(R() * S, S * (0.7 + R() * 0.3), 6 + R() * 10, 3 + R() * 6, 0, 0, PI * 2); x.fill(); }
  return c;
}
// bladkaart: lichte blaadjes (instanceColor kleurt ze)
function texLeaf(kind = 'leaf') {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), R = rng(kind === 'leaf' ? 31 : 37);
  const n = kind === 'leaf' ? 5 : 9;
  for (let i = 0; i < n; i++) {
    const cx = S * (0.2 + R() * 0.6), cy = S * (0.2 + R() * 0.6), rot = R() * PI, rx = kind === 'leaf' ? S * (0.16 + R() * 0.1) : S * (0.07 + R() * 0.05), ry = kind === 'leaf' ? rx * (0.45 + R() * 0.2) : rx;
    const g = x.createRadialGradient(cx - rx * 0.3, cy - ry * 0.3, 0, cx, cy, rx); const l = 205 + R() * 40; g.addColorStop(0, `rgb(${l + 20},${l + 20},${l + 20})`); g.addColorStop(1, `rgb(${l - 50},${l - 50},${l - 50})`);
    x.save(); x.translate(cx, cy); x.rotate(rot); x.fillStyle = g; x.beginPath(); x.ellipse(0, 0, rx, ry, 0, 0, PI * 2); x.fill();
    if (kind === 'leaf') { x.strokeStyle = 'rgba(90,90,90,.5)'; x.lineWidth = 1.2; x.beginPath(); x.moveTo(-rx * 0.9, 0); x.lineTo(rx * 0.9, 0); x.stroke(); }
    x.restore();
  }
  return c;
}
// water: tileable normal map uit een som van sinussen
function texWaterNormal() {
  const S = 256, c = mkCanvas(S), x = c.getContext('2d'), img = x.createImageData(S, S), d = img.data;
  const waves = [[3, 2, 1.0, 0.3], [-2, 5, 0.7, 1.1], [6, -1, 0.45, 2.0], [1, -7, 0.18, 0.6], [9, 4, 0.1, 2.9], [-5, -6, 0.3, 1.7], [2, 3, 0.5, 4.1]];
  const h = (u, v) => { let s = 0; for (const [a, b, amp, ph] of waves) s += amp * Math.sin(2 * PI * (a * u + b * v) + ph); return s; };
  const e = 1 / S, k = 0.55;
  for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
    const u = xx / S, v = y / S, dx = (h(u + e, v) - h(u - e, v)) * k, dy = (h(u, v + e) - h(u, v - e)) * k, l = Math.sqrt(dx * dx + dy * dy + 1), i = (y * S + xx) * 4;
    d[i] = 128 + (-dx / l) * 127; d[i + 1] = 128 + (-dy / l) * 127; d[i + 2] = 128 + (1 / l) * 127; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0); return c;
}
function texSoft(wispy) {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), R = rng(41);
  const blob = (cx, cy, r, a) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(255,255,255,${a * 0.35})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, S, S); };
  if (!wispy) blob(S / 2, S / 2, S / 2, 1);
  else { blob(S / 2, S / 2, S * 0.42, 0.55); for (let i = 0; i < 7; i++) blob(S * (0.3 + R() * 0.4), S * (0.3 + R() * 0.4), S * (0.12 + R() * 0.16), 0.35); }
  return c;
}
function texBubble() {
  const S = 64, c = mkCanvas(S), x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S / 2); g.addColorStop(0, 'rgba(255,255,255,.15)'); g.addColorStop(0.8, 'rgba(255,255,255,.75)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, S, S);
  const h = x.createRadialGradient(S * 0.38, S * 0.36, 0, S * 0.38, S * 0.36, S * 0.16); h.addColorStop(0, 'rgba(255,255,255,.9)'); h.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = h; x.fillRect(0, 0, S, S);
  return c;
}
function texMulch() {
  const S = 256, c = mkCanvas(S), x = c.getContext('2d'), R = rng(51);
  x.fillStyle = '#3a2a1e'; x.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) { x.save(); x.translate(R() * S, R() * S); x.rotate(R() * PI); x.fillStyle = hsl(20 + R() * 14, 25 + R() * 20, 12 + R() * 16); x.fillRect(-3 - R() * 6, -1 - R() * 2, 6 + R() * 12, 2 + R() * 4); x.restore(); }
  noise(x, S, S, 1500, 0.1, R); return c;
}
function texStone() {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), R = rng(61);
  x.fillStyle = '#75746f'; x.fillRect(0, 0, S, S); noise(x, S, S, 900, 0.07, R);
  for (let i = 0; i < 6; i++) { const g = x.createRadialGradient(R() * S, R() * S, 0, S / 2, S / 2, S * 0.7); g.addColorStop(0, R() < .5 ? 'rgba(92,90,84,.35)' : 'rgba(118,116,110,.3)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, S, S); }
  for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(58,56,52,.25)'; x.beginPath(); x.arc(R() * S, R() * S, 0.6 + R() * 1.2, 0, PI * 2); x.fill(); }
  return c;
}
function texWicker() {
  const S = 128, c = mkCanvas(S), x = c.getContext('2d'), hc = mkCanvas(S), hx = hc.getContext('2d'), n = 8, w = S / n;
  x.fillStyle = '#2f3032'; x.fillRect(0, 0, S, S); hx.fillStyle = '#404040'; hx.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const over = (i + j) % 2 === 0; x.fillStyle = over ? '#46484b' : '#3a3c3f'; hx.fillStyle = over ? '#c0c0c0' : '#808080';
    if (over) { x.fillRect(i * w + 1, j * w, w - 2, w); hx.fillRect(i * w + 1, j * w, w - 2, w); } else { x.fillRect(i * w, j * w + 1, w, w - 2); hx.fillRect(i * w, j * w + 1, w, w - 2); }
  }
  return { map: c, nor: normalFromHeight(hc, 1.5) };
}
function texFlat(color, n = 1200, amp = 0.06) { const S = 128, c = mkCanvas(S), x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, S, S); noise(x, S, S, n, amp, rng(71)); return c; }

/* =====================================================================================================
 *  GEOMETRIE-HULP: samenvoegen per materiaal (één mesh per sleutel), afgeronde vormen
 * ===================================================================================================== */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(), _m3 = new THREE.Matrix3();
class Merger {
  constructor() { this.m = new Map(); }
  b(k) { let x = this.m.get(k); if (!x) { x = { p: [], n: [], u: [], c: [] }; this.m.set(k, x); } return x; }
  // quad a-b-c-d; ctr: naar buiten gericht t.o.v. dit punt; col [r,g,b]
  quad(k, a, b, c, d, ctr, col = [1, 1, 1], uvs = null) {
    _a.subVectors(b, a); _b.subVectors(c, a); _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) { _a.subVectors(c, b); _b.subVectors(d, b); _n.crossVectors(_a, _b); if (_n.lengthSq() < 1e-12) return; }
    _c.copy(a).add(b).add(c).add(d).multiplyScalar(0.25);
    if (ctr && _n.dot(_a.subVectors(_c, ctr)) < 0) { const t = b; b = d; d = t; _n.negate(); if (uvs) uvs = [uvs[0], uvs[3], uvs[2], uvs[1]]; }
    _n.normalize();
    const B = this.b(k), ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z), vs = [a, b, c, a, c, d], us = uvs && [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]];
    for (let i = 0; i < 6; i++) {
      const v = vs[i]; B.p.push(v.x, v.y, v.z); B.n.push(_n.x, _n.y, _n.z); B.c.push(col[0], col[1], col[2]);
      if (us) B.u.push(us[i][0], us[i][1]); else if (ax >= ay && ax >= az) B.u.push(v.z, v.y); else if (ay >= az) B.u.push(v.x, v.z); else B.u.push(v.x, v.y);
    }
  }
  prism(keys, c, col) {
    const ctr = new THREE.Vector3(); for (const v of c) ctr.add(v); ctr.multiplyScalar(1 / 8);
    const k = f => typeof keys === 'string' ? keys : (keys[f] || keys.def);
    this.quad(k('ny'), c[0], c[1], c[2], c[3], ctr, col); this.quad(k('py'), c[4], c[5], c[6], c[7], ctr, col);
    this.quad(k('nz'), c[0], c[1], c[5], c[4], ctr, col); this.quad(k('px'), c[1], c[2], c[6], c[5], ctr, col);
    this.quad(k('pz'), c[2], c[3], c[7], c[6], ctr, col); this.quad(k('nx'), c[3], c[0], c[4], c[7], ctr, col);
  }
  box(keys, x0, x1, y0, y1, z0, z1, col) {
    if (x1 - x0 < 1e-5 || y1 - y0 < 1e-5 || z1 - z0 < 1e-5) return;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    this.prism(keys, [V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1)], col);
  }
  // willekeurige geometrie met matrix
  geo(k, g, m, col = [1, 1, 1]) {
    const G = g.index ? g.toNonIndexed() : g, P = G.attributes.position, N = G.attributes.normal, U = G.attributes.uv, B = this.b(k);
    _m3.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      _a.fromBufferAttribute(P, i).applyMatrix4(m); B.p.push(_a.x, _a.y, _a.z);
      if (N) _b.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize(); else _b.set(0, 1, 0); B.n.push(_b.x, _b.y, _b.z);
      B.c.push(col[0], col[1], col[2]); if (U) B.u.push(U.getX(i), U.getY(i)); else B.u.push(0, 0);
    }
    if (G !== g) G.dispose();
  }
  // ruwe driehoeken met eigen normalen: tri = [[x,y,z]x3], nrm = [[x,y,z]x3], uv = [[u,v]x3]
  tri(k, p, n, u, col = [1, 1, 1]) {
    _a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]); _b.set(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]); _n.crossVectors(_a, _b);
    const flip = _n.x * n[0][0] + _n.y * n[0][1] + _n.z * n[0][2] < 0, order = flip ? [0, 2, 1] : [0, 1, 2], B = this.b(k);
    for (const i of order) { B.p.push(p[i][0], p[i][1], p[i][2]); B.n.push(n[i][0], n[i][1], n[i][2]); B.u.push(u[i][0], u[i][1]); B.c.push(col[0], col[1], col[2]); }
  }
  build(cb) {
    for (const [k, x] of this.m) {
      if (!x.p.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(x.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(x.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(x.u, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(x.c, 3));
      g.computeBoundingSphere(); g.computeBoundingBox(); cb(k, g);
    }
    this.m.clear();
  }
}
const M4 = () => new THREE.Matrix4();
const place = (x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
// cilinder tussen twee punten
function cylBetween(mg, k, a, b, r, col) {
  const d = new THREE.Vector3().subVectors(b, a), l = d.length(), mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  mg.geo(k, new THREE.CylinderGeometry(r, r, l, 8), new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), col);
}
// omtrek van een vierkant met afgeschuinde hoeken (halve breedte h, afschuining c): punten {x, z, nx, nz, s}, met de klok mee
// vanaf de achterzijde (-z); nx/nz = buitennormaal van het segment dat bij het punt begint, s = omtrekpositie 0..1
function octRing(h, c, k = 6) {
  const P = [[-h + c, -h], [h - c, -h], [h, -h + c], [h, h - c], [h - c, h], [-h + c, h], [-h, h - c], [-h, -h + c]], L = P.map((p, i) => Math.hypot(P[(i + 1) % 8][0] - p[0], P[(i + 1) % 8][1] - p[1])), per = L.reduce((a, b) => a + b, 0), out = [];
  let s = 0;
  for (let i = 0; i < 8; i++) {
    const p = P[i], q = P[(i + 1) % 8], n = i % 2 ? 1 : k, dx = q[0] - p[0], dz = q[1] - p[1], l = L[i], nx = dz / l, nz = -dx / l;
    for (let j = 0; j < n; j++) { const t = j / n; out.push({ x: p[0] + dx * t, z: p[1] + dz * t, nx, nz, s: (s + l * t) / per }); }
    s += l;
  }
  return out;
}
// afgeronde doos (w x h x d, straal r), gecentreerd
function rbox(w, h, d, r) {
  const sh = new THREE.Shape(); const hw = w / 2 - r, hd = d / 2 - r;
  sh.moveTo(-hw, -hd - r); sh.lineTo(hw, -hd - r); sh.absarc(hw, -hd, r, -PI / 2, 0, false); sh.lineTo(hw + r, hd); sh.absarc(hw, hd, r, 0, PI / 2, false); sh.lineTo(-hw, hd + r); sh.absarc(-hw, hd, r, PI / 2, PI, false); sh.lineTo(-hw - r, -hd); sh.absarc(-hw, -hd, r, PI, 1.5 * PI, false);
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, h - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.999, bevelSegments: 3, curveSegments: 6 });
  g.rotateX(-PI / 2); g.translate(0, -(h - 2 * r) / 2 - r + r, 0); g.computeBoundingBox(); const bb = g.boundingBox; g.translate(0, -(bb.min.y + bb.max.y) / 2, 0); return g;
}

/* =====================================================================================================
 *  INSTALL
 * ===================================================================================================== */
// The heavy procedural textures don't need the house, so they are made while the module waits for HOUSE, one per poll (each
// its own short task), instead of all inside install(), which froze the page for ~0.5 s; install() makes any not made yet
const EARLY = {
  water: texWaterNormal, deck: () => texWood(1, 28, 22, 36, 6, { gap: 3 }), teak: () => texWood(2, 32, 48, 50, 5, { gap: 1, knots: false }),
  clad: () => texWood(3, 24, 26, 24, 8, { gap: 2, rabat: true }), cab: () => texWood(4, 210, 4, 40, 6, { gap: 2, knots: false }),
  cover: texCover, wicker: texWicker, caustic: texCaustic, foam: texFoam, lawn: texLawn, mulch: texMulch, stone: texStone,
}, early = {};
const made = k => early[k] ??= EARLY[k]();
// vaste maten (modelcoördinaten, meters; zie EXTERIOR-NOTES: jacuzzi x −0.3…2.75, z −9.9…−6.9)
const JX = 1.22, JZ = -8.40, TUB_H = 1.09, RIM_R = 0.22;
const DECK = { x0: -0.28, x1: 2.72, z0: -9.9, z1: -6.9, h: 0.08 };
const RIM_Y = DECK.h + 0.90, WATER_Y = RIM_Y - 0.11, FLOOR_Y = RIM_Y - 0.80;
const SHED = { x0: 6.0, x1: 9.4, z0: -10.9, z1: -8.4, h: 2.3 }, STRIP = { x0: 7.7, x1: 9.3, z0: -15.1, z1: -10.9, h: 2.1 };
const HEDGE = { a: [-1.1, -10.1], b: [6.0, -10.5], w: 0.6, h: 1.8 };
// voortuin: grind, border en straat komen uit frontgarden.js; hier geen gazon, hagen of boom meer aan de voorkant
const FRONT_LAWNS = [];
const BEDS = [[-0.3, 2.0, -5.1, -3.35], [-0.85, -0.3, -6.9, -3.0], [2.75, 5.95, -9.9, -7.7], [8.7, 9.3, -8.3, -3.4]];
const STONES1 = [[2.75, -3.65], [2.55, -4.3], [2.3, -4.95], [2.0, -5.55], [1.45, -5.95]];
const STONES2 = Array.from({ length: 8 }, (_, i) => { const t = i / 7; return [6.3 + 0.85 * t + 0.25 * Math.sin(PI * t), -3.6 - 4.55 * t]; });
const BOLLARDS = [[3.15, -4.05], [2.75, -5.65], [6.85, -4.8], [7.8, -7.0], [0.05, -6.5]];

export function install(H) {
  const scene = H.scene, camera = H.camera, renderer = H.renderer, canvas = renderer.domElement;
  const onTick = typeof H.onTick === 'function' ? H.onTick : fn => { let last = performance.now(); const f = t => { fn(Math.min(0.05, (t - last) / 1000)); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return () => { }; };
  const getMode = () => (typeof H.mode === 'string' ? H.mode : 'walk');
  const root = new THREE.Group(); root.name = 'tuin-module';
  if (typeof H.addToRoom === 'function') H.addToRoom('tuin', root); else scene.add(root);
  const addCol = (x0, x1, z0, z1) => { const c = H.colliders && H.colliders[0]; if (Array.isArray(c)) c.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1)]); };

  /* ---- host-placeholders (schuurdozen) weghalen ---- */
  hideHostShed(H); hideHostTrees(H);

  /* ---- texturen + materialen ---- */
  const deckW = made('deck'), teakW = made('teak'), cladW = made('clad');
  const coverT = made('cover'), wickT = made('wicker'), cabW = made('cab');
  const caustT = tex(made('caustic'), 1, 1, false), foamT = tex(made('foam'), 1, 1, false);
  const uPhase = { value: 0 }, uAgit = { value: 0 }, uLed = { value: new THREE.Color(0, 0, 0) };   // water/schaal: fase, roering (bubbels), LED-kleur
  const MSM = THREE.MeshStandardMaterial, MPM = THREE.MeshPhysicalMaterial;
  const mat = {
    deck: new MSM({ map: tex(deckW.map, 2.4, 0.84), normalMap: tex(deckW.nor, 2.4, 0.84, false), normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.85 }),
    teak: new MSM({ map: tex(teakW.map, 1.2, 0.5), normalMap: tex(teakW.nor, 1.2, 0.5, false), normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.6 }),
    clad: new MSM({ map: tex(cladW.map, 2.2, 1.16), normalMap: tex(cladW.nor, 2.2, 1.16, false), normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.9 }),
    cladDark: new MSM({ map: tex(cladW.map, 2.2, 1.16), color: '#6a6a6a', roughness: 0.95 }),
    cabinet: new MSM({ map: tex(cabW.map, 1.6, 1), normalMap: tex(cabW.nor, 1.6, 1, false), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.82 }),
    pillow: new MSM({ color: '#8d9195', roughness: 0.75 }),
    shell: new MPM({ map: tex(texSpeckle('#e2e5e4', '#cfd4d3', '#f4f6f5'), 0.5), roughness: 0.2, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 1.1 }),
    water: new MPM({ color: '#a9dde8', transparent: true, opacity: 0.3, roughness: 0.06, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.05, envMapIntensity: 1.2, depthWrite: false, emissive: '#15b0d6', emissiveIntensity: 0, side: THREE.DoubleSide }),
    coverTop: new MSM({ map: tex(coverT.map, 1, 1), normalMap: tex(coverT.nor, 1, 1, false), normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.6 }),
    vinyl: new MSM({ color: '#53575b', roughness: 0.7 }), vinylDark: new MSM({ color: '#2d2f32', roughness: 0.55 }),
    chrome: new MSM({ color: '#d9dbdd', metalness: 0.95, roughness: 0.18 }), alu: new MSM({ color: '#34363a', metalness: 0.65, roughness: 0.42 }),
    epdm: new MSM({ map: tex(texFlat('#36383b', 2000, 0.08), 1.5), roughness: 0.92 }), fascia: new MSM({ color: '#26282a', roughness: 0.45 }),
    zinc: new MSM({ color: '#a2a7aa', metalness: 0.75, roughness: 0.32 }), frameDark: new MSM({ color: '#2a2c2e', roughness: 0.5 }),
    glassDark: new MPM({ color: '#18232a', roughness: 0.06, metalness: 0.25, clearcoat: 1 }),
    concrete: new MSM({ map: tex(texFlat('#a3a29c', 1800, 0.1), 0.7), roughness: 0.95 }), stone: new MSM({ map: tex(made('stone'), 1), roughness: 0.9 }),
    mulch: new MSM({ map: tex(made('mulch'), 0.8), roughness: 1 }), lawn: new MSM({ map: tex(made('lawn'), 4, 4), roughness: 1 }), bark: new MSM({ color: '#4d3e32', roughness: 0.95 }), birch: new MSM({ map: tex(texBirch(), 1, 1), roughness: 0.85 }),
    colored: new MSM({ vertexColors: true, roughness: 0.9 }),
    wicker: new MSM({ map: tex(wickT.map, 0.18), normalMap: tex(wickT.nor, 0.18, 0.18, false), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.8 }),
    cushion: new MSM({ map: tex(texFlat('#cbc7be', 1500, 0.07), 0.6), roughness: 0.95 }), accent: new MSM({ map: tex(texFlat('#b3863a', 1500, 0.07), 0.6), roughness: 0.95 }),
    canopy: new MSM({ color: '#595751', roughness: 0.92, side: THREE.DoubleSide }), granite: new MSM({ map: tex(texSpeckle('#55575a', '#2e3033', '#8d9094', 4000), 0.9), roughness: 0.7 }),
    bulb: new MSM({ color: '#f6d9a8', emissive: '#ffb45a', emissiveIntensity: 0, roughness: 0.3 }), bollardLight: new MSM({ color: '#efe6d6', emissive: '#ffc784', emissiveIntensity: 0, roughness: 0.6 }),
    led: new MSM({ color: '#bfeff7', emissive: '#19c6e8', emissiveIntensity: 0, roughness: 0.3 }),
    pot: new MSM({ color: '#3b3d40', roughness: 0.85 }), barrel: new MSM({ color: '#3d453d', roughness: 0.8 }), black: new MSM({ color: '#111213', roughness: 0.55 }),
    wire: new THREE.LineBasicMaterial({ color: '#1b1b1b' }),
  };
  mat.coverTop.map.wrapS = mat.coverTop.map.wrapT = THREE.ClampToEdgeWrapping; mat.coverTop.normalMap.wrapS = mat.coverTop.normalMap.wrapT = THREE.ClampToEdgeWrapping;
  const cladV = mat.clad.clone(); cladV.map = mat.clad.map.clone(); cladV.map.rotation = PI / 2; cladV.map.center.set(0.5, 0.5); cladV.normalMap = mat.clad.normalMap.clone(); cladV.normalMap.rotation = PI / 2; cladV.normalMap.center.set(0.5, 0.5); mat.cladV = cladV;

  // water: twee bewegende normal-lagen + een fijne derde bij roering, schuim langs de wanden (jets) als de bubbels aanstaan,
  // Fresnel-opaciteit (spiegelend onder een schuine hoek). uPhase loopt sneller bij roering (geen fasesprong)
  const waterNor = tex(made('water'), 0.55, 0.55, false); mat.water.normalMap = waterNor; mat.water.normalScale.set(0.2, 0.2);
  mat.water.onBeforeCompile = sh => {
    sh.uniforms.uPhase = uPhase; sh.uniforms.uAgit = uAgit; sh.uniforms.uFoam = { value: foamT };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vJUv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvJUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uPhase, uAgit; uniform sampler2D uFoam; varying vec2 vJUv;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat jFoam = 0.0;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        { float ed = max(abs(vJUv.x), abs(vJUv.y)) / 0.93;
          float f1 = texture2D(uFoam, vJUv * 0.8 + vec2(uPhase * 0.05, -uPhase * 0.03)).r, f2 = texture2D(uFoam, vJUv * 1.5 - vec2(uPhase * 0.04, uPhase * 0.06)).r;
          jFoam = smoothstep(0.45, 0.9, f1 * f2 * 2.4 + 0.12 * uAgit) * uAgit * (0.3 + 0.7 * smoothstep(0.4, 0.85, ed));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.98, 0.99), jFoam); }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, jFoam);')
      .replace('texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0', '(texture2D( normalMap, vNormalMapUv + vec2(uPhase*0.021, uPhase*0.013) ).xyz + texture2D( normalMap, vNormalMapUv * 1.63 + vec2(-uPhase*0.017, uPhase*0.026) ).xyz - 1.0) + (texture2D( normalMap, vNormalMapUv * 3.3 + vec2(uPhase*0.09, -uPhase*0.12) ).xyz * 2.0 - 1.0) * uAgit * 0.9')
      .replace('#include <opaque_fragment>', `float jFr = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
        gl_FragColor = vec4(outgoingLight, clamp(diffuseColor.a + 0.35 * jFr + 0.8 * jFoam, 0.0, 1.0));`);
  };
  mat.water.customProgramCacheKey = () => 'garden-water';
  // schaal: onder de waterlijn blauwer naarmate het dieper is, bewegende caustieken, en 's avonds de LED-gloed
  mat.shell.onBeforeCompile = sh => {
    sh.uniforms.uPhase = uPhase; sh.uniforms.uAgit = uAgit; sh.uniforms.uLed = uLed; sh.uniforms.uCaust = { value: caustT }; sh.uniforms.uWaterY = { value: WATER_Y };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vJWP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvJWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uPhase, uAgit, uWaterY; uniform vec3 uLed; uniform sampler2D uCaust; varying vec3 vJWP;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        { float jd = uWaterY - vJWP.y;
          if (jd > 0.0) { float jf = clamp(jd / 0.75, 0.0, 1.0); vec2 cu = vJWP.xz * 1.4;
            float c1 = texture2D(uCaust, cu + vec2(uPhase * 0.035, uPhase * 0.028)).r, c2 = texture2D(uCaust, cu * 1.37 + vec2(-uPhase * 0.03, uPhase * 0.022)).r, ca = min(c1, c2) * 2.2;
            diffuseColor.rgb *= mix(vec3(1.0), vec3(0.6, 0.85, 0.93), 0.25 + 0.65 * jf) * (1.0 + ca * (0.35 + 0.3 * uAgit));
            totalEmissiveRadiance += uLed * (0.35 + 0.65 * ca) * smoothstep(0.0, 0.12, jd); } }`);
  };
  mat.shell.customProgramCacheKey = () => 'garden-shell';

  const statics = new Merger();            // alles wat nooit beweegt -> één mesh per materiaal
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const meshes = {};
  const api = { installed: true, root, mat, Q, ENV };
  // richtdoelen voor de host (interactOf): label/act worden in het interactieblok ingevuld
  const coverIt = { label: () => 'deksel ' + (api.cover.target === 2 ? 'dicht' : 'open'), act: null, on: () => api.cover.target === 2 };
  const bubblesIt = { label: () => (api.bubbles ? 'bubbels uit' : 'bubbels aan'), act: null, on: () => api.bubbles };

  /* =================================================== JACUZZI (Wellis Malaga) =================================================== */
  // kuip: vierkant met afgeschuinde hoeken; buitenring (kleine afschuining) voor rand en ombouw, binnenring (grote afschuining)
  // voor de schaal, zodat de hoekplateaus breder zijn (bekerhouders, bedieningspaneel) zoals bij de Malaga
  const jac = new THREE.Group(); root.add(jac);
  const RING_O = octRing(1, 0.24), RING_I = octRing(1, 0.5);
  {
    // vlonder + opstap
    const dk = { py: 'deck', def: 'fascia' };
    statics.box(dk, DECK.x0, DECK.x1, -0.01, DECK.h, DECK.z0, DECK.z1);
    statics.box(dk, 0.67, 1.77, 0, 0.22, -6.9, -6.2); statics.box(dk, 0.67, 1.77, 0.22, 0.44, -6.9, -6.5);
    addCol(DECK.x0, DECK.x1, DECK.z0, DECK.z1); addCol(0.67, 1.77, -6.9, -6.2);
    const sm = new Merger(), N = RING_O.length;
    // mantel: wand (ring r0 op hoogte y0, schaal h0) naar (r1, y1, h1); uv = (omtrek, hoogte)
    const loft = (k, r0, h0, y0, r1, h1, y1, uvf) => {
      const dh = h1 - h0, dy = y1 - y0;
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N, a0 = r0[i], a1 = r0[j], b0 = r1[i], b1 = r1[j];
        const n = p => { const v = new THREE.Vector3(a0.nx * dy, -dh, a0.nz * dy); return v.lengthSq() ? v.normalize().toArray() : [0, 1, 0]; };
        const P = (p, h, y) => [JX + p.x * h, y, JZ + p.z * h], s1 = a1.s || 1;
        sm.tri(k, [P(a0, h0, y0), P(a1, h0, y0), P(b1, h1, y1)], [n(), n(), n()], [uvf(a0.s, y0), uvf(s1, y0), uvf(s1, y1)]);
        sm.tri(k, [P(a0, h0, y0), P(b1, h1, y1), P(b0, h1, y1)], [n(), n(), n()], [uvf(a0.s, y0), uvf(s1, y1), uvf(a0.s, y1)]);
      }
    };
    // ombouw: grijze horizontale planken (HorizontSide), zwarte plint, antracieten hoekstijlen
    const cabUv = (s, y) => [s * 8.6, (y - DECK.h) / 0.93];
    loft('cabinet', RING_O, 1.085, DECK.h + 0.05, RING_O, 1.085, RIM_Y - 0.025, cabUv);
    loft('black', RING_O, 1.07, DECK.h, RING_O, 1.07, DECK.h + 0.05, cabUv);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = sx * 0.975, cz = sz * 0.975, ry = Math.atan2(sx, sz);                     // stijl midden op de afschuining
      sm.geo('black', new THREE.BoxGeometry(0.40, RIM_Y - 0.03 - DECK.h, 0.06), place(JX + cx, (RIM_Y - 0.03 + DECK.h) / 2, JZ + cz, ry));
      if (sx === 1 && sz === 1) { sm.geo('led', new THREE.BoxGeometry(0.1, 0.42, 0.012), place(JX + cx + 0.022, 0.62, JZ + cz + 0.022, ry)); for (const dy of [-0.07, 0.07]) sm.geo('chrome', new THREE.BoxGeometry(0.1, 0.004, 0.013), place(JX + cx + 0.023, 0.62 + dy, JZ + cz + 0.023, ry)); }
    }
    // schaal: rand (buitenring) -> binnenlip (binnenring) -> wand -> vloer
    const prof = [[RING_O, 1.09, RIM_Y - 0.045], [RING_O, 1.09, RIM_Y - 0.015], [RING_O, 1.075, RIM_Y], [RING_O, 0.985, RIM_Y], [RING_I, 0.955, RIM_Y - 0.006], [RING_I, 0.935, RIM_Y - 0.035], [RING_I, 0.925, RIM_Y - 0.3], [RING_I, 0.895, FLOOR_Y + 0.22], [RING_I, 0.855, FLOOR_Y + 0.05], [RING_I, 0.80, FLOOR_Y]];
    const shUv = (s, y) => [s * 7, y];
    for (let s = 0; s < prof.length - 1; s++) loft('shell', prof[s][0], prof[s][1], prof[s][2], prof[s + 1][0], prof[s + 1][1], prof[s + 1][2], shUv);
    const floorSh = new THREE.Shape(); RING_I.forEach((p, i) => i ? floorSh.lineTo(p.x * 0.8, p.z * 0.8) : floorSh.moveTo(p.x * 0.8, p.z * 0.8)); floorSh.closePath();
    const floor = new THREE.ShapeGeometry(floorSh); floor.rotateX(-PI / 2); sm.geo('shell', floor, place(JX, FLOOR_Y, JZ), [1, 1, 1]);
    // gevormde zitjes op verschillende diepte: hoekzitjes achter (hoog), middenzitje achter (dieper), zijzitjes, ligplek voor
    // (hoofd links, schuin aflopend naar de voeten rechts, rugleuning tegen de voorwand), filterhoek rechtsvoor
    const seat = (w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) => sm.geo('shell', rbox(w, h, d, 0.06), place(JX + x, y, JZ + z, ry, 1, rx, rz));
    seat(0.62, 0.40, 0.58, -0.64, FLOOR_Y + 0.20, -0.66); seat(0.62, 0.40, 0.58, 0.64, FLOOR_Y + 0.20, -0.66);
    seat(0.72, 0.32, 0.52, 0, FLOOR_Y + 0.16, -0.70);
    seat(0.52, 0.37, 0.78, -0.72, FLOOR_Y + 0.185, -0.05); seat(0.52, 0.37, 0.78, 0.72, FLOOR_Y + 0.185, -0.05);
    seat(1.45, 0.14, 0.62, -0.2, FLOOR_Y + 0.28, 0.62, 0, 0, -0.2); seat(1.3, 0.5, 0.14, -0.2, FLOOR_Y + 0.45, 0.84, 0, 0.25);
    seat(0.42, 0.55, 0.42, 0.70, FLOOR_Y + 0.275, 0.70);
    // hoofdsteunen (lichtgrijs), filterdeksel, bekerhouders
    const pillow = (x, y, z, ry) => sm.geo('pillow', rbox(0.32, 0.11, 0.055, 0.025), place(JX + x, y, JZ + z, ry));
    pillow(-0.62, RIM_Y - 0.085, -0.925, 0); pillow(0.62, RIM_Y - 0.085, -0.925, 0); pillow(-0.925, RIM_Y - 0.085, -0.05, PI / 2); pillow(0.925, RIM_Y - 0.085, -0.05, PI / 2); pillow(-0.62, RIM_Y - 0.085, 0.925, 0);
    sm.geo('pillow', new THREE.CylinderGeometry(0.1, 0.1, 0.02, 20), place(JX + 0.74, FLOOR_Y + 0.56, JZ + 0.74)); sm.geo('black', new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10), place(JX + 0.74, FLOOR_Y + 0.575, JZ + 0.74));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1]]) sm.geo('pillow', new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), place(JX + sx * 0.84, RIM_Y - 0.004, JZ + sz * 0.84));
    // jets: chroomring met donkere kern; de lage jets en de vloerjets voeden de bubbels
    const jets = [];
    const jet = (x, y, z, nx, ny, nz, bub) => {
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(nx, ny, nz).normalize()), m = new THREE.Matrix4().compose(V(JX + x, y, JZ + z), q, V(1, 1, 1));
      sm.geo('chrome', new THREE.CylinderGeometry(0.034, 0.034, 0.012, 14), m); sm.geo('black', new THREE.CylinderGeometry(0.019, 0.019, 0.014, 10), m);
      if (bub) jets.push([JX + x + nx * 0.03, y + ny * 0.03, JZ + z + nz * 0.03]);
    };
    for (const sx of [-1, 1]) { for (const [dx, y] of [[-0.14, 0.76], [0, 0.76], [0.14, 0.76], [-0.07, 0.66], [0.07, 0.66]]) jet(sx * 0.62 + dx, y, -0.925, 0, 0, 1, y < 0.7); }
    jet(-0.13, 0.62, -0.925, 0, 0, 1, true); jet(0.13, 0.62, -0.925, 0, 0, 1, true); jet(0, 0.73, -0.925, 0, 0, 1, false);
    for (const sx of [-1, 1]) { jet(sx * 0.925, 0.66, -0.22, -sx, 0, 0, true); jet(sx * 0.925, 0.66, 0.12, -sx, 0, 0, true); jet(sx * 0.925, 0.76, -0.05, -sx, 0, 0, false); }
    for (const dx of [-0.85, -0.72, -0.59]) { jet(dx, 0.75, 0.925, 0, 0, -1, false); jet(dx, 0.65, 0.925, 0, 0, -1, true); }
    for (const [dx, y] of [[0.0, 0.42], [0.18, 0.42], [0.0, 0.52], [0.18, 0.52]]) jet(dx, y, 0.925, 0, 0, -1, true);
    for (const [dx, dz] of [[0, -0.15], [-0.2, 0.1], [0.2, 0.1]]) jet(dx, FLOOR_Y + 0.004, dz, 0, 1, 0, true);
    // waterval + fonteintjes op de achterrand, bedieningspaneel rechtsvoor, waterlijn-LED's en de grote LED
    sm.geo('chrome', new THREE.BoxGeometry(0.42, 0.03, 0.09), place(JX, RIM_Y + 0.015, JZ - 1.0)); sm.geo('chrome', new THREE.BoxGeometry(0.38, 0.03, 0.02), place(JX, RIM_Y - 0.03, JZ - 0.945));
    for (const dx of [-0.5, 0.5]) sm.geo('chrome', new THREE.CylinderGeometry(0.02, 0.02, 0.016, 10), place(JX + dx, RIM_Y + 0.006, JZ - 1.02));
    sm.geo('black', rbox(0.2, 0.03, 0.11, 0.012), place(JX + 0.84, RIM_Y + 0.014, JZ + 0.84, -PI / 4, 1, 0.12)); sm.geo('glassDark', new THREE.BoxGeometry(0.12, 0.002, 0.05), place(JX + 0.84, RIM_Y + 0.031, JZ + 0.84, -PI / 4, 1, 0.12));
    for (let i = 0; i < N; i += 2) { const p = RING_I[i]; sm.geo('led', new THREE.CylinderGeometry(0.011, 0.011, 0.006, 8), new THREE.Matrix4().compose(V(JX + p.x * 0.93, WATER_Y - 0.035, JZ + p.z * 0.93), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(-p.nx, 0, -p.nz)), V(1, 1, 1))); }
    sm.geo('led', new THREE.CylinderGeometry(0.05, 0.05, 0.008, 16), place(JX, 0.42, JZ + 0.92, 0, 1, PI / 2));
    sm.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = k === 'shell' || k === 'cabinet' || k === 'black'; m.receiveShadow = true; jac.add(m); meshes[k] = m; if (k === 'shell' || k === 'cabinet' || k === 'black') m.userData.interact = coverIt; });
    const ledLight = new THREE.PointLight('#1fc8ec', 0, 3.2, 1.6); ledLight.position.set(JX, WATER_Y - 0.35, JZ); jac.add(ledLight);
    // water (vlak van de binnenring; uv = lokale xz voor schuim en wandafstand)
    const wsh = new THREE.Shape(); RING_I.forEach((p, i) => i ? wsh.lineTo(p.x * 0.935, p.z * 0.935) : wsh.moveTo(p.x * 0.935, p.z * 0.935)); wsh.closePath();
    const wg = new THREE.ShapeGeometry(wsh); wg.rotateX(-PI / 2);
    const water = new THREE.Mesh(wg, mat.water); water.position.set(JX, WATER_Y, JZ); water.renderOrder = 2; water.userData.interact = bubblesIt; jac.add(water); meshes.water = water;
    // bubbels + stoom (instanced billboards)
    const partVS = `attribute vec3 aSeed; uniform float uTime, uRise, uSpeed; uniform int uKind; varying float vA; varying vec2 vUv;
      void main(){ vUv = uv; vec3 o = instancePos(); float t = fract(uTime * uSpeed * aSeed.y + aSeed.x); vec3 p = o; float sz;
        if (uKind == 0) { p.y += t * (uRise - o.y); p.x += sin(uTime*4.0 + aSeed.x*40.0)*0.012*t; p.z += cos(uTime*3.1 + aSeed.x*33.0)*0.012*t; vA = 0.85 * (1.0 - smoothstep(0.82, 1.0, t)); sz = 0.014 + 0.028 * aSeed.z; }
        else { p.y += t * uRise; p.x += (aSeed.z - 0.5) * 0.5 * t + sin(uTime*0.6 + aSeed.x*9.0)*0.07*t; p.z += (aSeed.y - 0.7) * 0.4 * t + cos(uTime*0.5 + aSeed.x*7.0)*0.07*t; vA = 0.55 * smoothstep(0.0, 0.14, t) * (1.0 - t) * (1.0 - t); sz = 0.22 + 0.55 * t; }
        vec4 mv = modelViewMatrix * vec4(p, 1.0); mv.xy += position.xy * sz; gl_Position = projectionMatrix * mv; }`;
    const partFS = `uniform sampler2D uMap; uniform vec3 uColor; uniform float uAmount; varying float vA; varying vec2 vUv; void main(){ vec4 t = texture2D(uMap, vUv); gl_FragColor = vec4(uColor, t.a * vA * uAmount); }`;
    function particles(kind, n, R, originFn, map) {
      const g = new THREE.InstancedBufferGeometry(); const base = new THREE.PlaneGeometry(1, 1); g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
      const org = new Float32Array(n * 3), seed = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const o = originFn(i); org.set(o, i * 3); seed.set([R(), 0.6 + R() * 0.8, R()], i * 3); }
      g.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(org, 3)); g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3)); g.instanceCount = n;
      g.boundingSphere = new THREE.Sphere(V(JX, WATER_Y + 0.5, JZ), 2.5);
      const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uRise: { value: kind === 0 ? WATER_Y - 0.005 : 1.1 }, uSpeed: { value: kind === 0 ? 0.55 : 0.12 }, uKind: { value: kind }, uMap: { value: tex(map, 1, 1) }, uColor: { value: new THREE.Color(kind === 0 ? '#eaf6fa' : '#e9eef1') }, uAmount: { value: 1 } },
        vertexShader: 'attribute vec3 aOrigin; vec3 instancePos(){ return aOrigin; }\n' + partVS, fragmentShader: partFS, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
      const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = true; mesh.renderOrder = kind === 0 ? 1 : 3; return mesh;
    }
    const R = rng(77);
    const bubbles = particles(0, Q.bubbles, R, i => jets[i % jets.length], texBubble());
    const steam = particles(1, Q.steam, R, () => [JX + (R() - .5) * 1.5, WATER_Y, JZ + (R() - .5) * 1.5], texSoft(true));
    jac.add(bubbles, steam); meshes.bubbles = bubbles; meshes.steam = steam;
    // deksel: twee taps toelopende helften (dik bij het scharnier), scharnierstrook, dunne rokken, handgrepen en sluitbanden
    const W = 2.22, D = 1.11, T0 = 0.095, T1 = 0.065;
    function half(mg, flipV) {
      const uv = flipV ? [[0, 1], [1, 1], [1, 0], [0, 0]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
      const a = V(-W / 2, 0, 0), b = V(W / 2, 0, 0), c = V(W / 2, -(T0 - T1), D), d = V(-W / 2, -(T0 - T1), D), e = V(-W / 2, -T0, 0), f = V(W / 2, -T0, 0), g = V(W / 2, -T0, D), h = V(-W / 2, -T0, D), ctr = V(0, -T0 / 2, D / 2);
      mg.quad('coverTop', a, b, c, d, ctr, [1, 1, 1], uv);
      mg.quad('vinyl', e, f, g, h, ctr); mg.quad('vinyl', a, b, f, e, ctr); mg.quad('vinyl', d, c, g, h, ctr); mg.quad('vinyl', a, d, h, e, ctr); mg.quad('vinyl', b, c, g, f, ctr);
      for (const sx of [-1, 1]) mg.box('vinyl', sx * W / 2 + (sx > 0 ? 0 : -0.012), sx * W / 2 + (sx > 0 ? 0.012 : 0), -T0 - 0.10, -T0 + 0.002, 0, D + 0.012);   // rok zijkant
      mg.box('vinyl', -W / 2 - 0.012, W / 2 + 0.012, -T0 - 0.10, -T0 + 0.002, D, D + 0.012);                                                            // rok buitenrand
      for (const sx of [-1, 1]) mg.box('vinylDark', sx * (W / 2 - 0.45) - 0.025, sx * (W / 2 - 0.45) + 0.025, -T0 - 0.13, -T0 - 0.02, D + 0.012, D + 0.026);   // sluitbanden
      mg.box('vinylDark', -0.12, 0.12, -(T0 - T1) * 0.9 - 0.002, -(T0 - T1) * 0.9 + 0.012, D - 0.12, D - 0.05);                                           // handgreep
    }
    const pivot1 = new THREE.Group(), pivot2 = new THREE.Group(); pivot1.position.set(JX, RIM_Y + T0, JZ - D); pivot2.position.set(0, 0, D); pivot1.add(pivot2); jac.add(pivot1);
    const hm = new Merger(); half(hm, false); hm.box('vinylDark', -W / 2, W / 2, -0.004, 0.01, D - 0.06, D + 0.0); hm.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = m.receiveShadow = true; m.userData.interact = coverIt; pivot1.add(m); });
    const hm2 = new Merger(); half(hm2, true); hm2.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = m.receiveShadow = true; m.userData.interact = coverIt; pivot2.add(m); });
    // lifter: beugels laag aan de zijkanten, twee armen met dwarsstang; dicht: stang over het scharnier, open: achter de
    // kuip, waar het dubbelgevouwen deksel er schuin tegenaan rust
    const lifter = new THREE.Group(); lifter.position.set(JX, 0.35, JZ - 0.5); jac.add(lifter);
    const LIFT = { len: 0.95, a0: 0.63, a1: -1.3 };
    { const lg = new Merger(); for (const sx of [-1, 1]) cylBetween(lg, 'alu', V(sx * 1.12, 0, 0), V(sx * 1.12, LIFT.len, 0), 0.014); cylBetween(lg, 'alu', V(-1.12, LIFT.len, 0), V(1.12, LIFT.len, 0), 0.012);
      lg.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = true; lifter.add(m); });
      for (const sx of [-1, 1]) statics.geo('alu', new THREE.BoxGeometry(0.03, 0.2, 0.06), place(JX + sx * 1.105, 0.35, JZ - 0.5)); }
    const cover = { t: 0, target: 0, closed: { y: RIM_Y + T0, z: JZ - D }, open: { y: RIM_Y + 0.22, z: JZ - D - 0.1 }, lean: 0.17 };
    api.cover = cover; api.pivot1 = pivot1; api.pivot2 = pivot2; api.lifter = lifter; api.LIFT = LIFT;
    api.setCover = open => { cover.target = open ? 2 : 0; if (!open) api.setBubbles(false); };
    api.toggleCover = () => api.setCover(cover.target < 1);
    api.led = null; api.setLed = v => { api.led = v; };            // true/false of null = automatisch ('s avonds)
    api.jets = jets; api.ledLight = ledLight;
    addCol(SHED.x0, SHED.x1, SHED.z0, SHED.z1); addCol(STRIP.x0, STRIP.x1, STRIP.z0, STRIP.z1);
  }
  /* =================================================== SCHUURTJE =================================================== */
  function shed(S, opt) {
    const { x0, x1, z0, z1, h } = S, cb = 0.09, mg = statics, cl = opt.dark ? 'cladDark' : 'clad';
    mg.box('concrete', x0 + 0.02, x1 - 0.02, 0, 0.13, z0 + 0.02, z1 - 0.02);
    const wall = (xa, xb, ya, yb, za, zb) => mg.box(cl, xa, xb, ya, yb, za, zb);
    // wanden (dikte 0.08), gevel met opening(en) in losse stukken
    const front = opt.front; // { side: 'z1'|'x0', door: [a, b], win: [a, b, y0, y1] }
    const faces = [['z1', z1 - 0.08, z1], ['z0', z0, z0 + 0.08]];
    for (const [id, za, zb] of faces) {
      if (front && front.side === id) {
        const parts = []; let cur = x0; const ops = [front.door && { a: front.door[0], b: front.door[1], y0: 0.13, y1: 2.07 }, front.win && { a: front.win[0], b: front.win[1], y0: front.win[2], y1: front.win[3] }].filter(Boolean).sort((p, q) => p.a - q.a);
        for (const o of ops) { parts.push([cur, o.a, 0.13, h]); parts.push([o.a, o.b, 0.13, o.y0]); parts.push([o.a, o.b, o.y1, h]); cur = o.b; } parts.push([cur, x1, 0.13, h]);
        for (const [a, b, ya, yb] of parts) wall(a, b, ya, yb, za, zb);
      } else wall(x0, x1, 0.13, h, za, zb);
    }
    for (const [id, xa, xb] of [['x0', x0, x0 + 0.08], ['x1', x1 - 0.08, x1]]) {
      if (front && front.side === id && front.door) { const [a, b] = front.door; wall(xa, xb, 0.13, h, z0, Math.min(a, b)); wall(xa, xb, 0.13, h, Math.max(a, b), z1); wall(xa, xb, 2.07, h, Math.min(a, b), Math.max(a, b)); }
      else wall(xa, xb, 0.13, h, z0, z1);
    }
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) mg.box('fascia', cx - cb / 2, cx + cb / 2, 0.1, h, cz - cb / 2, cz + cb / 2);  // hoekprofielen
    // dak: lichte afschot naar de goot, boeiboord rondom, EPDM
    const o = 0.16, hi = h + 0.12, lo = h + 0.06, gz = opt.gutter === 'z1';
    const c = [V(x0 - o, h - 0.1, z0 - o), V(x1 + o, h - 0.1, z0 - o), V(x1 + o, h - 0.1, z1 + o), V(x0 - o, h - 0.1, z1 + o), V(x0 - o, gz ? hi : lo, z0 - o), V(x1 + o, gz ? hi : lo, z0 - o), V(x1 + o, gz ? lo : hi, z1 + o), V(x0 - o, gz ? lo : hi, z1 + o)];
    mg.prism({ py: 'epdm', ny: 'fascia', def: 'fascia' }, c);
    if (opt.gutter) {
      const gy = lo - 0.02, gzc = gz ? z1 + o + 0.06 : z0 - o - 0.06;
      cylBetween(mg, 'zinc', V(x0 - o, gy, gzc), V(x1 + o, gy, gzc), 0.055);
      cylBetween(mg, 'zinc', V(x0 - o + 0.05, gy, gzc), V(x0 - o + 0.05, 0.95, gzc), 0.035);                    // regenpijp naar de regenton
      mg.geo('barrel', new THREE.CylinderGeometry(0.3, 0.27, 0.9, 18), place(x0 + 0.22, 0.45, gzc + 0.3)); mg.geo('black', new THREE.CylinderGeometry(0.31, 0.31, 0.04, 18), place(x0 + 0.22, 0.91, gzc + 0.3));
      addCol(x0 - 0.1, x0 + 0.55, gzc, gzc + 0.62);
    }
    // deur: kozijn, plankendeur, scharnieren, knop
    if (front && front.door) {
      const [a, b] = front.door, fw = 0.07, d0 = 0.13, d1 = 2.07;
      const Zf = (xa, xb, ya, yb, inset) => front.side === 'z1' ? mg.box('frameDark', xa, xb, ya, yb, z1 - 0.1, z1 - inset) : mg.box('frameDark', x0 + inset, x0 + 0.1, ya, yb, xa, xb);
      Zf(a, a + fw, d0, d1 + fw, 0); Zf(b - fw, b, d0, d1 + fw, 0); Zf(a, b, d1, d1 + fw, 0);
      const leaf = front.side === 'z1' ? (k, xa, xb, ya, yb, za, zb) => mg.box(k, xa, xb, ya, yb, z1 - 0.09 + za, z1 - 0.09 + zb) : (k, xa, xb, ya, yb, za, zb) => mg.box(k, x0 + 0.09 - zb, x0 + 0.09 - za, ya, yb, xa, xb);
      leaf('cladV', a + fw, b - fw, d0 + 0.01, d1 - 0.005, 0, 0.04);
      for (const hy of [0.45, 1.1, 1.75]) leaf('black', a + fw + 0.02, a + fw + 0.34, hy - 0.02, hy + 0.02, 0.04, 0.052);
      leaf('black', b - fw - 0.09, b - fw - 0.05, 1.0, 1.04, 0.04, 0.09); leaf('chrome', b - fw - 0.1, b - fw - 0.05, 0.88, 0.97, 0.04, 0.046);
    }
    if (front && front.win) {
      const [a, b, y0, y1] = front.win, fw = 0.06, zf = z1 - 0.1, zb = z1 - 0.02;
      mg.box('frameDark', a - fw, b + fw, y0 - fw, y0, zf, zb); mg.box('frameDark', a - fw, b + fw, y1, y1 + fw, zf, zb); mg.box('frameDark', a - fw, a, y0, y1, zf, zb); mg.box('frameDark', b, b + fw, y0, y1, zf, zb);
      mg.box('frameDark', (a + b) / 2 - 0.02, (a + b) / 2 + 0.02, y0, y1, zf, zb); mg.box('glassDark', a, b, y0, y1, z1 - 0.065, z1 - 0.055);
    }
  }
  shed(SHED, { front: { side: 'z1', door: [6.62, 7.58], win: [8.15, 9.05, 1.25, 1.85] }, gutter: 'z1' });
  shed(STRIP, { front: { side: 'x0', door: [-12.15, -11.3] } });
  // buurpand 2022 achter de haag (geen eigendom, alleen context)
  shed({ x0: 5.07, x1: 7.8, z0: -13.06, z1: -10.91, h: 2.5 }, { dark: true });
  addCol(5.07, 7.8, -13.06, -10.91);

  /* =================================================== HAAG, BORDERS, PLANTEN =================================================== */
  const leafInst = [];   // { m: Matrix4, c: [r,g,b] }
  const Rp = rng(99);
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3();
  function leafAt(x, y, z, nx, ny, nz, size, col) {
    _d.set(nx, ny, nz).normalize(); _q.setFromUnitVectors(_p.set(0, 0, 1), _d); _e.set(0, 0, Rp() * PI * 2); const roll = new THREE.Quaternion().setFromEuler(_e); _q.multiply(roll);
    leafInst.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, _s.set(size, size, size)), c: col });
  }
  const mixCol = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const dark = c => [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5];
  const lump = (th, ph) => 0.9 + 0.2 * Math.abs(Math.sin(th * 2.5 + ph * 3.1)) * Math.abs(Math.cos(th * 1.7 - ph * 2.3));
  const C = { hedge: [[0.07, 0.15, 0.05], [0.20, 0.33, 0.10]], green: [[0.18, 0.34, 0.12], [0.40, 0.56, 0.22]], box: [[0.12, 0.26, 0.09], [0.26, 0.42, 0.14]], copper: [[0.12, 0.05, 0.05], [0.28, 0.11, 0.09]], maple: [[0.09, 0.02, 0.03], [0.21, 0.045, 0.055]], olive: [[0.42, 0.48, 0.36], [0.68, 0.72, 0.56]], lav: [[0.40, 0.46, 0.36], [0.56, 0.62, 0.5]], blossom: [[0.92, 0.70, 0.78], [0.99, 0.90, 0.94]], tree: [[0.16, 0.30, 0.10], [0.36, 0.52, 0.18]], birch: [[0.20, 0.32, 0.09], [0.46, 0.52, 0.14]] };
  // haag: kern + bladkaarten op de buitenvlakken. Achterhaag met eigen kern; de lage voorhagen van de host (0,75 m) krijgen
  // alleen bladkaarten om hun doos heen
  function hedgeRun(ax, az, bx, bz, w, h, n, core) {
    const L = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bz - az, bx - ax), nx = -Math.sin(ang), nz = Math.cos(ang);
    if (core) {
      statics.geo('colored', new THREE.BoxGeometry(L, h - 0.1, w - 0.12), place((ax + bx) / 2, (h - 0.1) / 2, (az + bz) / 2, -ang), [0.07, 0.14, 0.05]);
      addCol(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz) - w / 2, Math.max(az, bz) + w / 2);
    }
    const side = 0.62 * h * 2 / (h * 2 + w);   // aandeel bladkaarten op de zijvlakken, naar oppervlak
    for (let i = 0; i < n; i++) {
      const t = Rp(), f = Rp(), px = ax + (bx - ax) * t, pz = az + (bz - az) * t, dd = 0.04 * Math.sin(t * L * 1.9 + 0.7) * Math.cos(t * L * 0.6) + 0.025 * Math.sin(t * L * 5.3 + 2) + (Rp() - .5) * 0.06;
      let x, y, z, ox, oy, oz;
      if (f < side * 0.68) { x = px + nx * (w / 2 + 0.03 + dd); z = pz + nz * (w / 2 + 0.03 + dd); y = 0.1 + Rp() * (h - 0.15); ox = nx; oy = 0.15; oz = nz; }
      else if (f < side) { x = px - nx * (w / 2 + 0.03 + dd); z = pz - nz * (w / 2 + 0.03 + dd); y = 0.1 + Rp() * (h - 0.15); ox = -nx; oy = 0.15; oz = -nz; }
      else { const u = (Rp() - .5) * w; x = px + nx * u; z = pz + nz * u; y = h - 0.05 + Rp() * 0.1; ox = u * 0.8; oy = 1; oz = 0; }
      leafAt(x + (Rp() - .5) * 0.08, y, z + (Rp() - .5) * 0.08, ox + (Rp() - .5) * 0.9, oy + (Rp() - .5) * 0.6, oz + (Rp() - .5) * 0.9, 0.9 + Rp() * 0.5, mixCol(C.hedge[0], C.hedge[1], Rp()));
    }
  }
  hedgeRun(HEDGE.a[0], HEDGE.a[1], HEDGE.b[0], HEDGE.b[1], HEDGE.w, HEDGE.h, Q.hedge, true);
  // (voorhagen: geen — de oprit ligt open naar de straat, zie frontgarden.js)
  // gazon-ondergrond over de grasplaat van de host (y 0): rustige vlekkerige grasmat; de sprieten erop vervagen snel met afstand
  statics.box({ py: 'lawn', def: 'lawn' }, -0.85, 9.35, -0.03, 0.004, -15.15, -3.0);
  for (const [x0, x1, z0, z1] of FRONT_LAWNS) statics.box({ py: 'lawn', def: 'lawn' }, x0, x1, -0.03, 0.004, z0, z1);
  // borders (schors)
  for (const [x0, x1, z0, z1] of BEDS) statics.box({ py: 'mulch', def: 'mulch' }, x0, x1, -0.02, 0.025, z0, z1);
  // struiken
  function shrub(kind, x, z, r, h = r * 0.9, n = 90) {
    const copper = kind === 'copper'; n = Math.round(n * Q.foliage * (copper ? 4.2 : 2.2)); const cy = h * 0.55, col = C[kind === 'hydrangea' ? 'green' : kind === 'buxus' ? 'box' : copper ? 'copper' : kind === 'lavender' ? 'lav' : 'green'];
    statics.geo('colored', coreGeo(x + z), place(x, cy, z, Rp() * PI, 1).scale(V(r * (copper ? 0.18 : 0.3), h * (copper ? 0.16 : 0.28), r * (copper ? 0.18 : 0.3))), coreCol(col[0]));
    if (copper) for (let st = 0; st < 3; st++) { const th = Rp() * PI * 2, rr = 0.08 + Rp() * 0.1; cylBetween(statics, 'bark', V(x + Math.cos(th) * 0.05, -0.02, z + Math.sin(th) * 0.05), V(x + Math.cos(th) * rr * 3, cy + h * 0.15, z + Math.sin(th) * rr * 3), 0.02); }
    const sz = kind === 'buxus' ? 0.55 : kind === 'lavender' ? 0.5 : copper ? 0.85 : 0.85;
    for (let i = 0; i < n; i++) {
      const th = Rp() * PI * 2, ph = Math.acos(1 - 2 * Rp()), dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      let k = copper ? (0.25 + Rp() * 0.95) * lump(th, ph) : (0.5 + Rp() * 0.7) * lump(th * 1.3, ph);
      if (dy < -0.55) continue;
      if (!copper && Math.sin(th * 3.7 + ph * 2.9) * Math.cos(th * 1.3 - ph * 4.1) > 0.3) continue;   // gaten in het silhouet
      if (Rp() < 0.14) k *= 1.25;                                                                     // uitstekende twijgen
      const lc = mixCol(col[0], col[1], Rp()), f = k < 0.8 ? 0.55 : 1;
      leafAt(x + dx * r * k, cy + dy * h * 0.55 * k, z + dz * r * k, dx, dy + 0.2, dz, sz * (0.75 + Rp() * 0.5), [lc[0] * f, lc[1] * f, lc[2] * f]);
    }
    const colored = (g, m, c) => statics.geo('colored', g, m, c);
    if (kind === 'lavender') for (let i = 0; i < 34; i++) { const th = Rp() * PI * 2, rr = Rp() * 0.9; colored(new THREE.CylinderGeometry(0.006, 0.004, 0.2, 5), place(x + Math.cos(th) * rr * r, cy + h * 0.5 * Math.sqrt(1 - rr * rr) + 0.1, z + Math.sin(th) * rr * r, 0, 1, (Rp() - .5) * 0.4, (Rp() - .5) * 0.4), [0.47, 0.35, 0.68]); }
  }
  const tallGrass = [];  // extra graspollen (hoog, siergras)
  const sgrass = (x, z, r = 0.35, h = 1.0) => { for (let i = 0; i < 9; i++) { const th = Rp() * PI * 2, rr = Math.sqrt(Rp()) * r; tallGrass.push([x + Math.cos(th) * rr, z + Math.sin(th) * rr, h * (0.8 + Rp() * 0.4), Rp() * PI * 2, [0.62 + Rp() * 0.1, 0.6 + Rp() * 0.1, 0.36]]); } };
  // bladkleur: donker binnenin, warmer en lichter aan de zonkant; in de herfst wat vergelend blad op de grote bomen
  const SUN = V(0.45, 0.7, 0.55).normalize();
  function leafCol(col, dx, dy, dz, k, autumn) {
    const d = clamp((dx * SUN.x + dy * SUN.y + dz * SUN.z) * 0.5 + 0.5, 0, 1);
    let c = mixCol(col[0], col[1], clamp(0.15 + 0.6 * d + (Rp() - .5) * 0.3, 0, 1));
    if (k < 0.66) c = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]; else c = [c[0] * (1 + 0.14 * d), c[1] * (1 + 0.06 * d), c[2]];
    if (Rp() < autumn) c = mixCol(c, Rp() < 0.8 ? [0.5, 0.34, 0.07] : [0.55, 0.22, 0.04], 0.7 + Rp() * 0.3);
    return c;
  }
  // kernklomp: icosaeder met radiaal +-30 % verschoven hoekpunten (consistent per hoekpunt via positie-hash), leest als beschaduwd binnenblad
  function coreGeo(seed) {
    const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), h = Math.sin(x * 12.9 + seed) * Math.cos(y * 7.3 - seed) * Math.sin(z * 9.1 + seed * 0.7), f = 1 + 0.3 * h; P.setXYZ(i, x * f, y * f, z * f); }
    g.computeVertexNormals(); return g;
  }
  const coreCol = c => [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35];
  function tree(x, z, trunkH, trunkR, crownR, crownY, kind, n, stems = 1) {
    const col = C[kind], bk = kind === 'birch' ? 'birch' : 'bark'; n = Math.round(n * Q.foliage * 3.25);
    // stam tot de vork, dan 3-4 hoofdtakken van verschillende lengte en hoogte; elke tak draagt een deelkroon die buiten het takeinde ligt
    const forkY = trunkH * (0.6 + Rp() * 0.15), tops = [];
    for (let s = 0; s < stems; s++) {
      const ox = stems > 1 ? (Rp() - .5) * 0.3 : 0, oz = stems > 1 ? (Rp() - .5) * 0.3 : 0, top = V(x + ox * 2.5, forkY, z + oz * 2.5);
      cylBetween(statics, bk, V(x + ox, -0.05, z + oz), top, trunkR); tops.push(top);
    }
    const nb = 3 + (Rp() < 0.5 ? 1 : 0), th0 = Rp() * PI * 2, subs = [];
    for (let b = 0; b < nb; b++) {
      const th = th0 + b * PI * 2 / nb + (Rp() - .5) * 0.9, len = crownR * (0.35 + Rp() * 0.45), rise = (crownY - forkY) * (0.5 + Rp() * 0.7);
      const base = tops[b % tops.length], end = V(base.x + Math.cos(th) * len, base.y + rise, base.z + Math.sin(th) * len);
      cylBetween(statics, bk, base, end, trunkR * 0.5);
      const mid = base.clone().lerp(end, 0.55), th2 = th + (Rp() < 0.5 ? 1 : -1) * (0.5 + Rp() * 0.6), l2 = len * (0.5 + Rp() * 0.4);
      const e2 = V(mid.x + Math.cos(th2) * l2, mid.y + rise * 0.5, mid.z + Math.sin(th2) * l2);
      cylBetween(statics, bk, mid, e2, trunkR * 0.28);
      // deelkroon voorbij het takeinde (grootte sterk variërend) + kleine pluk aan de zijtak
      const rr = crownR * (0.32 + Rp() * 0.5);
      subs.push({ c: V(end.x + Math.cos(th) * rr * 0.35, end.y + rr * 0.3, end.z + Math.sin(th) * rr * 0.35), r: rr });
      subs.push({ c: V(e2.x + Math.cos(th2) * 0.15, e2.y + 0.15, e2.z + Math.sin(th2) * 0.15), r: crownR * (0.2 + Rp() * 0.22) });
    }
    subs.push({ c: V(tops[0].x, crownY + crownR * 0.15, tops[0].z), r: crownR * (0.45 + Rp() * 0.2) });
    const tot = subs.reduce((a, q) => a + q.r * q.r, 0);
    subs.forEach((q, i) => statics.geo('colored', coreGeo(i + x), place(q.c.x, q.c.y, q.c.z, Rp() * PI).scale(V(q.r * 0.3, q.r * 0.26, q.r * 0.3)), coreCol(col[0])));
    const autumn = kind === 'tree' ? 0.12 : kind === 'birch' ? 0.42 : 0, size = kind === 'olive' ? 0.75 : kind === 'birch' ? 1.15 : 1.7;
    for (let i = 0; i < n; i++) {
      let r = Rp() * tot, si = 0; while (r > subs[si].r * subs[si].r && si < subs.length - 1) { r -= subs[si].r * subs[si].r; si++; }
      const q = subs[si], th = Rp() * PI * 2, ph = Math.acos(1 - 2 * Rp()), k = (0.4 + Rp() * 0.65) * lump(th + si, ph);
      if (Math.sin(th * 3.1 + si * 2.0) * Math.cos(ph * 2.7 + si) > 0.62) continue;        // gaten in de schil
      if (k > 0.95 && Rp() < 0.45) continue;                                                  // dunner aan de rand
      const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      leafAt(q.c.x + dx * q.r * k, q.c.y + dy * q.r * 0.85 * k, q.c.z + dz * q.r * k, dx, dy + 0.1, dz, size * (k > 0.85 ? 0.7 : 1.0) * (0.75 + Rp() * 0.5), leafCol(col, dx, dy, dz, k, autumn));
    }
  }
  // Japanse esdoorn (Acer palmatum): laag en breed (~2,1 m), drie kromme stammen; per laag 6-8 twijgen met losse bladplukken,
  // lucht tussen de plukken, lichter rood-oranje aan de bovenkant / zonkant en donker roodpurper eronder; geen kernmesh
  function acer(x, z) {
    const col = C.maple, n = Math.round(3400 * Q.foliage), tiers = [[1.0, 1.25], [1.45, 1.0], [1.9, 0.68]], th0 = Rp() * PI * 2, top = [0.46, 0.07, 0.025];
    for (let st = 0; st < 3; st++) {
      const th = th0 + st * 2.1, a = V(x + Math.cos(th) * 0.08, -0.05, z + Math.sin(th) * 0.08), b = V(x + Math.cos(th) * 0.35, 1.0, z + Math.sin(th) * 0.35), c = V(x + Math.cos(th + 0.5) * 0.55, tiers[st][0] + 0.12, z + Math.sin(th + 0.5) * 0.55);
      cylBetween(statics, 'bark', a, b, 0.045); cylBetween(statics, 'bark', b, c, 0.03);
    }
    tiers.forEach(([ty, tr], ti) => {
      const nb = 6 + Math.floor(Rp() * 3), m = Math.round(n * tr / 2.93 / nb);
      for (let b = 0; b < nb; b++) {
        const th = th0 + ti * 0.7 + b * PI * 2 / nb + (Rp() - .5) * 0.5, len = tr * (0.7 + Rp() * 0.35), droop = 0.08 + Rp() * 0.14;
        const bx = x + (Rp() - .5) * 0.25, bz = z + (Rp() - .5) * 0.25, by = ty + 0.1, ex = Math.cos(th), ez = Math.sin(th);
        cylBetween(statics, 'bark', V(bx, by, bz), V(bx + ex * len, by - droop * len, bz + ez * len), 0.012);
        const nt = 3 + Math.floor(Rp() * 3), per = Math.max(2, Math.round(m / nt));
        for (let t = 0; t < nt; t++) {
          const u = 0.25 + 0.75 * (t + Rp()) / nt, side = (Rp() - .5) * 0.4 * u, px = bx + ex * len * u - ez * side, pz = bz + ez * len * u + ex * side, py = by - droop * len * u;
          const sp = 0.08 + 0.08 * u;
          for (let i = 0; i < per; i++) {
            const ox = (Rp() - .5) * 2 * sp, oz = (Rp() - .5) * 2 * sp, oy = (Rp() - .5) * 0.12 - (ox * ox + oz * oz) * 1.5, up = oy > -0.02;
            const c = up ? mixCol(mixCol(col[1], top, 0.2 + Rp() * 0.6), [0.7, 0.3, 0.05], Rp() * 0.12) : mixCol(col[0], col[1], 0.3 + Rp() * 0.5);
            leafAt(px + ox, py + oy, pz + oz, (Rp() - .5) * 0.8, 0.7 + Rp() * 0.5, (Rp() - .5) * 0.8, 0.85 * (0.7 + Rp() * 0.5), up ? c : [c[0] * 0.85, c[1] * 0.85, c[2] * 0.85]);
          }
        }
      }
    });
  }
  // border bij het terras: rode esdoorn, hortensia's, lavendel, buxus, siergras
  acer(0.85, -4.35); addCol(0.7, 1.0, -4.5, -4.2);
  shrub('hydrangea', 1.55, -3.85, 0.5, 0.55); shrub('hydrangea', 1.6, -4.75, 0.45, 0.5); shrub('lavender', 0.0, -3.7, 0.4, 0.35); shrub('buxus', 0.2, -4.75, 0.38, 0.4); sgrass(1.0, -3.6, 0.3, 0.8);
  // strook langs het hek (links)
  sgrass(-0.55, -3.6, 0.3, 1.0); sgrass(-0.55, -4.9, 0.3, 1.1); sgrass(-0.55, -6.3, 0.3, 1.0); shrub('buxus', -0.55, -5.6, 0.3, 0.32); shrub('hydrangea', -0.5, -4.25, 0.38, 0.45);
  // border rechts van de jacuzzi / voor de schuur
  shrub('copper', 4.75, -8.75, 0.62, 1.25, 110); addCol(4.4, 5.1, -9.1, -8.4); shrub('hydrangea', 3.3, -9.2, 0.5, 0.55); shrub('lavender', 3.35, -8.1, 0.4, 0.35); sgrass(5.45, -9.3, 0.35, 1.1); sgrass(4.0, -9.45, 0.3, 0.9); shrub('buxus', 5.5, -8.1, 0.35, 0.36); shrub('buxus', 3.0, -9.6, 0.26, 0.28);
  // strook langs de erfgrens (rechts)
  shrub('hydrangea', 9.0, -4.2, 0.45, 0.5); sgrass(9.0, -5.5, 0.3, 1.0); shrub('buxus', 9.0, -6.6, 0.3, 0.32); shrub('lavender', 9.0, -7.6, 0.35, 0.32);
  // terras: olijf in pot, buxus in bak
  statics.geo('pot', new THREE.CylinderGeometry(0.3, 0.24, 0.5, 18), place(3.3, 0.25, -0.75)); statics.geo('mulch', new THREE.CylinderGeometry(0.28, 0.28, 0.02, 18), place(3.3, 0.49, -0.75));
  tree(3.3, -0.75, 1.25, 0.035, 0.55, 1.55, 'olive', 220); addCol(3.0, 3.6, -1.05, -0.45);
  statics.box('pot', 8.35, 8.85, 0, 0.45, -0.85, -0.35); statics.box('mulch', 8.37, 8.83, 0.44, 0.45, -0.83, -0.37); shrub('buxus', 8.6, -0.6, 0.3, 0.3); addCol(8.35, 8.85, -0.85, -0.35);
  // buurbomen (buiten het perceel, decor): bloesemboom en de grote boom van de buren
  // op de plekken van de (verborgen) host-bomen: twee achter de haag (de voortuinboom staat in frontgarden.js)
  tree(1.6, -11.2, 2.9, 0.11, 2.0, 3.8, 'tree', 620); tree(4.2, -13.4, 2.2, 0.085, 1.5, 2.9, 'tree', 420);
  tree(-5.2, -9.5, 2.6, 0.11, 2.2, 3.7, 'birch', 700, 2); tree(9.9, -8.5, 3.2, 0.2, 2.5, 4.9, 'tree', 750);

  /* =================================================== STAPTEGELS, VERLICHTING, TERRAS =================================================== */
  for (const [x, z] of [...STONES1, ...STONES2]) {
    const sh = new THREE.Shape(), nv = 11, r0 = 0.27 + Rp() * 0.04, ex = 1 + Rp() * 0.15;
    for (let i = 0; i < nv; i++) { const a = i / nv * PI * 2, rr = r0 * (0.86 + Rp() * 0.22); const px = Math.cos(a) * rr * ex, py = Math.sin(a) * rr; i ? sh.lineTo(px, py) : sh.moveTo(px, py); }
    sh.closePath();
    statics.geo('stone', new THREE.ExtrudeGeometry(sh, { depth: 0.035, bevelEnabled: false, curveSegments: 1 }), place(x, -0.012, z, 0, 1, -PI / 2, Rp() * PI));
  }
  for (const [x, z] of BOLLARDS) { statics.geo('alu', new THREE.CylinderGeometry(0.035, 0.035, 0.44, 10), place(x, 0.22, z)); statics.geo('alu', new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), place(x, 0.51, z)); statics.geo('bollardLight', new THREE.CylinderGeometry(0.033, 0.033, 0.06, 10), place(x, 0.47, z)); }
  // loungehoek (wicker + kussens)
  {
    const mg = statics; const wk = 'wicker';
    mg.box(wk, -0.1, 0.72, 0.04, 0.32, -3.05, -1.15); mg.box(wk, 0.72, 2.3, 0.04, 0.32, -3.05, -2.25);            // zittingen (frame)
    mg.box(wk, -0.1, 0.02, 0.32, 0.72, -3.05, -1.15); mg.box(wk, 0.02, 2.3, 0.32, 0.72, -3.05, -2.93);           // rugleuningen
    mg.box(wk, 2.3, 2.42, 0.04, 0.58, -3.05, -2.25); mg.box(wk, -0.1, 0.72, 0.04, 0.58, -1.15, -1.03);           // armleuningen
    for (const [x, z] of [[-0.06, -3.01], [-0.06, -1.19], [2.38, -3.01], [2.38, -2.29], [0.76, -1.19], [0.76, -3.01]]) mg.box('alu', x - 0.02, x + 0.02, 0, 0.04, z - 0.02, z + 0.02);
    mg.geo('cushion', rbox(0.66, 0.12, 1.84, 0.03), place(0.35, 0.38, -2.1)); mg.geo('cushion', rbox(1.52, 0.12, 0.74, 0.03), place(1.51, 0.38, -2.65));
    mg.geo('cushion', rbox(0.1, 0.42, 1.8, 0.03), place(0.1, 0.63, -2.1, 0, 1, 0, -0.15)); mg.geo('cushion', rbox(1.5, 0.42, 0.1, 0.03), place(1.52, 0.63, -2.86, 0, 1, 0.15));
    mg.geo('accent', rbox(0.4, 0.1, 0.4, 0.02), place(0.3, 0.58, -2.5, 0, 1, -1.25, 0.1)); mg.geo('accent', rbox(0.4, 0.1, 0.4, 0.02), place(1.9, 0.58, -2.68, 0, 1, -1.3, -0.1));
    mg.box({ py: 'teak', def: 'teak' }, 1.0, 1.8, 0.36, 0.4, -2.0, -1.3); for (const [x, z] of [[1.03, -1.97], [1.77, -1.97], [1.03, -1.33], [1.77, -1.33]]) mg.box('alu', x - 0.015, x + 0.015, 0, 0.36, z - 0.015, z + 0.015);
    addCol(-0.12, 0.74, -3.07, -1.03); addCol(0.72, 2.44, -3.07, -2.23); addCol(1.0, 1.8, -2.0, -1.3);
    // eettafel + vier stoelen
    mg.box({ py: 'teak', def: 'teak' }, 4.1, 5.9, 0.72, 0.76, -2.3, -1.35); mg.box('alu', 4.2, 5.8, 0.66, 0.72, -2.2, -1.45); for (const [x, z] of [[4.2, -2.2], [5.8, -2.2], [4.2, -1.45], [5.8, -1.45]]) mg.box('alu', x - 0.025, x + 0.025, 0, 0.72, z - 0.025, z + 0.025);
    addCol(4.1, 5.9, -2.3, -1.35);
    const chair = (x, z, dir) => {
      const m = place(x, 0, z, dir > 0 ? 0 : PI); const B = (k, g, lx, ly, lz, rx = 0) => mg.geo(k, g, m.clone().multiply(place(lx, ly, lz, 0, 1, rx)));
      B('teak', new THREE.BoxGeometry(0.46, 0.035, 0.44), 0, 0.45, 0); B('teak', new THREE.BoxGeometry(0.46, 0.4, 0.03), 0, 0.72, -0.22, -0.17);
      for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) B('alu', new THREE.BoxGeometry(0.025, 0.44, 0.025), lx, 0.22, lz);
      B('alu', new THREE.BoxGeometry(0.025, 0.46, 0.025), -0.2, 0.68, -0.26, -0.17); B('alu', new THREE.BoxGeometry(0.025, 0.46, 0.025), 0.2, 0.68, -0.26, -0.17);
      addCol(x - 0.25, x + 0.25, z - 0.25, z + 0.25);
    };
    chair(4.55, -2.85, 1); chair(5.45, -2.85, 1); chair(4.55, -0.8, -1); chair(5.45, -0.8, -1);
    // zweefparasol boven de tafel
    mg.box('granite', 5.65, 6.55, 0, 0.05, -3.4, -2.5); mg.geo('alu', new THREE.CylinderGeometry(0.04, 0.045, 2.65, 10), place(6.1, 1.325, -2.95)); addCol(5.65, 6.55, -3.4, -2.5);
    cylBetween(mg, 'alu', V(6.1, 2.65, -2.95), V(5.0, 2.62, -1.8), 0.025); cylBetween(mg, 'alu', V(5.0, 2.62, -1.8), V(5.0, 2.3, -1.8), 0.02);
    const cone = new THREE.ConeGeometry(1.55, 0.3, 8, 1, true); const canopy = new THREE.Mesh(cone, mat.canopy); canopy.position.set(5.0, 2.45, -1.8); canopy.rotation.y = PI / 8; canopy.castShadow = true; canopy.receiveShadow = true; root.add(canopy);
    for (let i = 0; i < 8; i++) { const a = i / 8 * PI * 2 + PI / 8; cylBetween(mg, 'alu', V(5.0, 2.6, -1.8), V(5.0 + Math.cos(a) * 1.55, 2.3, -1.8 + Math.sin(a) * 1.55), 0.008); }
    // bbq (kogel) achter de keuken
    mg.geo('black', new THREE.SphereGeometry(0.29, 18, 12), place(8.4, 0.72, -1.9)); mg.geo('chrome', new THREE.TorusGeometry(0.29, 0.012, 6, 24), place(8.4, 0.72, -1.9, 0, 1, PI / 2));
    for (let i = 0; i < 3; i++) { const a = i / 3 * PI * 2; cylBetween(mg, 'alu', V(8.4 + Math.cos(a) * 0.25, 0, -1.9 + Math.sin(a) * 0.25), V(8.4 + Math.cos(a) * 0.1, 0.62, -1.9 + Math.sin(a) * 0.1), 0.012); }
    mg.geo('black', new THREE.BoxGeometry(0.12, 0.03, 0.03), place(8.4, 1.02, -1.9)); addCol(8.1, 8.7, -2.2, -1.6);
    // houten paal voor het lichtsnoer
    mg.box('deck', -0.1, -0.01, 0, 2.4, -3.2, -3.11); addCol(-0.12, 0.01, -3.22, -3.09);
  }
  // lichtsnoer: huis -> paal -> parasolmast -> huis (kettinglijn met lampjes)
  {
    const pts = [V(0.9, 2.55, -0.28), V(-0.05, 2.38, -3.15), V(6.1, 2.6, -2.95), V(7.8, 2.55, -0.28)], line = [], mg = statics;
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s], b = pts[s + 1], L = a.distanceTo(b), n = Math.round(L / 0.45);
      for (let i = 0; i <= n * 4; i++) { const t = i / (n * 4), p = a.clone().lerp(b, t); p.y -= 0.22 * 4 * t * (1 - t); line.push(p); if (i % 4 === 2) { mg.geo('bulb', new THREE.SphereGeometry(0.028, 8, 6), place(p.x, p.y - 0.05, p.z)); mg.geo('black', new THREE.CylinderGeometry(0.012, 0.012, 0.04, 6), place(p.x, p.y - 0.02, p.z)); } }
    }
    const lg = new THREE.BufferGeometry().setFromPoints(line); root.add(new THREE.Line(lg, mat.wire));
  }
  statics.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = k !== 'mulch' && k !== 'stone'; m.receiveShadow = true; root.add(m); meshes[k] = m; });
  // bladkaarten: één InstancedMesh
  {
    const g = new THREE.PlaneGeometry(0.16, 0.12), im = new THREE.InstancedMesh(g, new MSM({ map: tex(texLeaf('leaf'), 1, 1), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 }), leafInst.length);
    const col = new THREE.Color(); for (let i = 0; i < leafInst.length; i++) { im.setMatrixAt(i, leafInst[i].m); im.setColorAt(i, col.setRGB(leafInst[i].c[0], leafInst[i].c[1], leafInst[i].c[2])); }
    im.castShadow = im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); root.add(im); meshes.leaves = im;
  }
  /* =================================================== GAZON (instanced graspollen) =================================================== */
  const grassU = { uTime: { value: 0 }, uFade: { value: new THREE.Vector2(Q.fade[0], Q.fade[1]) } };
  {
    // pol: 3 gekruiste kaarten, normalen omhoog (belicht als het gazon)
    const g = new THREE.BufferGeometry(), p = [], u = [], n = [], w = 0.24, h = 0.3;
    for (let k = 0; k < 3; k++) {
      const a = k * PI / 3, c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2;
      const q = [[-c, 0, -s, 0, 0], [c, 0, s, 1, 0], [c, h, s, 1, 1], [-c, h, -s, 0, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) { p.push(q[i][0], q[i][1], q[i][2]); u.push(q[i][3], q[i][4]); n.push(0, 1, 0); }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    const gm = new MSM({ map: tex(texTuft(), 1, 1), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 });
    gm.onBeforeCompile = sh => {
      sh.uniforms.uTime = grassU.uTime; sh.uniforms.uFade = grassU.uFade;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uFade; varying float vFade;')
        .replace('#include <project_vertex>', `vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          float hh = uv.y * uv.y; float ph = mvPosition.x * 1.7 + mvPosition.z * 1.3;
          float wv = sin(uTime * 1.5 + ph) * 0.05 + sin(uTime * 2.9 + ph * 2.1) * 0.02;
          mvPosition.xz += vec2(wv, wv * 0.45) * hh;
          vFade = 1.0 - smoothstep(uFade.x, uFade.y, distance((modelMatrix * mvPosition).xyz, cameraPosition));
          mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;').replace('#include <alphatest_fragment>', 'diffuseColor.a *= vFade;\n#include <alphatest_fragment>');
    };
    gm.customProgramCacheKey = () => 'garden-grass';
    // plaatsing: gazonrechthoeken minus vlonder, borders, tegels, schuur
    const lawns = [[-0.3, 5.95, -9.9, -3.35], [5.95, 9.25, -8.3, -3.35], ...FRONT_LAWNS];
    const blocked = [[DECK.x0, DECK.x1, DECK.z0, DECK.z1], [0.67, 1.77, -6.9, -6.2], ...BEDS, [SHED.x0 - 0.2, SHED.x1, SHED.z0, SHED.z1 + 0.2], [5.9, 6.6, -8.3, -7.6], [1.5, 2.75, 9.28, 11.1], [-1.1, -0.7, 9.2, 18.1], [-0.8, 9.4, 17.55, 17.95]];
    const circles = [...STONES1, ...STONES2].map(([x, z]) => [x, z, 0.3]).concat(BOLLARDS.map(([x, z]) => [x, z, 0.08]));
    const free = (x, z) => { for (const b of blocked) if (x > b[0] && x < b[1] && z > b[2] && z < b[3]) return false; for (const c of circles) if ((x - c[0]) ** 2 + (z - c[1]) ** 2 < c[2] * c[2]) return false; return true; };
    const R = rng(123), inst = [], areas = lawns.map(l => (l[1] - l[0]) * (l[3] - l[2])), tot = areas.reduce((a, b) => a + b, 0);
    let guard = 0;
    const nGrass = Math.round(Q.grass * tot / (areas[0] + areas[1]));   // voortuin met dezelfde dichtheid als achter
    while (inst.length < nGrass && guard++ < nGrass * 4) {
      let r = R() * tot, li = 0; while (r > areas[li] && li < lawns.length - 1) { r -= areas[li]; li++; }
      const l = lawns[li], x = l[0] + R() * (l[1] - l[0]), z = l[2] + R() * (l[3] - l[2]);
      if (!free(x, z)) continue;
      const j = 0.92 + R() * 0.16; inst.push([x, z, 0.8 + R() * 0.45, R() * PI * 2, [j, j * (1 + (R() - .5) * 0.05), j * 0.97]]);
    }
    const all = inst.concat(tallGrass.map(([x, z, hh, ry, c]) => [x, z, hh, ry, c, true]));
    const im = new THREE.InstancedMesh(g, gm, all.length), m4 = new THREE.Matrix4(), col = new THREE.Color();
    for (let i = 0; i < all.length; i++) { const [x, z, s, ry, c, tall] = all[i]; im.setMatrixAt(i, m4.compose(_p.set(x, -0.005, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(tall ? s * 1.4 : s * 0.75, tall ? s * 3.4 : s * 0.27, tall ? s * 1.4 : s * 0.75))); im.setColorAt(i, col.setRGB(c[0], c[1], c[2])); }
    im.receiveShadow = true; im.castShadow = false; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); root.add(im); meshes.grass = im;
  }

  /* =================================================== VERLICHTING ('s avonds) =================================================== */
  const lights = [];
  if (Q.lights) {
    const mk = (c, x, y, z, i, d) => { const L = new THREE.PointLight(c, 0, d, 1.8); L.position.set(x, y, z); root.add(L); lights.push({ L, i }); };
    mk('#ffbe72', 3.0, 2.15, -1.8, 9, 9); mk('#ffc784', 2.4, 0.6, -4.9, 2.5, 4.5); mk('#ffc784', 7.3, 0.6, -5.9, 2.5, 4.5);
  }
  const lampFactor = h => (h >= 17.5 ? clamp((h - 17.5) / 1.5, 0, 1) : clamp((7.5 - h) / 1.0, 0, 1));
  let lf = -1, ledOn = false;
  function applyEvening(h) {
    lf = lampFactor(h);
    mat.bulb.emissiveIntensity = 3.2 * lf; mat.bollardLight.emissiveIntensity = 2.6 * lf;
    for (const { L, i } of lights) L.intensity = i * lf;
    // lichte damp, 's avonds (koel) wat meer; de stoom is onbelicht, dus 's avonds donkerder getint
    meshes.steam.material.uniforms.uAmount.value = lerp(0.12, 0.45, lf); meshes.steam.material.uniforms.uColor.value.setScalar(lerp(0.92, 0.72, lf));
  }
  function applyLed(open) {
    const want = (api.led == null ? lf > 0.05 : !!api.led) && open;
    if (want === ledOn) return; ledOn = want;
    mat.led.emissiveIntensity = want ? 3.2 : 0; mat.water.emissiveIntensity = want ? 0.24 : 0; api.ledLight.intensity = want ? 4.5 : 0;
    if (!want) uLed.value.setRGB(0, 0, 0);
  }

  /* =================================================== INTERACTIE (deksel, bubbels) =================================================== */
  // De kuip, het deksel en het water dragen userData.interact (zie interactOf in index.html): de host richt, labelt en
  // voert E / klik / tik uit zoals bij lades en de tv. De knop "Jacuzzi" in de werkbalk doet hetzelfde als het deksel.
  let toasted = false;
  function activate() {
    api.toggleCover();
    if (!toasted && api.cover.target === 2) { toasted = true; try { H.ui?.toast?.("Jacuzzi open: 's avonds gaat de LED-verlichting vanzelf aan. Richt op het water voor de bubbels."); } catch (e) { /* ok */ } }
  }
  api.bubbles = false;
  api.setBubbles = on => {
    on = !!on; if (on && api.cover.target < 2) { try { H.ui?.toast?.('Open eerst het deksel.'); } catch (e) { /* ok */ } return false; }
    api.bubbles = on; return true;
  };
  coverIt.act = activate; bubblesIt.act = () => api.setBubbles(!api.bubbles);
  try { H.ui?.addTool?.({ id: 'jacuzzi', label: 'Jacuzzi', title: 'Jacuzzi-deksel openen of sluiten', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="10" rx="2"/><path d="M3 13h18M8 6c0-1.5 1-1.5 1-3M12 6c0-1.5 1-1.5 1-3M16 6c0-1.5 1-1.5 1-3"/></svg>', onClick: () => activate() }); } catch (e) { /* geen tools-balk */ }
  try { H.invalidatePicks?.(); } catch (e) { /* ok */ }

  /* =================================================== PER FRAME =================================================== */
  let clock = 0, frame = 0, fpsAvg = 60, agit = 0;
  const cover = api.cover, pivot1 = api.pivot1, pivot2 = api.pivot2, lifter = api.lifter, LIFT = api.LIFT;
  function setCover(t) {
    const s1 = ease(clamp(t, 0, 1)), s2 = ease(clamp(t - 1, 0, 1));
    pivot2.rotation.x = -PI * s1;
    pivot1.rotation.x = -(1.5 * PI - cover.lean) * s2;
    pivot1.position.y = lerp(cover.closed.y, cover.open.y, s2) + 0.35 * Math.sin(PI * s2);
    pivot1.position.z = lerp(cover.closed.z, cover.open.z, s2);
    lifter.rotation.x = lerp(LIFT.a0, LIFT.a1, s2);
    const vis = t > 0.45; meshes.water.visible = vis; meshes.steam.visible = vis; meshes.bubbles.visible = vis && agit > 0.02;
  }
  setCover(0);
  const ledCol = new THREE.Color();
  onTick(dt => {
    dt = Math.min(dt || 0.016, 0.1); clock += dt; frame++; fpsAvg = lerp(fpsAvg, 1 / Math.max(dt, 1e-3), 0.05);
    // deksel
    if (cover.t !== cover.target) {
      const rate = (cover.t < 1 && cover.target > cover.t) || (cover.t <= 1 && cover.target < cover.t) ? 1 / 1.0 : 1 / 1.5;
      cover.t = cover.target > cover.t ? Math.min(cover.target, cover.t + dt * rate) : Math.max(cover.target, cover.t - dt * rate);
      setCover(ENV.reduced ? cover.target : cover.t); if (ENV.reduced) cover.t = cover.target;
    }
    // bubbels: roering loopt in ~1 s op of af; het water beweegt sneller, schuimt en de bubbels komen op
    const wantAgit = api.bubbles && cover.t > 1.5 ? 1 : 0;
    if (agit !== wantAgit) { agit = clamp(agit + (wantAgit ? dt : -dt) * 1.2, 0, 1); uAgit.value = agit; meshes.bubbles.visible = meshes.water.visible && agit > 0.02; }
    uPhase.value += dt * (1 + 1.6 * agit); grassU.uTime.value = clock;
    meshes.bubbles.material.uniforms.uTime.value = clock; meshes.steam.material.uniforms.uTime.value = clock;
    // avond
    const h = Number(H.state?.time); if (Number.isFinite(h) && lampFactor(h) !== lf) applyEvening(h);
    applyLed(cover.t > 0.45);
    if (ledOn) {   // rustige kleurcyclus (45 s): alleen kleuren en sterktes, nooit het aantal lichten
      ledCol.setHSL((clock / 45) % 1, 0.8, 0.6);
      api.ledLight.color.copy(ledCol); mat.led.emissive.copy(ledCol); mat.water.emissive.copy(ledCol); uLed.value.copy(ledCol).multiplyScalar(0.9);
    }
  });
  if (Number.isFinite(Number(H.state?.time))) applyEvening(Number(H.state.time)); else applyEvening(13);

  api.meshes = meshes; api.lights = lights;
  api.stats = () => ({ fps: Math.round(fpsAvg), coverT: +cover.t.toFixed(2), bubbles: api.bubbles, agit: +agit.toFixed(2), led: ledOn, lf, grass: meshes.grass.count, leaves: meshes.leaves.count, nBubbles: Q.bubbles, steam: Q.steam, meshesInRoot: root.children.length });
  H.garden = api;
  return api;
}

/* ---- host-placeholders: schuurdozen (per materiaal samengevoegd in EXT) wegknippen + hun colliders ---- */
// De host tekent drie laag-poly bomen (twee achter de achterhaag, een in de voortuin) als een trunk- en een
// crown-mesh die samen x -1..8, z -11.3..16.3, y < 7 beslaan. Die twee meshes worden verborgen (niet verwijderd)
// en op dezelfde plekken zet de module bladkaart-bomen neer. Zie HOST-PATCH.md voor de nette oplossing.
function hideHostTrees(H) {
  let n = 0;
  H.scene.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.userData.gardenSkip) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox;
    if (b.min.x > -1 && b.max.x < 8 && b.min.z < -10.5 && b.max.z > 15.5 && b.min.y > -0.5 && b.max.y < 7) { o.visible = false; n++; }
  });
  return n;
}
function hideHostShed(H) {
  const boxes = [[6.3, 9.31, -0.02, 2.45, -9.7, -7.25], [7.7, 9.31, -0.02, 2.35, -15.2, -9.5]];
  const inside = (x, y, z) => boxes.some(b => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3] && z >= b[4] && z <= b[5]);
  let cut = 0;
  H.scene.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.geometry.index || o.userData.gardenSkip) return;
    const P = o.geometry.attributes.position; if (!P || P.count < 3) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox;
    if (bb.max.x < 6.3 || bb.min.x > 9.31 || bb.max.z < -15.2 || bb.min.z > -7.25 || bb.min.y > 2.45) return;
    const keep = []; let removed = false;
    for (let i = 0; i < P.count; i += 3) {
      const all = inside(P.getX(i), P.getY(i), P.getZ(i)) && inside(P.getX(i + 1), P.getY(i + 1), P.getZ(i + 1)) && inside(P.getX(i + 2), P.getY(i + 2), P.getZ(i + 2));
      if (all) removed = true; else keep.push(i, i + 1, i + 2);
    }
    if (!removed) return;
    const g = o.geometry, ng = new THREE.BufferGeometry();
    for (const name in g.attributes) { const a = g.attributes[name], it = a.itemSize, arr = new Float32Array(keep.length * it); for (let k = 0; k < keep.length; k++) for (let j = 0; j < it; j++) arr[k * it + j] = a.array[keep[k] * it + j]; ng.setAttribute(name, new THREE.BufferAttribute(arr, it)); }
    ng.computeBoundingBox(); ng.computeBoundingSphere(); o.geometry = ng; g.dispose(); cut += (P.count - keep.length) / 3;
  });
  const cols = H.colliders && H.colliders[0];
  if (Array.isArray(cols)) for (const c of [[6.45, 9.2, -9.54, -7.4], [7.83, 9.2, -15.1, -9.54]]) { const i = cols.findIndex(k => k.length === 4 && k.every((v, j) => Math.abs(v - c[j]) < 1e-6)); if (i >= 0) cols.splice(i, 1); }
  if (cut) console.info(`[garden] host-schuur verborgen (${cut} driehoeken)`);
}

/* ---- zelf opstarten ---- */
(function boot(tries = 0) {
  const H = typeof window !== 'undefined' ? window.HOUSE : null, k = Object.keys(EARLY).find(k => !early[k]);
  if (H && H.scene && H.camera && H.renderer) {
    if (H.garden && H.garden.installed) return;
    if (k) { made(k); setTimeout(() => boot(tries + 1), 0); return; } // any texture not made yet first, each in its own task
    try { install(H); } catch (e) { console.error('[garden] installatie mislukt', e); }
    return;
  }
  if (tries && k) made(k); // a texture per poll (not in the module's own first run) while the house is being built
  if (tries < 600) setTimeout(() => boot(tries + 1), 100);
})();
