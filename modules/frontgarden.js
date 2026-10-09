/* frontgarden.js — de voortuin en de straat van Ons Huis (add-on, net als garden.js)
 *
 *  Naar de foto uit het woonkamerraam (voortuin_1): de tuin ligt op het westen, het raam kijkt op +Z.
 *  - Oprit en de strook langs de gevel in beige grind (procedurele kiezels + normal map), opsluitbanden, border met
 *    donkere aarde en bladval; de auto op de oprit (zonder kenteken), deurmat, brievenbus en laadpaal bij de voordeur.
 *  - Border: grote laurier/photinia-achtige groenblijver (~4 m, glanzend donker blad), jong boompje aan een paal,
 *    herfstboompje met oranjebruin blad links, siergrassen met pluimen, bodembedekker met gelobd blad, struiken en
 *    een beukenhaag op de erfgrens; twee prikspots die 's avonds branden.
 *  - Straat in rood-grijze klinkers met trottoirbanden en grijze stoeptegels, lantaarnpaal ('s avonds aan),
 *    geparkeerde auto, getrimde haag aan de overkant en de rij woningen erachter (baksteen beneden, antraciet
 *    houten rabat boven, witte kozijnen, grijze pannen met dakramen; gele-baksteen hoekwoning met plat dak),
 *    volwassen bomen, en het buurpand op −X (EXTERIOR-NOTES, footprint uit het BAG).
 *  - Blad: drie InstancedMeshes (ovaal / gelobd / graspol) met alpha, kleur per instance en lichte wind in de vertex
 *    shader; al het statische is per materiaal samengevoegd (Merger). ~25 draw calls, minder blad op telefoons.
 *
 * Laden (na garden.js):  import './modules/frontgarden.js'  — gebruikt alleen de import map ("three").
 * De host tekent in de voortuin alleen nog de weide; garden.js laat de voortuin met rust (zie FRONT in garden.js).
 */
import * as THREE from 'three';

const PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();
const Q = coarse ? { leaf: 0.45, tex: 256 } : { leaf: 1.0, tex: 512 };

/* ===================================================== CANVAS-TEXTUREN ===================================================== */
function mkCanvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(c, su = 1, sv = su, srgb = true) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / su, 1 / sv); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
function noise(ctx, w, h, n, amp, R) { for (let i = 0; i < n; i++) { ctx.fillStyle = `rgba(${R() < .5 ? 0 : 255},${R() < .5 ? 0 : 255},${R() < .5 ? 0 : 255},${(R() * amp).toFixed(3)})`; ctx.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2); } }
function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data, out = mkCanvas(w, h), ctx = out.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    d[i] = 128 + (-dx / l) * 127; d[i + 1] = 128 + (dy / l) * 127; d[i + 2] = 128 + (1 / l) * 127; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); return out;
}
// grind (siergrind 8-16 mm): beige/zand/grijs kiezels op een zandbed, tegel = 1 m; paar gevallen blaadjes
function texGravel() {
  const S = Q.tex, c = mkCanvas(S), x = c.getContext('2d'), hc = mkCanvas(S), hx = hc.getContext('2d'), R = rng(31), k = S / 512;
  x.fillStyle = '#9b8d78'; x.fillRect(0, 0, S, S); hx.fillStyle = '#303030'; hx.fillRect(0, 0, S, S);
  for (let i = 0, n = S * S / 40; i < n; i++) {
    const cx = R() * S, cy = R() * S, r = k * (2.2 + R() * 3.4), e = 0.65 + R() * 0.35, a = R() * PI, t = R();
    const h = t < 0.12 ? 0 : 26 + R() * 16, s = t < 0.12 ? 3 : 14 + R() * 22, l = t < 0.12 ? 50 + R() * 22 : t < 0.25 ? 32 + R() * 10 : 52 + R() * 26;
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {   // over de rand: ook aan de overkant tekenen (tileable)
      const px = cx + ox, py = cy + oy; if (px < -8 || px > S + 8 || py < -8 || py > S + 8) continue;
      const g = x.createRadialGradient(px - r * 0.35, py - r * 0.35, 0, px, py, r); g.addColorStop(0, hsl(h, s, l + 12)); g.addColorStop(1, hsl(h, s, l - 10));
      x.fillStyle = g; x.beginPath(); x.ellipse(px, py, r, r * e, a, 0, PI * 2); x.fill();
      const hg = hx.createRadialGradient(px, py, 0, px, py, r); hg.addColorStop(0, '#d8d8d8'); hg.addColorStop(0.7, '#9a9a9a'); hg.addColorStop(1, '#303030');
      hx.fillStyle = hg; hx.beginPath(); hx.ellipse(px, py, r, r * e, a, 0, PI * 2); hx.fill();
    }
  }
  for (let i = 0; i < 14; i++) { x.fillStyle = hsl(22 + R() * 16, 42, 20 + R() * 14, 0.85); x.beginPath(); x.ellipse(R() * S, R() * S, k * (4 + R() * 4), k * (2.5 + R() * 2), R() * PI, 0, PI * 2); x.fill(); }
  noise(x, S, S, S * 4, 0.06, R);
  return { map: c, nor: normalFromHeight(hc, 2.2) };
}
// bestrating: stenen van bw x bh px (op 512), halfsteens verspringend (off) of in een raster; col(R) -> [h, s, l]
function texPavers(seed, bw, bh, col, joint, off = true, j = 2) {
  const S = Q.tex, c = mkCanvas(S), x = c.getContext('2d'), hc = mkCanvas(S), hx = hc.getContext('2d'), R = rng(seed), k = S / 512;
  x.fillStyle = joint; x.fillRect(0, 0, S, S); hx.fillStyle = '#404040'; hx.fillRect(0, 0, S, S);
  const rows = Math.round(S / (bh * k)), cols = Math.round(S / (bw * k)), w = S / cols, h = S / rows; j *= k;
  for (let r = 0; r < rows; r++) for (let ci = -1; ci < cols; ci++) {
    const x0 = ci * w + (off && r % 2 ? w / 2 : 0), y0 = r * h, [hh, ss, ll] = col(R);
    const g = x.createLinearGradient(x0, y0, x0 + w, y0 + h); g.addColorStop(0, hsl(hh, ss, ll + 3)); g.addColorStop(1, hsl(hh, ss, ll - 4));
    x.fillStyle = g; x.fillRect(x0 + j, y0 + j, w - 2 * j, h - 2 * j);
    const v = 150 + R() * 50 | 0; hx.fillStyle = `rgb(${v},${v},${v})`; hx.fillRect(x0 + j, y0 + j, w - 2 * j, h - 2 * j);
  }
  noise(x, S, S, S * 6, 0.1, R);
  return { map: c, nor: normalFromHeight(hc, 1.6) };
}
// rood-grijze straatklinkers (21 x 7 cm, tegel 1,05 m) en grijze stoeptegels (30 x 30, tegel 0,9 m)
const texClinker = () => texPavers(7, 102.4, 34.13, R => { const t = R(); return t < 0.62 ? [6 + R() * 12, 34 + R() * 14, 28 + R() * 12] : t < 0.88 ? [345 + R() * 15, 7 + R() * 8, 34 + R() * 10] : [18, 30, 20 + R() * 8]; }, '#8a8073');
const texTiles30 = () => texPavers(8, 170.67, 170.67, R => [40 + R() * 10, 3 + R() * 3, 54 + R() * 9], '#6d6a64', false, 1.5);
// antraciet houten rabatdelen (8 planken per tegel van 1,2 m)
function texClad() {
  const S = Q.tex, c = mkCanvas(S), x = c.getContext('2d'), hc = mkCanvas(S), hx = hc.getContext('2d'), R = rng(44), n = 8, h = S / n, k = S / 512;
  for (let i = 0; i < n; i++) {
    const y0 = i * h, l = 20 + (R() - .5) * 5; x.fillStyle = hsl(205, 5, l); x.fillRect(0, y0, S, h);
    for (let g = 0; g < 40; g++) { x.strokeStyle = hsl(205, 6, l + (R() < .5 ? -5 : 5), 0.25); x.lineWidth = (0.6 + R()) * k; const yy = y0 + R() * h; x.beginPath(); x.moveTo(0, yy); x.lineTo(S, yy + (R() - .5) * 2); x.stroke(); }
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, y0 + h - 3 * k, S, 3 * k); x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(0, y0, S, 1);
    const g2 = hx.createLinearGradient(0, y0, 0, y0 + h); g2.addColorStop(0, '#b0b0b0'); g2.addColorStop(1, '#707070'); hx.fillStyle = g2; hx.fillRect(0, y0, S, h - 3 * k); hx.fillStyle = '#303030'; hx.fillRect(0, y0 + h - 3 * k, S, 3 * k);
  }
  noise(x, S, S, S * 4, 0.05, R); return { map: c, nor: normalFromHeight(hc, 1.5) };
}
// donkere tuinaarde met bladval
function texSoil() {
  const S = 256, c = mkCanvas(S), x = c.getContext('2d'), R = rng(52);
  x.fillStyle = '#2e241b'; x.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) { x.fillStyle = hsl(24 + R() * 12, 22 + R() * 14, 10 + R() * 16); x.beginPath(); x.arc(R() * S, R() * S, 0.8 + R() * 2.2, 0, PI * 2); x.fill(); }
  for (let i = 0; i < 40; i++) { x.fillStyle = hsl(20 + R() * 25, 35 + R() * 25, 22 + R() * 22, 0.9); x.beginPath(); x.ellipse(R() * S, R() * S, 3 + R() * 4, 2 + R() * 2, R() * PI, 0, PI * 2); x.fill(); }
  noise(x, S, S, 1500, 0.08, R); return c;
}
function texFlat(color, n = 1200, amp = 0.06) { const S = 128, c = mkCanvas(S), x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, S, S); noise(x, S, S, n, amp, rng(71)); return c; }
// bladkaarten in grijstinten (kleur komt per instance): ovaal met nerven (laurier, beuk, boomblad) en gelobd (geranium)
function texLeaf(kind) {
  const S = 64, c = mkCanvas(S), x = c.getContext('2d');
  const g = x.createLinearGradient(0, S, 0, 0); g.addColorStop(0, '#9a9a9a'); g.addColorStop(1, '#e4e4e4'); x.fillStyle = g;
  if (kind === 'oval') {
    const path = () => { x.beginPath(); x.moveTo(32, 63); x.bezierCurveTo(60, 44, 56, 14, 32, 1); x.bezierCurveTo(8, 14, 4, 44, 32, 63); };
    path(); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(32, 60); x.lineTo(32, 6); x.stroke();
    x.lineWidth = 0.8; for (let i = 0; i < 6; i++) { const y = 12 + i * 8; x.beginPath(); x.moveTo(32, y + 6); x.lineTo(48, y - 2); x.moveTo(32, y + 6); x.lineTo(16, y - 2); x.stroke(); }
    x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1.5; path(); x.stroke();
  } else {
    const lobe = l => { const a = -PI / 2 + l * PI * 2 / 5; x.beginPath(); x.ellipse(32 + Math.cos(a) * 15, 34 + Math.sin(a) * 15, 15, 10, a, 0, PI * 2); };
    for (let l = 0; l < 5; l++) { lobe(l); x.fill(); } x.beginPath(); x.arc(32, 34, 15, 0, PI * 2); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.3)'; x.lineWidth = 1.2; for (let l = 0; l < 5; l++) { const a = -PI / 2 + l * PI * 2 / 5; x.beginPath(); x.moveTo(32, 34); x.lineTo(32 + Math.cos(a) * 27, 34 + Math.sin(a) * 27); x.stroke(); }
    x.strokeStyle = 'rgba(0,0,0,.3)'; x.lineWidth = 1; for (let l = 0; l < 5; l++) { lobe(l); x.stroke(); }
    x.strokeStyle = '#8a8a8a'; x.lineWidth = 2; x.beginPath(); x.moveTo(32, 48); x.lineTo(32, 63); x.stroke();
  }
  return c;
}
// graspol met pluimen (siergras / miscanthus): halmen in lichtgrijs-groen, pluimen bijna wit; kleur per instance
function texTuft() {
  const W = 128, H = 256, c = mkCanvas(W, H), x = c.getContext('2d'), R = rng(21);
  for (let b = 0; b < 16; b++) {
    const x0 = W * (0.2 + R() * 0.6), top = H * (0.05 + R() * 0.3), bend = (R() - .5) * 60, w0 = 2 + R() * 3, l0 = 48 + R() * 10, l1 = 60 + R() * 12;
    const g = x.createLinearGradient(0, H, 0, top); g.addColorStop(0, hsl(75, 12, l0)); g.addColorStop(1, hsl(70, 14, l1)); x.fillStyle = g;
    x.beginPath(); x.moveTo(x0 - w0 / 2, H); x.quadraticCurveTo(x0 + bend * 0.3 - w0 / 4, (H + top) / 2, x0 + bend, top); x.quadraticCurveTo(x0 + bend * 0.3 + w0 / 4, (H + top) / 2, x0 + w0 / 2, H); x.closePath(); x.fill();
  }
  for (let p = 0; p < 5; p++) {   // pluimen: veerachtige strepen boven de halmen
    const x0 = W * (0.25 + R() * 0.5), y0 = H * (0.02 + R() * 0.12), len = 40 + R() * 30, bend = (R() - .5) * 30;
    x.strokeStyle = hsl(40, 25, 86, 0.9); x.lineWidth = 3.5; x.beginPath(); x.moveTo(x0, y0 + len); x.quadraticCurveTo(x0 + bend, y0 + len / 2, x0 + bend * 1.5, y0); x.stroke();
    x.lineWidth = 1.2; for (let i = 0; i < 14; i++) { const t = i / 14, px = x0 + bend * 1.5 * t * t + bend * 0.5 * t, py = y0 + len * (1 - t); x.beginPath(); x.moveTo(px, py); x.lineTo(px + (R() - .5) * 14, py - 3 - R() * 6); x.stroke(); }
  }
  return c;
}

/* ===================================================== GEOMETRIE-HULP ===================================================== */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(), _m3 = new THREE.Matrix3();
class Merger {   // één mesh per materiaalsleutel (positie, normaal, uv, kleur)
  constructor() { this.m = new Map(); }
  b(k) { let x = this.m.get(k); if (!x) { x = { p: [], n: [], u: [], c: [] }; this.m.set(k, x); } return x; }
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
    this.prism(keys, [V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1)], col);
  }
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
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const place = (x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(s, s, s));
function cylBetween(mg, k, a, b, r, col) {
  const d = V(0, 0, 0).subVectors(b, a), l = d.length(), mid = V(0, 0, 0).addVectors(a, b).multiplyScalar(0.5);
  mg.geo(k, new THREE.CylinderGeometry(r, r, l, 7), new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1)), col);
}
function rbox(w, h, d, r) {   // afgeronde doos, gecentreerd
  const sh = new THREE.Shape(), hw = w / 2 - r, hd = d / 2 - r;
  sh.moveTo(-hw, -hd - r); sh.lineTo(hw, -hd - r); sh.absarc(hw, -hd, r, -PI / 2, 0, false); sh.lineTo(hw + r, hd); sh.absarc(hw, hd, r, 0, PI / 2, false); sh.lineTo(-hw, hd + r); sh.absarc(-hw, hd, r, PI / 2, PI, false); sh.lineTo(-hw - r, -hd); sh.absarc(-hw, -hd, r, PI, 1.5 * PI, false);
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, h - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.999, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(-PI / 2); g.computeBoundingBox(); const bb = g.boundingBox; g.translate(0, -(bb.min.y + bb.max.y) / 2, 0); return g;
}

/* ===================================================== VASTE MATEN ===================================================== */
// perceel x −0.78…9.43, straatkant z 18.5; gevel z 12.47 (hoofdblok x 3.0…9.22), vleugelgevel z 9.28 (x −0.22…3.0)
const ZF = 12.47, ZPLOT = 18.5, XPLOT0 = -0.78, XPLOT1 = 9.43;
const BED = { x0: 3.15, x1: XPLOT1, z0: 13.6, z1: 18.3 };                 // border achter de grindstrook, tot de stoep
const STREET = { walk0: ZPLOT, walk1: 20.4, road1: 26.5, walk2: 28.4 };    // stoep, rijbaan + parkeerstrook, stoep overkant
const HEDGE2 = { z0: 27.0, z1: 27.6, h: 1.4 };                            // getrimde haag aan de overkant
const ROW = { zF: 30.2, zB: 39.2 };                                       // woningen aan de overkant

/* ===================================================== INSTALL ===================================================== */
export function install(H) {
  const scene = H.scene, root = new THREE.Group(); root.name = 'voortuin-module';
  if (typeof H.addToRoom === 'function') H.addToRoom('voortuin', root); else scene.add(root);
  const onTick = typeof H.onTick === 'function' ? H.onTick : fn => { let last = performance.now(); const f = t => { fn(Math.min(0.05, (t - last) / 1000)); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return () => { }; };
  const addCol = (x0, x1, z0, z1) => { const c = H.colliders && H.colliders[0]; if (Array.isArray(c)) c.push([Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1)]); };
  const MSM = THREE.MeshStandardMaterial, R = rng(2026);

  /* ---- materialen ---- */
  const grav = texGravel(), clk = texClinker(), tl30 = texTiles30(), clad = texClad();
  const nmat = (map, su, sv, o = {}) => new MSM({ map: tex(map.map, su, sv), normalMap: tex(map.nor, su, sv, false), normalScale: new THREE.Vector2(o.ns ?? 1, o.ns ?? 1), roughness: o.rough ?? 0.95, color: o.color || '#ffffff' });
  const mat = {
    gravel: nmat(grav, 1, 1, { ns: 1.2 }), clinker: nmat(clk, 1.05, 1.05, { ns: 0.9, rough: 0.9 }), tiles: nmat(tl30, 0.9, 0.9, { ns: 0.7 }),
    clad: nmat(clad, 1.2, 1.2, { ns: 0.9, rough: 0.9 }), soil: new MSM({ map: tex(texSoil(), 0.8), roughness: 1 }),
    band: new MSM({ map: tex(texFlat('#8e8b84', 1800, 0.1), 0.6), roughness: 0.9 }), render: new MSM({ map: tex(texFlat('#ddd3bf', 1500, 0.08), 0.8), roughness: 0.95 }),
    brick: new MSM({ color: '#b86a52', roughness: 0.9 }), brickY: new MSM({ color: '#cdb98f', roughness: 0.9 }),   // tot de foto-texturen geladen zijn
    roof: new MSM({ color: '#5a5c5c', roughness: 0.8 }), fascia: new MSM({ color: '#2b2d2f', roughness: 0.5 }), trim: new MSM({ color: '#f1f0eb', roughness: 0.45 }),
    door: new MSM({ color: '#2f3b45', roughness: 0.5 }), winDark: new MSM({ color: '#131c24', roughness: 0.3, metalness: 0.0, envMapIntensity: 0.45 }),
    winLit: new MSM({ color: '#2a2622', emissive: '#ffd2a0', emissiveIntensity: 0, roughness: 0.3, metalness: 0.0, envMapIntensity: 0.4 }),
    glass: new MSM({ color: '#0b1014', roughness: 0.12, metalness: 0.0, envMapIntensity: 0.9 }),
    paint: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.9 }),   // autolak met blanke lak
    lens: new MSM({ color: '#78848b', roughness: 0.08, metalness: 0.8, envMapIntensity: 1.0 }), taillight: new MSM({ color: '#8c0f12', roughness: 0.15, envMapIntensity: 0.8 }),
    tyre: new MSM({ color: '#141414', roughness: 0.9 }), rim: new MSM({ color: '#9ea2a6', metalness: 0.7, roughness: 0.35 }), lamp: new MSM({ color: '#f3e4c8', emissive: '#ffd59a', emissiveIntensity: 0, roughness: 0.4 }),
    pole: new MSM({ color: '#4f5450', roughness: 0.6, metalness: 0.3 }), black: new MSM({ color: '#111213', roughness: 0.6 }), bark: new MSM({ color: '#4a3d31', roughness: 0.95 }),
    stake: new MSM({ color: '#8a6d4a', roughness: 0.9 }), colored: new MSM({ vertexColors: true, roughness: 0.95 }), mat: new MSM({ color: '#1c1c1c', roughness: 1 }),
    mailbox: new MSM({ color: '#17483a', roughness: 0.45, metalness: 0.2 }), charger: new MSM({ color: '#3a3d41', roughness: 0.35 }), spot: new MSM({ color: '#1b1b1b', emissive: '#ffd9a0', emissiveIntensity: 0, roughness: 0.5 }),
  };
  // baksteen en dakpannen: dezelfde CC0 foto-sets als de woning zelf (assets/, zie manifest.json), getint
  const loader = new THREE.TextureLoader();
  const asset = (base, size, mats, ns) => { for (const [sfx, key, srgb] of [['diff', 'map', true], ['nor', 'normalMap', false]]) loader.load(`assets/${base}_${sfx}.jpg`, t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / size, 1 / size); t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; for (const m of mats) { m[key] = t; if (key === 'normalMap') m.normalScale.set(ns, ns); m.needsUpdate = true; } }, undefined, () => { }); };
  asset('brick', 0.9, [mat.brick, mat.brickY], 0.8); mat.brick.color.set('#d9cfc6'); mat.brickY.color.set('#e8d8a8');
  asset('roof_tiles', 3.0, [mat.roof], 0.9); mat.roof.color.set('#7a7c7c');

  // twee zones (voortuin / overkant) zodat de frustum-culling werkt en alleen de voortuin schaduw werpt (zonbereik z < 17)
  const near = new Merger(), far = new Merger(), meshes = {}, api = { installed: true, root, mat, Q };
  let statics = near, zone = '';
  const leaves = { oval: [], lobed: [], 'oval@far': [], 'lobed@far': [] }, tufts = [];
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3();
  function leafAt(kind, x, y, z, nx, ny, nz, size, col) {
    _d.set(nx, ny, nz).normalize(); _q.setFromUnitVectors(_p.set(0, 0, 1), _d); _e.set(0, 0, R() * PI * 2); _q.multiply(new THREE.Quaternion().setFromEuler(_e));
    leaves[kind + zone].push({ m: new THREE.Matrix4().compose(V(x, y, z), _q, _s.set(size, size, size)), c: col });
  }
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)], mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
  const lump = (th, ph) => 0.9 + 0.2 * Math.abs(Math.sin(th * 2.5 + ph * 3.1)) * Math.abs(Math.cos(th * 1.7 - ph * 2.3));
  const SUN = V(0.3, 0.75, 0.6).normalize();
  // bladkleur: donker binnenin, lichter en warmer aan de zonkant; 'autumn' = aandeel verkleurd blad
  function leafCol(col, dx, dy, dz, k, autumn = 0) {
    const d = clamp((dx * SUN.x + dy * SUN.y + dz * SUN.z) * 0.5 + 0.5, 0, 1);
    let c = mix(col[0], col[1], clamp(0.15 + 0.6 * d + (R() - .5) * 0.3, 0, 1));
    c = k < 0.66 ? mul(c, 0.6) : [c[0] * (1 + 0.14 * d), c[1] * (1 + 0.06 * d), c[2]];
    if (R() < autumn) c = mix(c, R() < 0.7 ? [0.62, 0.36, 0.08] : [0.6, 0.2, 0.05], 0.7 + R() * 0.3);
    return c;
  }
  const C = { laurel: [[0.03, 0.09, 0.03], [0.13, 0.27, 0.08]], green: [[0.12, 0.26, 0.08], [0.36, 0.52, 0.18]], young: [[0.2, 0.36, 0.12], [0.5, 0.6, 0.2]], autumn: [[0.42, 0.17, 0.04], [0.8, 0.44, 0.1]],
    cover: [[0.13, 0.3, 0.08], [0.4, 0.58, 0.18]], beech: [[0.3, 0.14, 0.05], [0.56, 0.31, 0.1]], hedge: [[0.07, 0.17, 0.05], [0.24, 0.4, 0.12]], tree: [[0.14, 0.26, 0.08], [0.4, 0.5, 0.16]], viburnum: [[0.08, 0.18, 0.06], [0.26, 0.42, 0.15]] };
  // kernklomp (donker, beschaduwd binnenblad): icosaeder met verschoven hoekpunten
  function coreGeo(seed) {
    const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), f = 1 + 0.3 * Math.sin(x * 12.9 + seed) * Math.cos(y * 7.3 - seed) * Math.sin(z * 9.1 + seed * 0.7); P.setXYZ(i, x * f, y * f, z * f); }
    g.computeVertexNormals(); return g;
  }
  const coreCol = c => mul(c, 0.35);
  // bladwolk (ellipsoïde) rond (x, cy, z): rx/ry stralen, n kaarten; o: kind, size, col, bottom (min. dy), holes, core, autumn, sparse
  function blob(x, cy, z, rx, ry, n, o) {
    const col = o.col, kind = o.kind || 'oval'; n = Math.round(n * Q.leaf);
    if (o.core !== false) statics.geo('colored', coreGeo(x + z), place(x, cy, z, R() * PI).scale(V(rx * (o.core || 0.72), ry * (o.core || 0.72), rx * (o.core || 0.72))), coreCol(col[0]));
    for (let i = 0; i < n; i++) {
      const th = R() * PI * 2, ph = Math.acos(1 - 2 * R()), dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      if (dy < (o.bottom ?? -0.6)) continue;
      let k = (0.55 + R() * 0.6) * lump(th * 1.3, ph);
      if (o.holes && Math.sin(th * 3.7 + ph * 2.9) * Math.cos(th * 1.3 - ph * 4.1) > o.holes) continue;
      if (o.sparse && k > 0.9 && R() < o.sparse) continue;
      if (R() < 0.12) k *= 1.2;
      leafAt(kind, x + dx * rx * k, cy + dy * ry * k, z + dz * rx * k, dx, dy + 0.25, dz, o.size * (0.75 + R() * 0.5), leafCol(col, dx, dy, dz, k, o.autumn));
    }
  }
  // boom: stam tot de vork, 3-4 hoofdtakken met een zijtak, deelkronen voorbij de takeinden
  function tree(x, z, o) {
    const { h, r, cy, n, col, size = 0.14, autumn = 0, stems = 1, trunkR = 0.08, kind = 'oval', sparse = 0.3, bare = 0 } = o, m = Math.round(n * Q.leaf);
    const forkY = h * (0.55 + R() * 0.15), tops = [];
    for (let s = 0; s < stems; s++) { const ox = stems > 1 ? (R() - .5) * 0.35 : 0, oz = stems > 1 ? (R() - .5) * 0.35 : 0, top = V(x + ox * 2.2, forkY, z + oz * 2.2); cylBetween(statics, 'bark', V(x + ox, -0.05, z + oz), top, trunkR); tops.push(top); }
    const nb = 3 + (R() < 0.5 ? 1 : 0), th0 = R() * PI * 2, subs = [];
    for (let b = 0; b < nb; b++) {
      const th = th0 + b * PI * 2 / nb + (R() - .5) * 0.9, len = r * (0.35 + R() * 0.45), rise = (cy - forkY) * (0.5 + R() * 0.7), base = tops[b % tops.length];
      const end = V(base.x + Math.cos(th) * len, base.y + rise, base.z + Math.sin(th) * len); cylBetween(statics, 'bark', base, end, trunkR * 0.5);
      const mid = base.clone().lerp(end, 0.55), th2 = th + (R() < 0.5 ? 1 : -1) * (0.5 + R() * 0.6), l2 = len * (0.5 + R() * 0.4), e2 = V(mid.x + Math.cos(th2) * l2, mid.y + rise * 0.5, mid.z + Math.sin(th2) * l2);
      cylBetween(statics, 'bark', mid, e2, trunkR * 0.28);
      if (bare) for (let t = 0; t < bare; t++) { const th3 = th + (R() - .5) * 1.4, l3 = r * (0.3 + R() * 0.4); cylBetween(statics, 'bark', end, V(end.x + Math.cos(th3) * l3, end.y + l3 * (0.4 + R() * 0.6), end.z + Math.sin(th3) * l3), trunkR * 0.12); }
      const rr = r * (0.32 + R() * 0.5);
      subs.push({ c: V(end.x + Math.cos(th) * rr * 0.35, end.y + rr * 0.3, end.z + Math.sin(th) * rr * 0.35), r: rr });
      subs.push({ c: V(e2.x + Math.cos(th2) * 0.15, e2.y + 0.15, e2.z + Math.sin(th2) * 0.15), r: r * (0.2 + R() * 0.22) });
    }
    subs.push({ c: V(tops[0].x, cy + r * 0.15, tops[0].z), r: r * (0.45 + R() * 0.2) });
    const tot = subs.reduce((a, q) => a + q.r * q.r, 0);
    if (o.core !== false) subs.forEach((q, i) => statics.geo('colored', coreGeo(i + x), place(q.c.x, q.c.y, q.c.z, R() * PI).scale(V(q.r * 0.3, q.r * 0.26, q.r * 0.3)), coreCol(col[0])));
    for (let i = 0; i < m; i++) {
      let rr = R() * tot, si = 0; while (rr > subs[si].r * subs[si].r && si < subs.length - 1) { rr -= subs[si].r * subs[si].r; si++; }
      const q = subs[si], th = R() * PI * 2, ph = Math.acos(1 - 2 * R()), k = (0.4 + R() * 0.65) * lump(th + si, ph);
      if (Math.sin(th * 3.1 + si * 2.0) * Math.cos(ph * 2.7 + si) > 0.62) continue;
      if (k > 0.95 && R() < sparse) continue;
      const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
      leafAt(kind, q.c.x + dx * q.r * k, q.c.y + dy * q.r * 0.85 * k, q.c.z + dz * q.r * k, dx, dy + 0.1, dz, size * (k > 0.85 ? 0.7 : 1.0) * (0.75 + R() * 0.5), leafCol(col, dx, dy, dz, k, autumn));
    }
  }
  // haag: donkere kern + bladkaarten op de zijvlakken en bovenop
  function hedgeRun(ax, az, bx, bz, w, h, perM2, col, core = true) {
    const L = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bz - az, bx - ax), nx = -Math.sin(ang), nz = Math.cos(ang), n = Math.round(perM2 * Q.leaf * L * (2 * h + w));
    if (core) statics.geo('colored', new THREE.BoxGeometry(L, h - 0.08, w - 0.1), place((ax + bx) / 2, (h - 0.08) / 2, (az + bz) / 2, -ang), coreCol(col[0]));
    const side = h * 2 / (h * 2 + w);
    for (let i = 0; i < n; i++) {
      const t = R(), f = R(), px = ax + (bx - ax) * t, pz = az + (bz - az) * t, dd = 0.03 * Math.sin(t * L * 1.9 + 0.7) + (R() - .5) * 0.05;
      let x, y, z, ox, oy, oz;
      if (f < side * 0.5) { x = px + nx * (w / 2 + 0.02 + dd); z = pz + nz * (w / 2 + 0.02 + dd); y = 0.08 + R() * (h - 0.12); ox = nx; oy = 0.15; oz = nz; }
      else if (f < side) { x = px - nx * (w / 2 + 0.02 + dd); z = pz - nz * (w / 2 + 0.02 + dd); y = 0.08 + R() * (h - 0.12); ox = -nx; oy = 0.15; oz = -nz; }
      else { const u = (R() - .5) * w; x = px + nx * u; z = pz + nz * u; y = h - 0.04 + R() * 0.08; ox = u * 0.8; oy = 1; oz = 0; }
      leafAt('oval', x + (R() - .5) * 0.06, y, z + (R() - .5) * 0.06, ox + (R() - .5) * 0.9, oy + (R() - .5) * 0.6, oz + (R() - .5) * 0.9, 0.08 + R() * 0.05, mix(col[0], col[1], R()));
    }
  }
  const tuft = (x, z, r, h, n, col) => { for (let i = 0; i < n; i++) { const th = R() * PI * 2, rr = Math.sqrt(R()) * r; tufts.push([x + Math.cos(th) * rr, z + Math.sin(th) * rr, h * (0.8 + R() * 0.4), R() * PI * 2, mix(col[0], col[1], R())]); } };

  /* =================================================== GROND: GRIND, BORDER, STRAAT =================================================== */
  const G = { py: 'gravel', def: 'band' };
  statics.box(G, XPLOT0, 3.15, -0.02, 0.0, 9.28, ZPLOT);                       // oprit (open naar de straat, geen haag)
  statics.box(G, 3.15, XPLOT1, -0.02, 0.0, ZF, BED.z0);                         // strook langs de gevel, tot de voordeur
  statics.box(G, -5.2, -1.94, -0.02, 0.0, 12.39, ZPLOT); statics.box({ py: 'tiles', def: 'band' }, -1.94, XPLOT0, -0.02, 0.0, 0, ZPLOT);   // oprit en zijpad van de buren op −X
  statics.box({ py: 'soil', def: 'soil' }, BED.x0, BED.x1, -0.03, -0.01, BED.z0, BED.z1);
  const band = (x0, x1, z0, z1, h = 0.045) => statics.box('band', x0, x1, -0.01, h, z0, z1);
  band(BED.x0 - 0.06, BED.x1, BED.z0 - 0.06, BED.z0); band(BED.x0 - 0.06, BED.x0, BED.z0, BED.z1 + 0.06); band(BED.x0 - 0.06, BED.x1, BED.z1, BED.z1 + 0.06);   // opsluitbanden
  // stoep (grijze tegels), rijbaan + parkeerstrook (klinkers), stoep overkant; trottoirbanden; inrit vlak
  statics.box({ py: 'tiles', def: 'band' }, -16, 26, -0.03, 0.01, STREET.walk0, STREET.walk1);
  statics.box({ py: 'clinker', def: 'band' }, -16, 26, -0.03, -0.015, STREET.walk1, STREET.road1);
  statics.box({ py: 'tiles', def: 'band' }, -16, 26, -0.03, 0.01, STREET.road1, STREET.walk2);
  for (const z of [STREET.walk1, STREET.road1]) band(-16, 26, z - 0.08, z + 0.08, 0.02);
  band(-16, XPLOT0, ZPLOT - 0.08, ZPLOT + 0.04, 0.02); band(XPLOT1, 26, ZPLOT - 0.08, ZPLOT + 0.04, 0.02);
  // voordeur: mat op het grind, brievenbus en laadpaal aan de gevel (foto's exterior_1)
  statics.box('mat', 7.25, 7.95, 0, 0.015, ZF, ZF + 0.5);
  statics.box('mailbox', 8.68, 8.98, 1.25, 1.62, ZF, ZF + 0.13); statics.box('black', 8.72, 8.94, 1.5, 1.52, ZF + 0.13, ZF + 0.145);
  statics.geo('charger', rbox(0.2, 0.38, 0.11, 0.04), place(9.1, 1.25, ZF + 0.06)); statics.box('black', 9.06, 9.14, 0.85, 1.06, ZF, ZF + 0.03);

  /* =================================================== AUTO'S (geen kenteken) =================================================== */
  // compacte cross-over (4,45 x 1,82 x 1,58 m), neus naar −Z. Zijprofiel (z, y) met wielkasten, over de breedte geëxtrudeerd
  // met afgeronde schouders; de kabine is een tweede, smallere extrusie in glas (tumblehome) met stijlen en dak in lak.
  function profile(shape, w, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: w - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.999, bevelOffset: -bevel, bevelSegments: 3, curveSegments: 10 });   // offset -bevel: profiel = buitenmaat, kopvlakken ingetrokken
    g.rotateY(-PI / 2); g.translate((w - 2 * bevel) / 2, 0, 0); return g;   // vorm-x -> z, extrusie -> x (gecentreerd)
  }
  const WZ = 1.38, WY = 0.335, TR = 0.335, ARCH = 0.42, a0 = Math.asin((0.28 - WY) / ARCH);   // wielen, wielkast
  function bodyShape() {
    const s = new THREE.Shape(); s.moveTo(2.18, 0.28);
    s.lineTo(WZ + ARCH * Math.cos(a0), 0.28); s.absarc(WZ, WY, ARCH, a0, PI - a0, false); s.lineTo(-WZ + ARCH * Math.cos(a0), 0.28); s.absarc(-WZ, WY, ARCH, a0, PI - a0, false);
    s.lineTo(-2.14, 0.28); s.quadraticCurveTo(-2.24, 0.30, -2.24, 0.42); s.lineTo(-2.22, 0.72); s.quadraticCurveTo(-2.18, 0.86, -2.0, 0.90);   // bumper, neus
    s.lineTo(-0.85, 1.02); s.quadraticCurveTo(-0.72, 1.05, -0.60, 1.06); s.lineTo(1.95, 1.06);                                                   // motorkap, gordellijn
    s.quadraticCurveTo(2.16, 1.06, 2.20, 0.92); s.lineTo(2.22, 0.45); s.quadraticCurveTo(2.22, 0.30, 2.18, 0.28); return s;                       // achterklep
  }
  function cabinShape() {
    const s = new THREE.Shape(); s.moveTo(-0.62, 0.94); s.lineTo(0.05, 1.50); s.quadraticCurveTo(0.15, 1.56, 0.35, 1.56); s.lineTo(1.25, 1.56);
    s.quadraticCurveTo(1.55, 1.56, 1.75, 1.40); s.lineTo(2.02, 0.94); return s;   // voorruit, dak, achterruit; voet zit 12 cm in de carrosserie
  }
  function car(x, z, ry, col) {
    const M = place(x, 0, z, ry), at = (k, g, lx, ly, lz, c, ryy = 0, rx = 0, rz = 0) => statics.geo(k, g, M.clone().multiply(place(lx, ly, lz, ryy, 1, rx, rz)), c || undefined);
    const P = (lx, ly, lz) => V(lx, ly, lz).applyMatrix4(M), dark = [0.05, 0.05, 0.055];
    at('paint', profile(bodyShape(), 1.82, 0.08), 0, 0, 0, col); at('glass', profile(cabinShape(), 1.62, 0.10), 0, 0, 0);
    at('black', new THREE.BoxGeometry(1.62, 0.70, 3.6), 0, 0.51, 0);                                 // wielkasten / onderstel (vult de kasten van binnen, blijft onder de motorkap)
    at('black', rbox(1.80, 0.14, 1.84, 0.04), 0, 0.22, 0); for (const bz of [-2.02, 2.02]) at('black', rbox(1.80, 0.14, 0.36, 0.04), 0, 0.22, bz);   // donkere dorpel en bumperlippen
    at('paint', rbox(1.40, 0.025, 0.95, 0.012), 0, 1.565, 0.80, col);                                // dakpaneel
    for (const sx of [-1, 1]) {
      cylBetween(statics, 'paint', P(sx * 0.80, 1.04, -0.60), P(sx * 0.73, 1.52, 0.08), 0.035, col);  // A-stijl
      cylBetween(statics, 'paint', P(sx * 0.80, 1.04, 2.02), P(sx * 0.74, 1.42, 1.72), 0.055, col);  // C-stijl
      at('black', new THREE.BoxGeometry(0.03, 0.46, 0.08), sx * 0.805, 1.27, 0.76);                   // B-stijl
      at('black', rbox(0.04, 0.04, 1.30, 0.015), sx * 0.66, 1.595, 0.80);                              // dakrail
      at('black', new THREE.BoxGeometry(0.12, 0.035, 0.06), sx * 0.90, 1.08, -0.45); at('paint', rbox(0.09, 0.10, 0.18, 0.03), sx * 0.99, 1.12, -0.45, col);   // spiegel
      for (const hz of [-0.25, 0.85]) at('black', rbox(0.03, 0.03, 0.16, 0.012), sx * 0.915, 0.90, hz);                                                      // deurgrepen
      at('lens', rbox(0.48, 0.12, 0.05, 0.025), sx * 0.58, 0.80, -2.19, null, -sx * 0.2);              // koplamp, iets om de hoek gebogen
      for (const dz of [-0.62, 0.45, 1.55]) at('black', new THREE.BoxGeometry(0.012, 0.62, 0.012), sx * 0.912, 0.67, dz);                           // deurnaden
      at('taillight', rbox(0.42, 0.11, 0.08, 0.025), sx * 0.60, 0.90, 2.18, null, sx * 0.25);          // achterlicht
      for (const wz of [-WZ, WZ]) {   // wiel: band, velgring, donkere schotel, 5 spaken, naaf (as langs X)
        const WX = 0.74, wg = (k, g, dx, rx = 0) => statics.geo(k, g, M.clone().multiply(place(sx * (WX + dx), WY, wz, 0, 1, rx, rx ? 0 : PI / 2)));
        wg('tyre', new THREE.CylinderGeometry(TR, TR, 0.235, 28), 0); wg('rim', new THREE.CylinderGeometry(0.225, 0.225, 0.10, 24), 0.075);
        wg('black', new THREE.CylinderGeometry(0.19, 0.19, 0.02, 24), 0.125); wg('rim', new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), 0.135);
        for (let k = 0; k < 5; k++) wg('rim', new THREE.BoxGeometry(0.03, 0.17, 0.05).translate(0, 0.105, 0), 0.132, k * PI * 2 / 5 + 0.3);
      }
    }
    at('black', rbox(1.00, 0.18, 0.06, 0.03), 0, 0.64, -2.21); at('black', rbox(1.30, 0.14, 0.05, 0.03), 0, 0.38, -2.23);   // grille, onderste luchtinlaat
    at('black', new THREE.BoxGeometry(0.06, 0.04, 0.12), 0, 1.575, 1.35);                                                      // haaienvin
    at('colored', rbox(0.52, 0.11, 0.012, 0.01), 0, 0.48, -2.245, [0.9, 0.9, 0.88]); at('colored', rbox(0.52, 0.11, 0.012, 0.01), 0, 0.70, 2.225, [0.92, 0.72, 0.08]);   // blanco kentekens (wit voor, geel achter)
    at('black', rbox(0.58, 0.16, 0.02, 0.01), 0, 0.70, 2.21, dark);                                                           // kentekenplaathouder
  }
  car(1.2, 16.2, 0, [0.025, 0.027, 0.032]); addCol(0.3, 2.1, 14.0, 18.4);          // onze auto, zwart, neus naar het huis (exterior_1)
  car(-5.8, 25.4, PI / 2, [0.80, 0.82, 0.83]); addCol(-8.0, -3.6, 24.5, 26.3);    // overkant, wit, langs de stoep (voortuin_1 rechts)

  /* =================================================== BORDER (foto voortuin_1, rechts in beeld = −X) =================================================== */
  // grote groenblijver (laurier/photinia), drie stammen, kroon tot vlak boven de grond
  { const x = 4.1, z = 16.1; for (let s = 0; s < 3; s++) { const th = s * 2.1 + 0.4; cylBetween(statics, 'bark', V(x + Math.cos(th) * 0.12, -0.05, z + Math.sin(th) * 0.12), V(x + Math.cos(th) * 0.55, 2.6, z + Math.sin(th) * 0.55), 0.045); }
    blob(x, 2.35, z, 1.7, 1.85, 8000, { col: C.laurel, size: 0.17, bottom: -0.78, core: 0.8 }); addCol(x - 0.25, x + 0.25, z - 0.25, z + 0.25); }
  // jong boompje aan een paal (midden), kleine blaadjes, wat vergeeld
  { const x = 5.35, z = 14.75; tree(x, z, { h: 2.4, r: 0.85, cy: 2.3, n: 1300, col: C.young, size: 0.085, trunkR: 0.025, autumn: 0.2, core: false, sparse: 0.4 });
    statics.geo('stake', new THREE.CylinderGeometry(0.028, 0.028, 1.9, 8), place(x + 0.13, 0.9, z - 0.04)); statics.geo('black', new THREE.TorusGeometry(0.09, 0.012, 5, 10), place(x + 0.06, 1.55, z - 0.02, 0, 1, PI / 2)); }
  // herfstboompje links (oranjebruin, ijl, kale twijgen) en de struiken
  tree(8.15, 17.1, { h: 3.4, r: 1.35, cy: 3.0, n: 1700, col: C.autumn, size: 0.1, trunkR: 0.05, sparse: 0.55, bare: 2, core: false }); addCol(8.0, 8.3, 16.95, 17.25);
  blob(3.55, 0.6, 14.75, 0.62, 0.62, 1400, { col: C.viburnum, size: 0.1, bottom: -0.5 });           // donkere bolstruik rechts voor de groenblijver
  blob(8.3, 0.7, 14.6, 0.85, 0.72, 1800, { col: C.green, size: 0.09, bottom: -0.5, holes: 0.3 });   // kleinbladige struik links
  blob(7.0, 0.75, 15.7, 0.7, 0.75, 900, { kind: 'lobed', col: C.green, size: 0.15, bottom: -0.4, holes: 0.25 });   // hortensia-achtig, groot blad
  blob(6.2, 0.9, 17.3, 0.9, 0.9, 1800, { col: C.green, size: 0.1, bottom: -0.5, holes: 0.3 });       // achterin, tegen de stoep
  // siergrassen met pluimen en wat onkruidpollen
  const GC = [[0.5, 0.52, 0.28], [0.68, 0.66, 0.38]];
  tuft(4.75, 15.0, 0.4, 1.45, 16, GC); tuft(6.3, 15.9, 0.35, 1.25, 12, GC); tuft(3.6, 17.5, 0.3, 1.1, 10, GC);
  for (let i = 0; i < 24; i++) tuft(BED.x0 + 0.2 + R() * 4.5, BED.z0 + 0.2 + R() * 1.6, 0.08, 0.3 + R() * 0.2, 2, [[0.3, 0.42, 0.14], [0.45, 0.55, 0.2]]);
  // bodembedekker (gelobd blad, geranium-achtig) in de voorste meter van de border
  { const n = Math.round(4200 * Q.leaf), blocked = [[3.55, 14.75, 0.5], [5.35, 14.75, 0.3], [8.3, 14.6, 0.7], [4.75, 15.0, 0.35], [4.1, 16.1, 0.8], [7.0, 15.7, 0.5], [6.2, 17.3, 0.7]];
    for (let i = 0; i < n; i++) {
      const x = BED.x0 + 0.1 + R() * 6.0, z = BED.z0 + 0.1 + R() * (R() < 0.55 ? 1.7 : 4.4); if (blocked.some(([bx, bz, br]) => (x - bx) ** 2 + (z - bz) ** 2 < br * br)) continue;
      const y = 0.05 + R() * 0.25, s = 0.09 + R() * 0.06, lc = mix(C.cover[0], C.cover[1], R()), f = 0.55 + y * 1.6;
      leafAt('lobed', x, y, z, (R() - .5) * 0.8, 1, (R() - .5) * 0.8, s, mul(lc, f));
    }
  }
  // beukenhaag op de erfgrens (bruin blad in de herfst), tot de stoep
  hedgeRun(9.45, 14.0, 9.45, ZPLOT, 0.5, 1.3, 130, C.beech); addCol(9.2, 9.7, 14.0, ZPLOT);
  // prikspots in de border
  for (const x of [4.3, 7.4]) { statics.geo('black', new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6), place(x, 0.2, 13.85)); statics.geo('spot', new THREE.CylinderGeometry(0.035, 0.028, 0.09, 8), place(x, 0.44, 13.85, 0, 1, -0.5)); }

  /* =================================================== OVERKANT: HAAG, WONINGEN, BOMEN, LANTAARN =================================================== */
  statics = far; zone = '@far';
  for (const [a, b] of [[-14, -5.0], [-2.2, 4.6], [5.6, 12.0], [13.2, 26]]) { hedgeRun(a, HEDGE2.z0 + 0.3, b, HEDGE2.z0 + 0.3, 0.6, HEDGE2.h, 70, C.hedge); addCol(a, b, HEDGE2.z0, HEDGE2.z1); }
  // kozijn + glas (wit, met tussenstijl) in een gevel op z = zF; d = −1 als de gevel naar +Z kijkt; een deel brandt 's avonds
  const WR = rng(9);
  function win(x0, x1, y0, y1, zF, mull = true, door = false, d = 1) {
    const B = (k, xa, xb, ya, yb, a, b) => { const z0 = zF + (d > 0 ? a : -b), z1 = zF + (d > 0 ? b : -a); statics.box(k, xa, xb, ya, yb, z0, z1); };
    B('trim', x0 - 0.06, x1 + 0.06, y0 - 0.06, y1 + 0.06, -0.05, 0.02);
    B(door ? 'door' : WR() < 0.45 ? 'winLit' : 'winDark', x0, x1, y0, y1, -0.056, 0.0);   // glas net vóór het kozijnvlak
    if (mull && !door) B('trim', (x0 + x1) / 2 - 0.035, (x0 + x1) / 2 + 0.035, y0, y1, -0.062, 0.0);
    if (!door) B('band', x0 - 0.08, x1 + 0.08, y0 - 0.1, y0 - 0.06, -0.08, 0.02);   // raamdorpel
  }
  // rijtjeswoning: baksteen beneden, witte band, rabat (of stucwerk) boven, zadeldak 33,5° met dakramen, witte boeiboord
  function rowHouse(x0, x1, up, zF = ROW.zF, zB = ROW.zB) {
    const e = 0.3, zc = (zF + zB) / 2, ridgeY = 5.55 + 0.66 * (zc - zF + e), w = x1 - x0;
    statics.box('brick', x0, x1, 0, 2.95, zF, zB); statics.box(up, x0, x1, 2.95, 5.55, zF, zB); statics.box('trim', x0, x1, 2.9, 3.08, zF - 0.04, zF + 0.02);
    statics.prism({ py: 'roof', ny: 'trim', def: 'roof', px: up, nx: up }, [V(x0, 5.55, zF - e), V(x1, 5.55, zF - e), V(x1, 5.55, zB + e), V(x0, 5.55, zB + e), V(x0, ridgeY, zc), V(x1, ridgeY, zc), V(x1, ridgeY, zc), V(x0, ridgeY, zc)]);
    statics.box('trim', x0, x1, 5.28, 5.56, zF - e - 0.03, zF - e + 0.03); statics.box('trim', x0, x1, 5.28, 5.56, zB + e - 0.03, zB + e + 0.03);
    win(x0 + 0.5, x0 + w * 0.5, 3.6, 5.1, zF); win(x0 + w * 0.6, x1 - 0.5, 3.6, 5.1, zF, false);                      // verdieping
    win(x0 + 0.4, x0 + w * 0.55, 0.6, 2.45, zF); win(x0 + w * 0.66, x0 + w * 0.66 + 0.95, 0, 2.3, zF, false, true);   // beneden + voordeur
    // dakramen op het voorschild, iets boven het dakvlak; nokpijp
    const slopeY = z => 5.55 + 0.66 * (z - zF + e), nrm = V(0, 1, -0.66).normalize();
    for (const xa of [x0 + w * 0.2, x0 + w * 0.62]) for (const [k, pad, lift] of [['fascia', 0.06, 0.03], ['glass', 0, 0.05]]) {
      const za = zF + 1.3, zb = za + 1.1, P = (px, pz) => V(px, slopeY(pz), pz).addScaledVector(nrm, lift);
      statics.quad(k, P(xa - pad, za - pad), P(xa + 0.8 + pad, za - pad), P(xa + 0.8 + pad, zb + pad), P(xa - pad, zb + pad), null);
    }
    statics.geo('fascia', new THREE.CylinderGeometry(0.08, 0.08, 0.7, 8), place(x1 - 0.8, ridgeY + 0.2, zc + 0.3));
  }
  for (let i = 0; i < 3; i++) rowHouse(-3.6 + i * 6.3, -3.6 + (i + 1) * 6.3, 'clad');
  rowHouse(15.5, 21.8, 'render'); addCol(-3.6, 21.8, ROW.zF, ROW.zB);
  // hoekwoning links (gele baksteen, plat dak, uitbouw aan de voorkant)
  statics.box('brickY', -11, -3.6, 0, 5.6, ROW.zF, ROW.zB); statics.box('fascia', -11.08, -3.6, 5.4, 5.75, ROW.zF - 0.08, ROW.zB + 0.08);
  statics.box('brickY', -11, -5.2, 0, 2.75, 27.9, ROW.zF); statics.box('trim', -11.08, -5.12, 2.55, 2.85, 27.82, ROW.zF);
  win(-10.2, -6.2, 0.7, 2.2, 27.9); win(-10.3, -8.6, 3.5, 5.0, ROW.zF, false); win(-7.8, -5.5, 3.5, 5.0, ROW.zF); win(-4.9, -4.0, 0.5, 2.3, ROW.zF, false); win(-4.95, -4.0, 3.5, 5.0, ROW.zF, false);
  addCol(-11, -3.6, 27.9, ROW.zB);
  // volwassen bomen in de tuinen aan de overkant en in de berm
  tree(-7.2, 29.3, { h: 4.0, r: 3.2, cy: 6.6, n: 5200, col: C.tree, size: 0.2, trunkR: 0.22, autumn: 0.3 }); addCol(-7.5, -6.9, 29.0, 29.6);
  tree(-11.5, 24.0, { h: 4.5, r: 3.4, cy: 7.3, n: 4800, col: C.tree, size: 0.21, trunkR: 0.24, autumn: 0.5, sparse: 0.5 }); addCol(-11.8, -11.2, 23.7, 24.3);
  tree(13.4, 26.6, { h: 3.0, r: 2.1, cy: 5.0, n: 2200, col: C.autumn, size: 0.14, trunkR: 0.13, sparse: 0.6, bare: 2 }); addCol(13.1, 13.7, 26.3, 26.9);
  tree(9.6, 33.5, { h: 3.5, r: 2.6, cy: 6.0, n: 3600, col: C.tree, size: 0.19, trunkR: 0.18, autumn: 0.25 });
  // lantaarnpaal op de stoep (paal, arm, armatuur)
  const LP = V(-2.4, 0, 19.1);
  statics.geo('pole', new THREE.CylinderGeometry(0.05, 0.07, 4.6, 10), place(LP.x, 2.3, LP.z)); cylBetween(statics, 'pole', V(LP.x, 4.55, LP.z), V(LP.x, 4.9, LP.z + 0.7), 0.035);
  statics.geo('pole', rbox(0.34, 0.14, 0.62, 0.04), place(LP.x, 4.9, LP.z + 0.95)); statics.geo('lamp', new THREE.BoxGeometry(0.26, 0.03, 0.5), place(LP.x, 4.82, LP.z + 0.95));
  addCol(LP.x - 0.1, LP.x + 0.1, LP.z - 0.1, LP.z + 0.1);

  /* =================================================== BUURPAND OP −X (BAG-footprint, EXTERIOR-NOTES) =================================================== */
  statics = near; zone = '';
  {
    const kb = { def: 'brick' }, RT = { py: 'roof', ny: 'trim', def: 'roof', px: 'brick', nx: 'brick' };
    statics.box(kb, -11.73, -5.19, 0, 5.5, 4.0, 12.39);
    statics.prism(RT, [V(-11.73, 5.5, 3.7), V(-5.19, 5.5, 3.7), V(-5.19, 5.5, 12.69), V(-11.73, 5.5, 12.69), V(-11.73, 8.45, 8.2), V(-5.19, 8.45, 8.2), V(-5.19, 8.45, 8.2), V(-11.73, 8.45, 8.2)]);
    statics.box(kb, -5.23, -1.94, 0, 2.8, -0.27, 9.24);
    statics.prism(RT, [V(-5.23, 2.8, -0.5), V(-1.94, 2.8, -0.5), V(-1.94, 2.8, 9.5), V(-5.23, 2.8, 9.5), V(-5.23, 6.05, 4.73), V(-1.94, 6.05, 4.73), V(-1.94, 6.05, 4.73), V(-5.23, 6.05, 4.73)]);
    win(-10.9, -8.2, 0.5, 2.3, 12.39, true, false, -1); win(-7.6, -5.9, 0.9, 2.2, 12.39, false, false, -1); win(-10.9, -8.3, 3.6, 4.95, 12.39, true, false, -1); win(-7.5, -6.0, 3.9, 4.95, 12.39, false, false, -1);
    win(-3.9, -2.7, 0, 2.2, 9.24, false, true, -1); win(-5.0, -4.1, 0.9, 2.2, 9.24, false, false, -1);
    addCol(-11.73, -5.19, 4.0, 12.39); addCol(-5.23, -1.94, -0.27, 9.24);
  }

  /* =================================================== MESHES =================================================== */
  const shadowless = new Set(['gravel', 'soil', 'clinker', 'tiles', 'band', 'mat']);
  near.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = !shadowless.has(k); m.receiveShadow = true; m.name = 'voortuin:' + k; root.add(m); meshes[k] = m; });
  far.build((k, g) => { const m = new THREE.Mesh(g, mat[k]); m.castShadow = false; m.receiveShadow = true; m.name = 'overkant:' + k; root.add(m); meshes[k + '@far'] = m; });
  // wind: hele bladkaart zwaait mee, meer naarmate hij hoger hangt; graspol buigt met uv.y²
  const wind = { uTime: { value: 0 } };
  function windy(m, key, amp, tuftLike) {
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = wind.uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <project_vertex>', `vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          vec3 wp = (modelMatrix * mvPosition).xyz; float ph = wp.x * 0.9 + wp.z * 0.7;
          float sw = (sin(uTime * 1.1 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.7)) * ${amp.toFixed(3)} * ${tuftLike ? 'uv.y * uv.y' : 'clamp(wp.y * 0.4, 0.05, 1.0)'};
          mvPosition.xz += vec2(sw, sw * 0.6);
          mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;`);
    };
    m.customProgramCacheKey = () => key; return m;
  }
  const leafMat = {}, leafGeo = new THREE.PlaneGeometry(1, 1);
  for (const key of Object.keys(leaves)) {
    const L = leaves[key], [kind, zn] = key.split('@'); if (!L.length) continue;
    const m = leafMat[kind] || (leafMat[kind] = windy(new MSM({ map: tex(texLeaf(kind), 1, 1), alphaTest: 0.5, side: THREE.DoubleSide, roughness: kind === 'oval' ? 0.55 : 0.75 }), 'voortuin-' + kind, kind === 'oval' ? 0.025 : 0.012));
    const im = new THREE.InstancedMesh(leafGeo, m, L.length), col = new THREE.Color();
    for (let i = 0; i < L.length; i++) { im.setMatrixAt(i, L[i].m); im.setColorAt(i, col.setRGB(L[i].c[0], L[i].c[1], L[i].c[2])); }
    im.castShadow = !zn; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); im.name = (zn ? 'overkant:blad-' : 'voortuin:blad-') + kind; root.add(im); meshes['leaves_' + key] = im;
  }
  {   // graspollen: 3 gekruiste kaarten, normalen omhoog
    const g = new THREE.BufferGeometry(), p = [], u = [], n = [], w = 0.5, h = 1;
    for (let k = 0; k < 3; k++) {
      const a = k * PI / 3, c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2, q = [[-c, 0, -s, 0, 0], [c, 0, s, 1, 0], [c, h, s, 1, 1], [-c, h, -s, 0, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) { p.push(q[i][0], q[i][1], q[i][2]); u.push(q[i][3], q[i][4]); n.push(0, 1, 0); }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    const m = windy(new MSM({ map: tex(texTuft(), 1, 1), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 }), 'voortuin-tuft', 0.06, true);
    const im = new THREE.InstancedMesh(g, m, tufts.length), m4 = new THREE.Matrix4(), col = new THREE.Color();
    tufts.forEach(([x, z, hh, ry, c], i) => { im.setMatrixAt(i, m4.compose(_p.set(x, -0.005, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(hh * 0.9, hh, hh * 0.9))); im.setColorAt(i, col.setRGB(c[0], c[1], c[2])); });
    im.castShadow = false; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.computeBoundingSphere(); im.name = 'voortuin:gras'; root.add(im); meshes.tufts = im;
  }

  /* =================================================== AVOND: lantaarn, prikspots, verlichte ramen =================================================== */
  const street = new THREE.PointLight('#ffd9a6', 0, 17, 1.6); street.position.set(LP.x, 4.7, LP.z + 0.95); root.add(street);
  const spots = new THREE.PointLight('#ffd2a0', 0, 5.5, 1.8); spots.position.set(5.6, 0.5, 14.1); root.add(spots);
  const lampFactor = h => (h >= 17.5 ? clamp((h - 17.5) / 1.5, 0, 1) : clamp((7.5 - h) / 1.0, 0, 1));
  let lf = -1;
  function applyEvening(h) {
    lf = lampFactor(h);
    mat.lamp.emissiveIntensity = 3.5 * lf; mat.spot.emissiveIntensity = 2.5 * lf; mat.winLit.emissiveIntensity = 1.3 * lf;
    street.intensity = coarse ? 0 : 22 * lf; spots.intensity = coarse ? 0 : 3 * lf;
  }
  let clock = 0;
  onTick(dt => {
    clock += Math.min(dt || 0.016, 0.1); wind.uTime.value = clock;
    const h = Number(H.state?.time); if (Number.isFinite(h) && lampFactor(h) !== lf) applyEvening(h);
  });
  applyEvening(Number.isFinite(Number(H.state?.time)) ? Number(H.state.time) : 13);
  if (typeof H.invalidatePicks === 'function') H.invalidatePicks();

  api.meshes = meshes;
  api.stats = () => ({ leaves: Object.keys(leaves).reduce((a, k) => a + leaves[k].length, 0), near: leaves.oval.length + leaves.lobed.length, far: leaves['oval@far'].length + leaves['lobed@far'].length, tufts: tufts.length, meshesInRoot: root.children.length, lf });
  H.frontgarden = api;
  return api;
}

/* ---- zelf opstarten (zoals garden.js) ---- */
(function boot(tries = 0) {
  const H = typeof window !== 'undefined' ? window.HOUSE : null;
  if (H && H.scene && H.camera && H.renderer) {
    if (H.frontgarden && H.frontgarden.installed) return;
    try { install(H); } catch (e) { console.error('[voortuin] installatie mislukt', e); }
    return;
  }
  if (tries < 600) setTimeout(() => boot(tries + 1), 100);
})();
