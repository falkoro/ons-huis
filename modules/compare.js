/* compare.js — "Nu ↔ Plan": foto van nu naast het plan (add-on voor de Ons Huis-walkthrough)
 *
 *  - Laadt photos/manifest.json (relatief aan de pagina). Bestaat dat niet (GitHub Pages), dan verschijnt er niets.
 *  - Knop "Nu ↔ Plan" in de gereedschapsstrip -> kiezer met de foto's van de huidige kamer (en de andere kamers).
 *  - Een foto kiezen tekent het live model (vloeren, kleuren, meubels van nu) vanuit de camerapositie van die foto,
 *    op de beeldverhouding van de foto, en toont beide schermvullend met een sleepbare scheidslijn:
 *    links "Nu" (foto), rechts "Plan" (model). Pijltjestoetsen, muis en touch; "Sluiten" of Esc.
 *  - "Kleur van de foto": witbalans van de gele nachtfoto richting neutraal (SVG-kleurenmatrix als CSS-filter).
 *  - Verandert het plan terwijl de vergelijking open staat, dan wordt het model opnieuw getekend.
 *
 * Laden (na de hoofdmodule):  <script type="module" src="./modules/compare.js"></script>
 * Geen externe imports; THREE komt uit HOUSE.THREE. Exporteert install(HOUSE) en start zelf op.
 * Camerapositie per foto (manifest.pose): { level, x, z, height (oog boven de vloer, m), yaw, pitch, roll, fov } — graden,
 * yaw als in HOUSE (0 = kijkt naar -Z / de tuin, 180 = naar +Z / de voordeur, 90 = naar -X, -90 = naar +X), fov = verticaal.
 */

const DEG = Math.PI / 180;
const MANIFEST = 'photos/manifest.json';
const LS_WB = 'onshuis.compare.wb';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = p => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  split: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 2v20"/><path d="m8 10-2 2 2 2M16 10l2 2-2 2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  redo: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  photos: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>'),
  wb: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
};

const CSS = `
.cmp-pick{position:absolute;right:16px;top:var(--cmp-top,calc(16px + env(safe-area-inset-top,0px)));bottom:calc(16px + env(safe-area-inset-bottom,0px));width:min(360px,calc(100vw - 32px));z-index:7;
  display:flex;flex-direction:column;box-sizing:border-box;background:var(--surface,#f7f8f5);color:var(--ink,#1b231f);border:1px solid var(--line,#d0d7cf);border-radius:16px;
  box-shadow:var(--shadow,0 12px 32px rgba(0,0,0,.18));overflow:hidden;font:14px/1.4 var(--font-body,system-ui)}
.cmp-pick *{box-sizing:border-box}
.cmp-pick .hd{display:flex;align-items:flex-start;gap:10px;padding:14px 14px 10px 18px;border-bottom:1px solid var(--line,#d0d7cf)}
.cmp-pick .hd .t{flex:1;min-width:0}
.cmp-pick .ey{font:500 11px/1 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2,#56625b)}
.cmp-pick h2{font:700 22px/1.1 var(--font-display,system-ui);margin:4px 0 0;letter-spacing:-.015em}
.cmp-pick .x{border:1px solid var(--line,#d0d7cf);background:var(--surface-2,#edf0eb);color:var(--ink,#111);border-radius:999px;width:34px;height:34px;display:grid;place-items:center;flex:none;padding:0;cursor:pointer}
.cmp-pick .bd{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px 18px 14px;flex:1;min-height:0}
.cmp-pick section{padding:12px 0 6px;border-bottom:1px solid var(--line,#d0d7cf)}
.cmp-pick section:last-child{border-bottom:0}
.cmp-pick h3{font:500 11px/1.2 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2,#56625b);margin:0 0 8px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.cmp-pick h3 small{font:400 12px/1.2 var(--font-body,system-ui);letter-spacing:0;text-transform:none}
.cmp-pick .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.cmp-pick .ph{border:1px solid var(--line,#d0d7cf);background:var(--surface-2,#edf0eb);color:var(--ink,#111);border-radius:var(--r-sm,8px);padding:0;overflow:hidden;cursor:pointer;text-align:left;display:grid;font:inherit}
.cmp-pick .ph:hover,.cmp-pick .ph:focus-visible{border-color:var(--accent,#2d5a4c);outline:none}
.cmp-pick .ph img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:#222}
.cmp-pick .ph span{display:block;padding:6px 8px;font-size:12.5px;line-height:1.3;overflow-wrap:anywhere}
.cmp-pick .note{font-size:12.5px;color:var(--ink-2,#56625b);margin:8px 0 0}
.cmp-pick .empty{font-size:13px;color:var(--ink-2,#56625b);margin:0 0 8px}
.cmp-view{position:fixed;inset:0;z-index:40;background:#0d0f0e;color:#f3f4f1;display:flex;flex-direction:column;font:14px/1.4 var(--font-body,system-ui);touch-action:none;outline:none}
.cmp-view *{box-sizing:border-box}
.cmp-view .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;background:rgba(13,15,14,.92);border-bottom:1px solid rgba(255,255,255,.08)}
.cmp-view .bar .t{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cmp-view .bar .ey{font:500 11px/1 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.1em;opacity:.7}
.cmp-view .bar b{font:600 15px/1.2 var(--font-body,system-ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmp-view .btn{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#f3f4f1;border-radius:999px;padding:7px 12px;font:500 13px/1.2 var(--font-body,system-ui);display:inline-flex;gap:6px;align-items:center;cursor:pointer;white-space:nowrap}
.cmp-view .btn:hover{background:rgba(255,255,255,.14)}
.cmp-view .btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
.cmp-view .btn[aria-pressed="true"]{background:#f3f4f1;color:#0d0f0e;border-color:#f3f4f1}
.cmp-view .btn.primary{background:var(--accent,#2d5a4c);border-color:var(--accent,#2d5a4c);color:var(--accent-ink,#fff)}
.cmp-view .btn svg{width:16px;height:16px}
.cmp-view .box{flex:1;min-height:0;position:relative;display:grid;place-items:center;overflow:hidden}
.cmp-stage{position:relative;overflow:hidden;background:#000;user-select:none;-webkit-user-select:none;touch-action:none;cursor:ew-resize}
.cmp-stage>img,.cmp-stage>canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.cmp-stage>img.wb{filter:url(#cmp-wb) saturate(.92)}
.cmp-stage>canvas{clip-path:inset(0 0 0 var(--cmp-p,50%))}
.cmp-stage .lab{position:absolute;top:10px;padding:4px 10px;border-radius:999px;font:600 12px/1.2 var(--font-body,system-ui);letter-spacing:.04em;text-transform:uppercase;background:rgba(0,0,0,.55);color:#fff;pointer-events:none;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.cmp-stage .lab.nu{left:10px}
.cmp-stage .lab.plan{right:10px;background:rgba(45,90,76,.85)}
.cmp-stage .div{position:absolute;top:0;bottom:0;left:var(--cmp-p,50%);width:0;pointer-events:none}
.cmp-stage .div::before{content:"";position:absolute;top:0;bottom:0;left:-1px;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.cmp-stage .knob{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:#fff;color:#0d0f0e;display:grid;place-items:center;
  box-shadow:0 4px 14px rgba(0,0,0,.45);pointer-events:auto;cursor:ew-resize;border:0;padding:0;touch-action:none}
.cmp-stage .knob:focus-visible{outline:3px solid var(--accent,#2d5a4c);outline-offset:2px}
.cmp-stage .wait{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);font:500 13px var(--font-mono,monospace);letter-spacing:.06em;color:#fff;pointer-events:none}
.cmp-view .ft{padding:8px 14px calc(10px + env(safe-area-inset-bottom,0px));font-size:12.5px;opacity:.75;text-align:center;background:rgba(13,15,14,.92)}
@media (max-width:760px){
  .cmp-pick{left:0;right:0;top:auto;bottom:0;width:auto;max-height:72vh;max-height:72dvh;border-radius:18px 18px 0 0;border-bottom:0;border-left:0;border-right:0}
  .cmp-pick .hd{padding:8px 12px 8px 16px;position:relative}
  .cmp-pick .hd::before{content:"";position:absolute;left:50%;top:6px;width:40px;height:4px;margin-left:-20px;border-radius:2px;background:var(--line,#ccc)}
  .cmp-pick .hd .t{padding-top:8px}
  .cmp-pick h2{font-size:19px}
  .cmp-pick .bd{padding:2px 14px 12px}
  .cmp-pick .grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .cmp-view .bar{padding-left:10px;padding-right:10px;gap:6px}
  .cmp-view .btn{padding:6px 10px;font-size:12.5px}
  .cmp-view .btn .tx{display:none}
  .cmp-view .btn.primary .tx{display:inline}
  .cmp-view .ft{display:none}
}
@media (prefers-reduced-motion: no-preference){ .cmp-stage>canvas{transition:clip-path .04s linear} }
`;

function injectCSS(id, css) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.append(s);
}
// SVG colour matrix: tungsten night photo -> neutral (less red, a touch less green, more blue)
function injectWB() {
  if (document.getElementById('cmp-wb-svg')) return;
  const w = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  w.id = 'cmp-wb-svg'; w.setAttribute('width', '0'); w.setAttribute('height', '0'); w.setAttribute('aria-hidden', 'true');
  w.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  w.innerHTML = '<filter id="cmp-wb" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.86 0 0 0 0.01  0 0.95 0 0 0.01  0 0 1.28 0 0.02  0 0 0 1 0"/></filter>';
  document.body.append(w);
}

/* ---------------- model capture ---------------- */
// Level groups of the host: G[l].main is named 'L'+l; its ceiling group is the next (unnamed) scene child.
function levelGroups(H) {
  const out = [];
  for (let l = 0; l < 3; l++) {
    const main = H.scene.getObjectByName('L' + l); if (!main || main.parent !== H.scene) break;
    const i = H.scene.children.indexOf(main), next = H.scene.children[i + 1];
    out.push({ main, ceil: next && next.isGroup && !next.name ? next : null });
  }
  return out;
}
const floorY = (H, l) => H.floors?.[l]?.y ?? H.data?.LV?.[l]?.floor ?? [0, 2.76, 5.39][l] ?? 0;

/** Renders the live model from `pose` into a fresh canvas of W x H px and restores camera, walker, visibility and size. */
export function capture(H, pose, W, H_) {
  const T = H.THREE, r = H.renderer, cam = H.camera;
  if (r.xr && r.xr.isPresenting) throw new Error('XR actief');
  W = Math.max(8, Math.round(W)); H_ = Math.max(8, Math.round(H_));
  const level = clamp(pose.level | 0, 0, 2);
  const size = r.getSize(new T.Vector2()), pr = r.getPixelRatio();
  const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, aspect: cam.aspect, zoom: cam.zoom, near: cam.near };
  const walk = H.mode === 'walk' && H.walker && typeof H.setWalker === 'function';
  const w0 = walk ? { l: H.walker.l, x: H.walker.x, z: H.walker.z, yaw: H.walker.yaw, pitch: H.walker.pitch } : null;
  const groups = levelGroups(H), vis = groups.map(g => [g.main.visible, g.ceil ? g.ceil.visible : null]);
  const paused = typeof H.pauseRender === 'function';
  if (paused) H.pauseRender(true);
  try {
    if (walk) H.setWalker({ l: level, x: pose.x, z: pose.z, yaw: (pose.yaw || 0) * DEG, pitch: 0 }); // lamps + level visibility follow the walker
    groups.forEach((g, l) => { g.main.visible = l <= level + 1; if (g.ceil) g.ceil.visible = true; });
    cam.position.set(pose.x, floorY(H, level) + (pose.height ?? 1.55), pose.z);
    cam.quaternion.setFromEuler(new T.Euler((pose.pitch || 0) * DEG, (pose.yaw || 0) * DEG, (pose.roll || 0) * DEG, 'YXZ'));
    cam.fov = pose.fov || 68; cam.aspect = W / H_; cam.zoom = 1; cam.near = 0.05; cam.updateProjectionMatrix();
    r.setPixelRatio(1); r.setSize(W, H_, false);
    r.render(H.scene, cam);
    const out = document.createElement('canvas'); out.width = W; out.height = H_;
    out.getContext('2d').drawImage(r.domElement, 0, 0, W, H_);
    return out;
  } finally {
    r.setPixelRatio(pr); r.setSize(size.x, size.y, false);
    groups.forEach((g, i) => { g.main.visible = vis[i][0]; if (g.ceil) g.ceil.visible = vis[i][1]; });
    cam.fov = saved.fov; cam.aspect = saved.aspect; cam.zoom = saved.zoom; cam.near = saved.near; cam.updateProjectionMatrix();
    cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat);
    if (walk) { H.setWalker(w0); cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat); }
    if (paused) H.pauseRender(false);
  }
}

/* ---------------- install ---------------- */
export function install(H, photos, base) {
  if (!H || H.__compare) return H && H.__compare;
  injectCSS('cmp-style', CSS); injectWB();
  const rooms = Object.fromEntries((H.rooms || []).map(r => [r.id, r]));
  const roomName = id => rooms[id]?.name || id;
  const list = photos.map((p, i) => ({ ...p, i, src: new URL(p.file, base).href }));
  const root = document.getElementById('app') || document.body;
  const api = { photos: list, capture: (pose, w, h) => capture(H, pose, w, h), open: null, close: null, pick: null };
  H.__compare = api; H.compare = api;

  /* ---- current room ---- */
  function currentRoom() {
    if (H.mode === 'walk' && H.walker && typeof H.roomAt === 'function') return H.roomAt(H.walker.l, H.walker.x, H.walker.z) || null;
    return H.state?.sel || null;
  }

  /* ---- picker ---- */
  const pick = document.createElement('aside'); pick.className = 'cmp-pick'; pick.hidden = true;
  pick.setAttribute('role', 'dialog'); pick.setAttribute('aria-labelledby', 'cmp-pick-title');
  pick.innerHTML = `<div class="hd"><div class="t"><div class="ey">Foto van nu naast het plan</div><h2 id="cmp-pick-title">Nu ↔ Plan</h2></div>
    <button type="button" class="x" data-a="close" aria-label="Kiezer sluiten">${ICON.close}</button></div><div class="bd"></div>`;
  root.append(pick);
  const pbd = pick.querySelector('.bd');
  const card = p => `<button type="button" class="ph" data-i="${p.i}" title="${esc(roomName(p.room))} · ${esc(p.label)}"><img src="${esc(p.src)}" alt="" loading="lazy" decoding="async"><span>${esc(p.label)}</span></button>`;
  function renderPicker() {
    const cur = currentRoom(), here = list.filter(p => p.room === cur);
    const byRoom = new Map(); for (const p of list) if (p.room !== cur) { if (!byRoom.has(p.room)) byRoom.set(p.room, []); byRoom.get(p.room).push(p); }
    let h = '';
    if (cur) h += `<section><h3>Hier <small>${esc(roomName(cur))}</small></h3>${here.length ? `<div class="grid">${here.map(card).join('')}</div>` : `<p class="empty">Geen foto van deze kamer.</p>`}</section>`;
    for (const [rid, ps] of byRoom) h += `<section><h3>${esc(roomName(rid))}</h3><div class="grid">${ps.map(card).join('')}</div></section>`;
    h += `<p class="note">Kies een foto: het plan wordt vanuit hetzelfde standpunt getekend, met de vloeren, kleuren en meubels van nu.</p>`;
    pbd.innerHTML = h;
  }
  let btn = null, pickOpen = false;
  function setPicker(on) {
    pickOpen = !!on; pick.hidden = !pickOpen; btn?.setAttribute('aria-pressed', String(pickOpen));
    if (pickOpen) { renderPicker(); pick.querySelector('.ph')?.focus({ preventScroll: true }); }
  }
  pick.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (a?.dataset.a === 'close') return setPicker(false);
    const b = e.target.closest('.ph'); if (b) { setPicker(false); openViewer(list[+b.dataset.i]); }
  });
  pick.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); setPicker(false); btn?.focus(); } });
  if (typeof H.on === 'function') H.on('room', () => { if (pickOpen) renderPicker(); });

  /* ---- viewer ---- */
  const view = document.createElement('div'); view.className = 'cmp-view'; view.hidden = true; view.tabIndex = -1;
  view.setAttribute('role', 'dialog'); view.setAttribute('aria-modal', 'true'); view.setAttribute('aria-label', 'Nu en plan vergelijken');
  view.innerHTML = `<div class="bar"><div class="t"><span class="ey" data-o="room"></span><b data-o="label"></b></div>
      <button type="button" class="btn" data-a="wb" aria-pressed="false" title="Witbalans van de nachtfoto richting neutraal">${ICON.wb}<span class="tx">Kleur van de foto: <span data-o="wb">origineel</span></span></button>
      <button type="button" class="btn" data-a="redo" title="Plan opnieuw tekenen">${ICON.redo}<span class="tx">Opnieuw</span></button>
      <button type="button" class="btn" data-a="other" title="Een andere foto kiezen">${ICON.photos}<span class="tx">Andere foto</span></button>
      <button type="button" class="btn primary" data-a="close">${ICON.close}<span class="tx">Sluiten</span></button></div>
    <div class="box"><div class="cmp-stage"><img alt="Foto van de kamer zoals die nu is"><span class="lab nu">Nu</span><span class="lab plan">Plan</span>
      <div class="div"><button type="button" class="knob" role="slider" aria-label="Scheidslijn tussen nu en plan" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50% foto">${ICON.split}</button></div>
      <div class="wait" hidden>PLAN WORDT GETEKEND…</div></div></div>
    <div class="ft">Sleep de scheidslijn (of gebruik ← →) · Esc sluit</div>`;
  document.body.append(view);
  const stage = view.querySelector('.cmp-stage'), img = stage.querySelector('img'), knob = stage.querySelector('.knob'), wait = stage.querySelector('.wait'), box = view.querySelector('.box');
  const q = s => view.querySelector(s);
  let cur = null, canvas = null, p = 50, unsub = null, redoT = 0, lastFocus = null, wasInteractive = true;
  let wb = false; try { wb = localStorage.getItem(LS_WB) === '1'; } catch (e) { }

  function setP(v, announce = true) {
    p = clamp(v, 0, 100); stage.style.setProperty('--cmp-p', p + '%');
    knob.setAttribute('aria-valuenow', String(Math.round(p))); knob.setAttribute('aria-valuetext', `${Math.round(p)}% foto`);
  }
  function setWB(on) {
    wb = !!on; img.classList.toggle('wb', wb); q('[data-a="wb"]').setAttribute('aria-pressed', String(wb)); q('[data-o="wb"]').textContent = wb ? 'neutraal' : 'origineel';
    try { localStorage.setItem(LS_WB, wb ? '1' : '0'); } catch (e) { }
  }
  function layout() {
    if (!cur) return;
    const ar = (cur.w && cur.h) ? cur.w / cur.h : (img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 9 / 16);
    const W = box.clientWidth, Hh = box.clientHeight; if (!W || !Hh) return;
    let w = Math.min(W, Hh * ar), h = w / ar; if (h > Hh) { h = Hh; w = h * ar; }
    stage.style.width = Math.floor(w) + 'px'; stage.style.height = Math.floor(h) + 'px';
  }
  function draw() {
    if (!cur) return;
    const ar = (cur.w && cur.h) ? cur.w / cur.h : 9 / 16;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    let h = Math.round((stage.clientHeight || 640) * dpr); h = clamp(h, 480, 1440); const w = Math.round(h * ar);
    wait.hidden = false;
    let c = null;
    try { c = api.capture(cur.pose, w, h); } catch (e) { console.warn('[compare] tekenen mislukt', e); H.ui?.toast?.('Het plan kon niet getekend worden.'); }
    wait.hidden = true;
    if (!c) return;
    if (canvas) canvas.remove();
    canvas = c; canvas.setAttribute('aria-hidden', 'true'); stage.insertBefore(canvas, stage.querySelector('.lab'));
  }
  function scheduleRedraw() { clearTimeout(redoT); redoT = setTimeout(() => { if (!view.hidden) draw(); }, 250); }

  function openViewer(photo) {
    if (!photo) return;
    if (H.renderer?.xr?.isPresenting) { H.ui?.toast?.('Niet beschikbaar in VR.'); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    cur = photo; lastFocus = document.activeElement;
    q('[data-o="room"]').textContent = roomName(photo.room); q('[data-o="label"]').textContent = photo.label;
    img.src = photo.src; setWB(wb); setP(50);
    if (canvas) { canvas.remove(); canvas = null; }
    view.hidden = false; document.documentElement.classList.add('cmp-open');
    wasInteractive = true; H.setInteractive?.(false);
    layout();
    knob.focus({ preventScroll: true });
    requestAnimationFrame(() => { layout(); draw(); });
    if (!unsub && typeof H.on === 'function') unsub = H.on('change', scheduleRedraw);
  }
  function closeViewer() {
    if (view.hidden) return;
    view.hidden = true; document.documentElement.classList.remove('cmp-open'); cur = null; clearTimeout(redoT);
    if (unsub) { unsub(); unsub = null; }
    if (canvas) { canvas.remove(); canvas = null; }
    H.setInteractive?.(wasInteractive);
    (lastFocus && lastFocus.isConnected ? lastFocus : btn)?.focus?.({ preventScroll: true });
  }
  view.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'close') closeViewer();
    else if (a.dataset.a === 'redo') draw();
    else if (a.dataset.a === 'wb') setWB(!wb);
    else if (a.dataset.a === 'other') { closeViewer(); setPicker(true); }
  });
  // drag: anywhere on the stage, mouse / pen / touch
  let drag = false;
  const posFrom = e => { const r = stage.getBoundingClientRect(); return r.width ? ((e.clientX - r.left) / r.width) * 100 : p; };
  stage.addEventListener('pointerdown', e => { if (e.button !== 0 && e.pointerType === 'mouse') return; drag = true; stage.setPointerCapture(e.pointerId); setP(posFrom(e)); knob.focus({ preventScroll: true }); e.preventDefault(); });
  stage.addEventListener('pointermove', e => { if (drag) setP(posFrom(e)); });
  const end = e => { if (drag) { drag = false; try { stage.releasePointerCapture(e.pointerId); } catch (x) { } } };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  // keyboard: arrows move the divider; the walkthrough must not receive them while the viewer is open
  const KEYS = /^(Arrow(Left|Right|Up|Down)|Home|End|Escape|Key[WASDE]|Space|Shift(Left|Right))$/;
  function onKey(e) {
    if (view.hidden) return;
    if (e.type === 'keydown') {
      const step = e.shiftKey ? 10 : 2;
      if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') { setP(p - step); e.preventDefault(); }
      else if (e.code === 'ArrowRight' || e.code === 'ArrowUp') { setP(p + step); e.preventDefault(); }
      else if (e.code === 'Home') { setP(0); e.preventDefault(); }
      else if (e.code === 'End') { setP(100); e.preventDefault(); }
      else if (e.key === 'Escape') { closeViewer(); e.preventDefault(); }
      else if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...view.querySelectorAll('button:not([hidden])')].filter(b => b.offsetParent !== null); if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { f[f.length - 1].focus(); e.preventDefault(); } else if (!e.shiftKey && i === f.length - 1) { f[0].focus(); e.preventDefault(); }
      }
    }
    if (KEYS.test(e.code) || e.key === 'Escape') e.stopImmediatePropagation();
  }
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);
  addEventListener('resize', () => { if (!view.hidden) layout(); });
  img.addEventListener('load', () => { if (!view.hidden) layout(); });

  /* ---- tool button ---- */
  btn = H.ui?.addTool?.({ id: 'compare', label: 'Nu ↔ Plan', icon: ICON.split, title: 'Foto van nu naast het plan', onClick: () => setPicker(!pickOpen) }) || null;
  if (btn) btn.setAttribute('aria-pressed', 'false');

  api.open = f => openViewer(typeof f === 'string' ? list.find(p => p.file === f) : f);
  api.close = closeViewer; api.pick = setPicker; api.setP = setP; api.getP = () => p; api.setWB = setWB; api.button = btn; api.currentRoom = currentRoom;
  return api;
}

/* ---------------- boot ---------------- */
const ready = h => !!(h && h.THREE && h.scene && h.camera && h.renderer);
function whenHouse(fn, timeoutMs = 60000) {
  const t0 = performance.now();
  const go = () => { const H = window.HOUSE; if (ready(H)) { try { fn(H); } catch (e) { console.error('[compare] install failed', e); } return; } if (performance.now() - t0 < timeoutMs) setTimeout(go, 120); };
  go();
}
async function loadManifest() {
  const url = new URL(MANIFEST, document.baseURI);
  try {
    const res = await fetch(url, { cache: 'no-cache' }); if (!res.ok) return null;
    const ct = res.headers.get('content-type') || ''; const txt = await res.text();
    if (/text\/html/i.test(ct) && !/^\s*[\[{]/.test(txt)) return null; // SPA fallbacks serve index.html for missing files
    const data = JSON.parse(txt); return Array.isArray(data) && data.length ? { data, base: url } : null;
  } catch (e) { return null; }
}
(async () => {
  if (typeof document === 'undefined') return;
  const m = await loadManifest();
  if (!m) return; // no photos here (public site): no button
  whenHouse(H => install(H, m.data, m.base));
})();
