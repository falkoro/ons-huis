/* Ons Huis: "Foto" and "360°" add-on.
 * Photo-realistic stills and equirectangular panoramas of the current view, path traced progressively in the browser
 * with three-gpu-pathtracer (Garrett Johnson, MIT) on top of three-mesh-bvh (MIT). No Blender, no server.
 * On top of the library: Sobol sampling (its default stratified sampler leaves a fixed per-pixel pattern that never
 * converges), window portals for the sky light, and an edge-avoiding a-trous denoiser (SVGF spatial filter) guided by
 * albedo / normal / distance buffers rasterized from the same camera.
 *
 * Usage: <script type="module" src="modules/photo.js"></script>. The module self-boots once window.HOUSE exists,
 * or call install(HOUSE) yourself. The host import map needs the three entries in IMPORT_MAP below (the path tracer
 * uses bare imports 'three', 'three-mesh-bvh' and 'three/examples/jsm/...'). If they are missing, the module tries to
 * add them at runtime; that only works in browsers that merge late import maps (Chrome/Edge 133+).
 */

export const VERSIONS = { pathtracer: '0.0.23', bvh: '0.7.8', three: '0.170.0' };
export const IMPORT_MAP = {
  'three-gpu-pathtracer': `https://cdn.jsdelivr.net/npm/three-gpu-pathtracer@${VERSIONS.pathtracer}/build/index.module.js`,
  'three-mesh-bvh': `https://cdn.jsdelivr.net/npm/three-mesh-bvh@${VERSIONS.bvh}/build/index.module.js`,
  'three/examples/jsm/': `https://cdn.jsdelivr.net/npm/three@${VERSIONS.three}/examples/jsm/`,
};

const PHONE = (() => { try { return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820; } catch (e) { return false; } })();
const REDUCED = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();

// Desktop numbers are tuned on an RTX 4090 for ~20-40 s per still (capS/capP: render time caps in seconds for
// stills/360, after the one-off shader compile); the sample targets are only reached on fast GPUs.
// gss: guide buffer supersampling, gMax: guide buffer pixel cap, cube: guide cube face size (360), filterMs: denoise preview interval
const Q = PHONE
  ? { bounces: 3, transmissive: 3, tiles: 3, texSize: 512, still: 160, pano: 96, capS: 150, capP: 150, budget: 0.45e6, panoW: [1024, 2048], panoDef: 1024, gss: 1, gMax: 1.2e6, cube: 512, filterMs: 700 }
  : { bounces: 6, transmissive: 4, tiles: 2, texSize: 1024, still: 1000, pano: 600, capS: 24, capP: 30, budget: 2.2e6, panoW: [1024, 2048, 4096], panoDef: 2048, gss: 2, gMax: 9e6, cube: 1024, filterMs: 250 };
const LAMP_RANGE = 14;         // point/spot lights further than this from the camera are left out (they only add noise)
const SMALL_EMITTER = 0.6;     // emissive meshes smaller than this radius (bulbs, shades) do not block light; their point light carries the light
const INSTANCE_VERTS = 500000; // instanced meshes (grass, leaves) are baked out for the path tracer up to this many vertices, thinned beyond it
// vertex attributes the path tracer merges into one geometry: they must be plain float arrays, and colour must be rgba
const PT_ATTRS = ['position', 'normal', 'color', 'tangent', 'uv', 'uv2'];
const AUTO_KEY = 0.2, AUTO_EV_MAX = 2.5;   // auto exposure without the app's frame as reference: target log-average luminance, max brightening
const AUTO_EV_APP = 5;         // auto exposure matched to the app's frame: max brightening
const COMPILE_LIMIT_MS = 120000;
const RANDOM_SOBOL = 1;        // three-gpu-pathtracer RANDOM_TYPE: 0 PCG, 1 Sobol, 2 stratified (library default, biased here)
const PORTAL_MAX = 32;         // window portals the shader loops over
const ATROUS_ITER = 5;
// strength of the luminance edge stop per pass: the first, 1-pixel pass smooths on geometry alone, so the later passes compare
// values that are no longer dominated by noise (a soft gradient such as the shade in a ceiling corner then stays smooth)
let LUM_RAMP = [0, 0.5, 1, 1, 1];

const CSS = `
.phx{position:fixed;inset:0;z-index:60;font:15px/1.4 var(--font-body,'Segoe UI',system-ui,sans-serif);color:var(--ink,#1b231f);
  -webkit-user-select:none;user-select:none;touch-action:none}
.phx.view{cursor:grab}.phx.view.drag{cursor:grabbing}
.phx-card{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
  width:min(560px,calc(100vw - 32px));box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 16px;cursor:default;
  background:var(--glass,rgba(247,248,245,.9));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border:1px solid var(--line,#d0d7cf);border-radius:16px;box-shadow:var(--shadow,0 12px 32px rgba(27,35,31,.16))}
.phx-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.phx-title{font:700 18px/1.1 var(--font-display,var(--font-body,system-ui));margin:0;letter-spacing:-.01em}
.phx-meta{font:500 12px/1.2 var(--font-mono,ui-monospace,Consolas,monospace);color:var(--ink-2,#56625b);font-variant-numeric:tabular-nums}
.phx-bar{height:4px;border-radius:999px;background:var(--surface-2,#edf0eb);overflow:hidden}
.phx-bar i{display:block;height:100%;width:0;background:var(--accent,#2d5a4c);border-radius:inherit;transition:width .25s linear}
.phx-status{font-size:13px;color:var(--ink-2,#56625b);margin:0;min-height:1.4em}
.phx-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center}
.phx-grow{flex:1 1 auto}
.phx-field{display:flex;align-items:center;gap:8px;font:500 11px/1 var(--font-mono,ui-monospace,monospace);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2,#56625b)}
.phx-seg{display:inline-flex;gap:2px;background:var(--surface-2,#edf0eb);border-radius:999px;padding:3px}
.phx-seg button{border:0;background:transparent;border-radius:999px;padding:5px 10px;font:500 13px/1 var(--font-body,system-ui);color:var(--ink-2,#56625b);cursor:pointer}
.phx-seg button[aria-pressed="true"]{background:var(--accent,#2d5a4c);color:var(--accent-ink,#f3f7f4)}
.phx-field input[type=range]{width:110px;accent-color:var(--accent,#2d5a4c)}
.phx-field output{font:500 12px/1 var(--font-mono,ui-monospace,monospace);text-transform:none;letter-spacing:0;color:var(--ink,#1b231f);min-width:56px}
.phx-btns{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.phx-btn{border:1px solid var(--line,#d0d7cf);background:var(--surface,#f7f8f5);color:var(--ink,#1b231f);border-radius:var(--r-sm,8px);
  padding:8px 13px;font:500 13px/1 var(--font-body,system-ui);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.phx-btn.primary{background:var(--accent,#2d5a4c);color:var(--accent-ink,#f3f7f4);border-color:var(--accent,#2d5a4c)}
.phx-btn[disabled]{opacity:.45;cursor:default}
.phx-note{font-size:12px;color:var(--ink-2,#56625b);margin:0}
.phx-hint{position:absolute;left:50%;top:calc(16px + env(safe-area-inset-top,0px));transform:translateX(-50%);pointer-events:none;white-space:nowrap;
  background:var(--glass,rgba(247,248,245,.9));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line,#d0d7cf);
  border-radius:999px;padding:7px 14px;font:600 13px/1 var(--font-body,system-ui);box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.15));max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis}
.phx :focus-visible{outline:2px solid var(--focus,#2d5a4c);outline-offset:2px}
.phx-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.phx-tools button{display:inline-flex;align-items:center;gap:6px}
.phx-tools button svg{flex:none}
.phx-tools.float{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:7}
.phx-toast{position:fixed;left:50%;top:calc(16px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:70;max-width:calc(100vw - 32px);
  background:var(--ink,#1b231f);color:var(--bg,#e7ebe6);border-radius:999px;padding:8px 16px;font:500 13px/1.3 var(--font-body,system-ui);
  box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.2));pointer-events:none;text-align:center}
html.phx-on #topbar,html.phx-on #panel,html.phx-on #hint,html.phx-on #cross,html.phx-on #tag,html.phx-on #roomTag,
html.phx-on #joy,html.phx-on #walkStart,html.phx-on .phx-tools{visibility:hidden!important}
@media (max-width:520px){.phx-card{padding:12px}.phx-btns{margin-left:0;width:100%}.phx-btns .phx-btn{flex:1;justify-content:center}}
@media (prefers-reduced-motion:reduce){.phx-bar i{transition:none}}
`;

const ICON = {
  foto: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5h3.2L8.4 6h7.2l1.7 2.5h3.2V19h-17z"/><circle cx="12" cy="13.3" r="3.6"/></svg>',
  pano: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5"/><path d="M3.5 12h17"/></svg>',
  save: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
};

/* ---------------- small helpers ---------------- */
const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
const raf = () => new Promise(r => requestAnimationFrame(() => r()));
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
function canDownload() {
  const host = location.hostname;
  if (/(^|\.)github\.io$/i.test(host) || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || location.protocol === 'file:') return true;
  let framed = true; try { framed = window.top !== window.self; } catch (e) { /* cross-origin parent: framed */ }
  return !framed && !/claude|anthropic/i.test(host); // claude.ai artifacts run in a sandboxed frame where downloads are blocked
}
function shownInTree(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

/* ---------------- library loading ---------------- */
let libsPromise = null;
function ensureImportMap(T) {
  const want = { ...IMPORT_MAP };
  if (T?.REVISION) want['three/examples/jsm/'] = `https://cdn.jsdelivr.net/npm/three@0.${parseInt(T.REVISION, 10)}.0/examples/jsm/`;
  if (typeof import.meta.resolve !== 'function') return;
  const missing = {};
  for (const [k, v] of Object.entries(want)) {
    try { import.meta.resolve(k.endsWith('/') ? k + 'postprocessing/Pass.js' : k); } catch (e) { missing[k] = v; }
  }
  if (!Object.keys(missing).length) return;
  console.warn('[foto] import map mist', Object.keys(missing).join(', '), '- wordt runtime toegevoegd (werkt alleen in Chrome/Edge 133+)');
  const s = document.createElement('script'); s.type = 'importmap'; s.textContent = JSON.stringify({ imports: missing });
  document.head.append(s);
}
function loadLibs(T) {
  if (!libsPromise) {
    ensureImportMap(T);
    libsPromise = Promise.all([import('three-gpu-pathtracer'), import('three/addons/loaders/RGBELoader.js')])
      .then(([pt, rgbe]) => ({ ...pt, RGBELoader: rgbe.RGBELoader }))
      .catch(e => { libsPromise = null; throw e; });
  }
  return libsPromise;
}

/* ---------------- install ---------------- */
let installed = null;

export function install(H, THREE = H && H.THREE) {
  if (installed) return installed;
  if (!H || !H.scene || !H.renderer || !H.camera || !THREE) throw new Error('photo.js: window.HOUSE (scene, renderer, camera, THREE) ontbreekt');
  const T = THREE, R = H.renderer, scene = H.scene;
  const allowSave = canDownload();

  document.head.append(h('style', { id: 'phx-css' }, CSS));

  /* ---- host API with shims ---- */
  let renderPatch = null;
  let postOff = false;
  function pauseHost(on) {
    // post.js (real-time look: window RectAreaLights, indoor light share, its own exposure) is switched off while we own the
    // frame, so neither the path tracer nor the app metering sees its lights or lighting patch; switched back on at close
    const post = H.post;
    if (on && !postOff && post && post.ready !== false && typeof post.setEnabled === 'function') {
      try { post.setEnabled(false); postOff = true; } catch (e) { console.warn('[foto] post.js uit', e); }
    }
    if (!on && postOff) { postOff = false; try { H.post?.setEnabled?.(true); } catch (e) { console.warn('[foto] post.js aan', e); } }
    if (typeof H.pauseRender === 'function') { H.pauseRender(on); return; }
    // shim: swallow only the main scene render, so our own quads and the path tracer still draw
    if (on && !renderPatch) {
      const orig = R.render;
      renderPatch = orig;
      R.render = function (s, c) { if (s === scene) return; return orig.call(this, s, c); };
    } else if (!on && renderPatch) { R.render = renderPatch; renderPatch = null; }
  }
  let toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (H.ui && typeof H.ui.toast === 'function') { try { H.ui.toast(msg); return; } catch (e) { /* fall through */ } }
    if (!toastEl) { toastEl = h('div', { class: 'phx-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(toastEl); }
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4200);
  }
  let toolBox = null;
  const toolEls = {};
  function addTool(def) {
    if (H.ui && typeof H.ui.addTool === 'function') { const r = H.ui.addTool(def); if (r instanceof Element) toolEls[def.id] = r; return; }
    if (!toolBox) {
      toolBox = h('div', { class: 'seg phx-tools', role: 'group', 'aria-label': "Foto's" });
      const rail = document.querySelector('#topbar .rail-row') || document.querySelector('#topbar');
      if (rail) rail.append(toolBox); else { toolBox.classList.add('float'); document.body.append(toolBox); }
    }
    const b = h('button', { type: 'button', 'data-tool': def.id, title: def.title || def.label, html: (def.icon || '') + `<span>${def.label}</span>`, onclick: def.onClick });
    toolBox.append(b); toolEls[def.id] = b;
  }
  const setToolsBusy = busy => { for (const b of Object.values(toolEls)) { if ('disabled' in b) b.disabled = busy; } };

  /* ---- display / export shader: identical tone mapping to the app (operator + exposure) ---- */
  const TM_NAME = { [T.LinearToneMapping]: 'LinearToneMapping', [T.ReinhardToneMapping]: 'ReinhardToneMapping', [T.CineonToneMapping]: 'CineonToneMapping',
    [T.ACESFilmicToneMapping]: 'ACESFilmicToneMapping', [T.AgXToneMapping]: 'AgXToneMapping', [T.NeutralToneMapping]: 'NeutralToneMapping' };
  function makeToneMaterial() {
    const fn = TM_NAME[R.toneMapping];
    return new T.ShaderMaterial({
      name: 'phx-tonemap',
      defines: Object.assign({}, fn ? { TM_FN: fn } : {}, R.outputColorSpace === T.SRGBColorSpace ? { SRGB_OUT: 1 } : {}),
      uniforms: { map: { value: null }, uExposure: { value: 1 }, uWB: { value: new T.Vector3(1, 1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform vec3 uWB; varying vec2 vUv;
        ${T.ShaderChunk.tonemapping_pars_fragment.replace(/toneMappingExposure/g, 'uExposure')}
        vec3 tm(vec3 c){
          #ifdef TM_FN
            return TM_FN(c);
          #else
            return c;
          #endif
        }
        vec3 px(ivec2 p, ivec2 mx){ return tm(max(texelFetch(map, clamp(p, ivec2(0), mx), 0).rgb, vec3(0.0)) * uWB); }
        void main(){
          ivec2 sz = textureSize(map, 0), mx = sz - 1;
          vec2 f = vUv * vec2(sz) - 0.5; ivec2 i = ivec2(floor(f)); vec2 a = fract(f);
          // tone map first, then interpolate (no HDR ringing when the image is scaled)
          vec3 c = mix(mix(px(i, mx), px(i + ivec2(1, 0), mx), a.x), mix(px(i + ivec2(0, 1), mx), px(i + ivec2(1, 1), mx), a.x), a.y);
          c = clamp(c, 0.0, 1.0);
          #ifdef SRGB_OUT
            c = mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, 12.92 * c, vec3(lessThanEqual(c, vec3(0.0031308))));
          #endif
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false, toneMapped: false, blending: T.NoBlending,
    });
  }
  const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new T.PlaneGeometry(2, 2);

  /* ---- renderer state save/restore around our own draws ---- */
  const _v4a = new T.Vector4(), _v4b = new T.Vector4(), _col = new T.Color(), _sz = new T.Vector2();
  function withState(fn) {
    const rt = R.getRenderTarget(), ac = R.autoClear, ca = R.getClearAlpha(), st = R.getScissorTest();
    R.getClearColor(_col); R.getViewport(_v4a); R.getScissor(_v4b);
    try { return fn(); } finally {
      R.setRenderTarget(rt); R.autoClear = ac; R.setClearColor(_col, ca); R.setViewport(_v4a); R.setScissor(_v4b); R.setScissorTest(st);
    }
  }

  /* ---- path tracer shader additions: string patches on the pinned 0.0.23 shader, each group all-or-nothing ---- */
  // Window portals: part of the sky samples are aimed through the windows (instead of at random sky directions that
  // mostly hit a wall), mixed with the library's own sky importance sampling as one MIS mixture, so still unbiased.
  const GLSL_PORTALS = /* glsl */`
    uniform vec4 phxPortals[${PORTAL_MAX * 3}];   // per window: centre + area, half axis U, half axis V; cross(U, V) points outside
    uniform int phxPortalCount;
    vec3 phxLastOrigin = vec3(0.0);
    float phxPortalWeight(int i, vec3 x) {
      vec4 c = phxPortals[i * 3];
      vec3 n = normalize(cross(phxPortals[i * 3 + 1].xyz, phxPortals[i * 3 + 2].xyz)), d = c.xyz - x;
      float d2 = max(dot(d, d), 1e-6), cosP = dot(d, n) * inversesqrt(d2);
      return cosP > 0.0 ? c.w * cosP / (d2 + c.w) : 0.0;   // ~ solid angle of the window; 0 when x is on its outer side
    }
    float phxPortalSum(vec3 x) {
      float s = 0.0;
      for (int i = 0; i < ${PORTAL_MAX}; i++) { if (i >= phxPortalCount) break; s += phxPortalWeight(i, x); }
      return s;
    }
    float phxPortalProb(float s) { return 0.8 * s / (s + 0.02); }   // share of the sky samples sent through windows
    float phxPortalPdf(vec3 x, vec3 dir, float s) {
      float pdf = 0.0;
      for (int i = 0; i < ${PORTAL_MAX}; i++) {
        if (i >= phxPortalCount) break;
        float w = phxPortalWeight(i, x);
        if (w <= 0.0) continue;
        vec4 c = phxPortals[i * 3];
        vec3 U = phxPortals[i * 3 + 1].xyz, V = phxPortals[i * 3 + 2].xyz, n = normalize(cross(U, V));
        float dn = dot(dir, n);
        if (dn <= 1e-5) continue;
        float t = dot(c.xyz - x, n) / dn;
        vec3 q = x + dir * t - c.xyz;
        if (t <= 0.0 || abs(dot(q, U)) > dot(U, U) || abs(dot(q, V)) > dot(V, V)) continue;
        pdf += w / s * t * t / (c.w * dn);
      }
      return pdf;
    }
    float phxEnvPdf(vec3 x, vec3 dir, inout vec3 color) {
      float pe = sampleEquirect(envRotation3x3 * dir, color);
      float s = phxPortalSum(x), pp = phxPortalProb(s);
      return pp > 0.0 ? pp * phxPortalPdf(x, dir, s) + (1.0 - pp) * pe : pe;
    }
    float phxEnvSample(vec3 x, inout vec3 color, inout vec3 dir) {
      float s = phxPortalSum(x), pp = phxPortalProb(s);
      if (pp > 0.0 && rand(20) < pp) {
        float r = rand(22) * s;
        int k = 0;
        for (int i = 0; i < ${PORTAL_MAX}; i++) {
          if (i >= phxPortalCount) break;
          float w = phxPortalWeight(i, x);
          if (w <= 0.0) continue;
          k = i; r -= w;
          if (r <= 0.0) break;
        }
        vec2 uv = rand2(21) * 2.0 - 1.0;
        dir = normalize(phxPortals[k * 3].xyz + phxPortals[k * 3 + 1].xyz * uv.x + phxPortals[k * 3 + 2].xyz * uv.y - x);
      } else {
        vec3 d;
        sampleEquirectProbability(rand2(7), color, d);
        dir = invEnvRotation3x3 * d;
      }
      return phxEnvPdf(x, dir, color);
    }
  `;
  function patchTracerShader(mat, { portals = true } = {}) {
    const groups = {
      portals: !portals ? null : [
        [/vec3 directLightContribution\(/, m => GLSL_PORTALS + '\n' + m],
        [/float envPdf = sampleEquirectProbability\( rand2\( 7 \), envColor, envDirection \);\s*envDirection = invEnvRotation3x3 \* envDirection;/, () => 'float envPdf = phxEnvSample( rayOrigin, envColor, envDirection );'],
        [/float envPdf = sampleEquirect\( envRotation3x3 \* ray\.direction, envColor \);/, () => 'float envPdf = phxEnvPdf( phxLastOrigin, ray.direction, envColor );'],
        [/gl_FragColor\.rgb \+= directLightContribution\( - ray\.direction, surf, state, hitPoint \);/, m => m + ' phxLastOrigin = hitPoint;'],
      ],
      // small emitters (bulbs, shades) only glow for camera rays: their point light already carries their light, and
      // reaching them through a glossy bounce would count it twice and leave fireflies
      emitters: [
        [/int hitType = traceScene\( ray, state\.fogMaterial, surfaceHit \);/, m => m + ' bool phxPrimary = state.transmissiveRay;'],
        [/gl_FragColor\.rgb \+= \( surf\.emission \* state\.throughputColor \);/, m => 'if ( material.castShadow || phxPrimary ) ' + m],
        // a shadow ray to the bulb crosses the globe's shell, neck and bulb: those passes must not use up the ray's
        // surface budget (bounces left), or grazing rays stop there and draw thin dark rings on the ceiling
        [/bool result = true;\s*for \( int i = 0; i < traversals; i \+\+ \) \{/, m => 'int phxFree = 0; ' + m],
        [/if \( ! material\.castShadow && isShadowRay \) \{\s*continue;\s*\}/, () => 'if ( ! material.castShadow && isShadowRay ) { if ( phxFree < 16 ) { phxFree ++; i --; } continue; }'],
      ],
    };
    let fs = mat.fragmentShader;
    const done = [];
    for (const [name, steps] of Object.entries(groups)) {
      if (!steps) continue;
      if (!steps.every(([re]) => (fs.match(new RegExp(re.source, 'g')) || []).length === 1)) { console.warn('[foto] shader-aanpassing overgeslagen:', name); continue; }
      for (const [re, f] of steps) fs = fs.replace(re, f);
      done.push(name);
    }
    mat.fragmentShader = fs;
    mat.uniforms.phxPortals = { value: new Float32Array(PORTAL_MAX * 12) };
    mat.uniforms.phxPortalCount = { value: 0 };
    return done;
  }

  /* ---- windows: flat glass panes, split per pane, kept when one side sees the sky and the other does not ---- */
  const isGlass = m => !!m && m.visible !== false && blendOK(m) && ((m.transparent && m.opacity < 0.5) || m.transmission > 0.5);
  // additive / multiply (CustomBlending) wash planes are screen tricks, not surfaces: kept out of the path traced scene
  const blendOK = m => m.blending == null || m.blending === T.NormalBlending || m.blending === T.NoBlending;
  function glassRects() {
    const rects = [], a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3();
    const axes = [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)];
    scene.traverseVisible(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (!mats.some(isGlass)) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index, nIdx = idx ? idx.count : pos.count;
      const vid = i => (idx ? idx.getX(i) : i);
      const groups = Array.isArray(o.material) && g.groups.length ? g.groups : [{ start: 0, count: nIdx, materialIndex: 0 }];
      const tris = [];
      for (const gr of groups) {
        if (!isGlass(mats[gr.materialIndex] || mats[0])) continue;
        const end = Math.min(nIdx, gr.start + gr.count);
        for (let i = gr.start; i + 3 <= end; i += 3) tris.push(i);
      }
      if (!tris.length || tris.length > 20000) return;
      // connected parts (by welded position): merged window geometry holds many panes
      const key = new Map(), parent = [];
      const canon = v => { const k = Math.round(pos.getX(v) * 1000) + ',' + Math.round(pos.getY(v) * 1000) + ',' + Math.round(pos.getZ(v) * 1000); let r = key.get(k); if (r === undefined) { r = parent.length; parent.push(r); key.set(k, r); } return r; };
      const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const first = tris.map(i => { const p = canon(vid(i)), q = canon(vid(i + 1)), r = canon(vid(i + 2)); parent[find(q)] = find(p); parent[find(r)] = find(p); return p; });
      const parts = new Map();
      tris.forEach((i, t) => { const r = find(first[t]); if (!parts.has(r)) parts.set(r, []); parts.get(r).push(i); });
      o.updateWorldMatrix(true, false);
      for (const list of parts.values()) {
        const P = [], N = [];
        for (const i of list) {
          a.fromBufferAttribute(pos, vid(i)).applyMatrix4(o.matrixWorld); b.fromBufferAttribute(pos, vid(i + 1)).applyMatrix4(o.matrixWorld); c.fromBufferAttribute(pos, vid(i + 2)).applyMatrix4(o.matrixWorld);
          P.push(a.clone(), b.clone(), c.clone());
          const n = b.clone().sub(a).cross(c.clone().sub(a));
          if (n.lengthSq() < 1e-12 || N.length >= 64) continue;
          n.normalize();
          if (!N.some(u => Math.abs(u.dot(n)) > 0.999)) N.push(n);
        }
        const ext = d => { let lo = Infinity, hi = -Infinity; for (const p of P) { const v = p.dot(d); if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };
        let th = null; // thinnest direction = the pane's normal
        for (const n of N.concat(axes)) { const [lo, hi] = ext(n); if (!th || hi - lo < th.t) th = { n, t: hi - lo, mid: (lo + hi) / 2 }; }
        const n = th.n, cand = N.filter(u => Math.abs(u.dot(n)) < 0.02);
        for (const ax of axes) { const u = ax.clone().cross(n); if (u.lengthSq() > 1e-4) cand.push(u.normalize()); }
        let best = null; // in-plane axes of the tightest rectangle
        for (const u0 of cand) {
          const u = u0.clone().addScaledVector(n, -u0.dot(n)).normalize(), v = n.clone().cross(u), [ul, uh] = ext(u), [vl, vh] = ext(v);
          if (!best || (uh - ul) * (vh - vl) < best.area) best = { u, v, ul, uh, vl, vh, area: (uh - ul) * (vh - vl) };
        }
        if (!best) continue;
        const du = best.uh - best.ul, dv = best.vh - best.vl;
        if (du * dv < 0.03 || th.t > 0.4 || th.t > 0.35 * Math.min(du, dv)) continue; // too small, or not a flat pane
        const ctr = n.clone().multiplyScalar(th.mid).addScaledVector(best.u, (best.ul + best.uh) / 2).addScaledVector(best.v, (best.vl + best.vh) / 2);
        rects.push({ c: ctr, n: n.clone(), t: th.t, U: best.u.clone().multiplyScalar(du / 2), V: best.v.clone().multiplyScalar(dv / 2) });
      }
    });
    return rects;
  }
  function findPortals(pt, eye) {
    const data = new Float32Array(PORTAL_MAX * 12), bvh = pt._generator && pt._generator.bvh;
    if (!bvh || typeof bvh.raycastFirst !== 'function') return { data, count: 0, panes: 0 };
    const rects = glassRects(), ray = new T.Ray(), t1 = new T.Vector3(), t2 = new T.Vector3(), K = 24;
    // fraction of the hemisphere on one side of a pane that is open sky, using the path tracer's own BVH
    const open = (c, n) => {
      t1.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize(); t2.copy(n).cross(t1);
      let k = 0;
      for (let i = 0; i < K; i++) {
        const z = (i + 0.5) / K, r = Math.sqrt(1 - z * z), ph = i * 2.39996323;
        ray.origin.copy(c).addScaledVector(n, 0.03);
        ray.direction.copy(n).multiplyScalar(z).addScaledVector(t1, r * Math.cos(ph)).addScaledVector(t2, r * Math.sin(ph));
        if (!bvh.raycastFirst(ray, T.DoubleSide)) k++;
      }
      return k / K;
    };
    const ps = [];
    for (const r of rects) {
      const nb = r.n.clone().negate(), oa = open(r.c.clone().addScaledVector(r.n, r.t / 2), r.n), ob = open(r.c.clone().addScaledVector(nb, r.t / 2), nb);
      if (Math.abs(oa - ob) < 0.15) continue; // interior glass, the inner pane of double glazing, or glass out in the open
      const out = oa > ob ? r.n : nb;
      const V = r.U.clone().cross(r.V).dot(out) < 0 ? r.V.clone().negate() : r.V;
      ps.push({ c: r.c, U: r.U, V, area: 4 * r.U.length() * r.V.length(), d: r.c.distanceTo(eye) });
    }
    ps.sort((x, y) => x.d - y.d);
    const count = Math.min(PORTAL_MAX, ps.length);
    for (let i = 0; i < count; i++) { const p = ps[i]; data.set([p.c.x, p.c.y, p.c.z, p.area, p.U.x, p.U.y, p.U.z, 0, p.V.x, p.V.y, p.V.z, 0], i * 12); }
    return { data, count, panes: rects.length };
  }

  /* ---- guide buffers for the denoiser: albedo, and world normal + distance, rasterized from the path tracer's view ---- */
  function patchNormalShader(sh) {
    sh.vertexShader = 'varying vec3 vPhxView;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tvPhxView = mvPosition.xyz;');
    sh.fragmentShader = 'varying vec3 vPhxView;\n' + sh.fragmentShader.replace(/gl_FragColor = vec4\( packNormalToRGB\( normal \), diffuseColor\.a \);/,
      'gl_FragColor = vec4( normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz ), length( vPhxView ) );');
  }
  function renderGuides(g0) {
    const meshes = [], hidden = [], orig = new Map(), alb = new Map(), nrm = new Map();
    scene.traverseVisible(o => { if (o.isMesh) { meshes.push(o); orig.set(o, o.material); } else if (o.isSprite || o.isLine || o.isPoints) hidden.push(o); });
    const hideM = new T.MeshBasicMaterial({ visible: false });
    // the camera sees through window glass (84% of its rays): the guides show what is behind it
    const albOf = m => {
      if (!m || m.visible === false || !blendOK(m) || isGlass(m)) return hideM;
      let r = alb.get(m);
      if (!r) {
        r = new T.MeshBasicMaterial({ color: m.color ? m.color.clone() : 0xffffff, map: m.map || null, vertexColors: !!m.vertexColors, alphaMap: m.alphaMap || null,
          alphaTest: m.alphaTest || 0, side: m.side, fog: false, toneMapped: false, blending: T.NoBlending });
        alb.set(m, r);
      }
      return r;
    };
    const nrmOf = m => {
      if (!m || m.visible === false || !blendOK(m) || isGlass(m)) return hideM;
      let r = nrm.get(m);
      if (!r) {
        r = new T.MeshNormalMaterial({ side: m.side, flatShading: !!m.flatShading, blending: T.NoBlending });
        r.onBeforeCompile = patchNormalShader; r.customProgramCacheKey = () => 'phx-guide-n';
        nrm.set(m, r);
      }
      return r;
    };
    const use = f => { for (const o of meshes) { const m = orig.get(o); o.material = Array.isArray(m) ? m.map(f) : f(m); } };
    const bg = scene.background, fog = scene.fog, ov = scene.overrideMaterial, sm = R.shadowMap.autoUpdate, rnd = R.render;
    const g = { rts: [], a: null, n: null };
    try {
      for (const o of hidden) o.visible = false;
      scene.background = null; scene.fog = null; scene.overrideMaterial = null; R.shadowMap.autoUpdate = false;
      if (renderPatch) R.render = renderPatch; // the pause shim swallows renders of the main scene
      withState(() => {
        R.setScissorTest(false); R.autoClear = true; R.setClearColor(0x000000, 0);
        if (g0.pano) {
          const mk = () => new T.WebGLCubeRenderTarget(Q.cube, { type: T.HalfFloatType, generateMipmaps: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter });
          const ra = mk(), rn = mk(); g.rts.push(ra, rn);
          const cc = new T.CubeCamera(0.02, 5000, ra);
          for (const c of cc.children) c.layers.mask = H.camera.layers.mask;
          cc.position.copy(g0.eye); cc.updateMatrixWorld(true);
          use(albOf); cc.update(R, scene);
          cc.renderTarget = rn; use(nrmOf); cc.update(R, scene);
          g.a = ra.texture; g.n = rn.texture;
        } else {
          const mk = () => new T.WebGLRenderTarget(g0.size[0], g0.size[1], { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false });
          const ra = mk(), rn = mk(); g.rts.push(ra, rn);
          use(albOf); R.setRenderTarget(ra); R.render(scene, g0.cam);
          use(nrmOf); R.setRenderTarget(rn); R.render(scene, g0.cam);
          g.a = ra.texture; g.n = rn.texture;
        }
      });
    } catch (e) {
      for (const rt of g.rts) rt.dispose();
      throw e;
    } finally {
      for (const [o, m] of orig) o.material = m;
      for (const o of hidden) o.visible = true;
      scene.background = bg; scene.fog = fog; scene.overrideMaterial = ov; R.shadowMap.autoUpdate = sm; R.render = rnd;
      for (const m of alb.values()) m.dispose();
      for (const m of nrm.values()) m.dispose();
      hideM.dispose();
    }
    g.dispose = () => { for (const rt of g.rts) rt.dispose(); g.rts = []; };
    return g;
  }

  /* ---- a-trous denoiser (SVGF spatial part): demodulate albedo, variance-guided edge-avoiding wavelet passes, remodulate ---- */
  // Working targets hold (illumination rgb, standard deviation); a = -1 marks sky pixels, which pass through untouched.
  const FVS = 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';
  function filterGLSL(pano) {
    return /* glsl */`
      uniform vec2 uSize;
      uniform sampler2D gA; uniform sampler2D gN;
      vec4 GA(vec2 uv){ return texture(gA, uv); }
      vec4 GN(vec2 uv){ return texture(gN, uv); }
      ${pano ? `vec3 dirOf(vec2 uv){ uv.x -= 0.5; uv.y = 1.0 - uv.y; float th = uv.x * 6.28318531, ph = uv.y * 3.14159265, s = sin(ph); return vec3(s * cos(th), cos(ph), s * sin(th)); }`
        : `uniform mat4 uInvProj; uniform mat4 uCamWorld;
      vec3 dirOf(vec2 uv){ vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); return normalize(mat3(uCamWorld) * (v.xyz / v.w)); }`}
      vec2 uvOf(ivec2 p){ return (vec2(p) + 0.5) / uSize; }
      ivec2 wrap(ivec2 q){ ${pano ? 'int w = int(uSize.x); q.x = q.x < 0 ? q.x + w : (q.x >= w ? q.x - w : q.x);' : ''} return q; }   // a panorama is seamless left-right
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      // demodulation divides by albedo + 0.2: glossy reflections are not scaled by albedo, and dividing them by a dark
      // albedo channel would turn every board of a dark floor into its own colour once neighbours are mixed
      vec3 albedo(vec4 a){ return max(a.rgb, vec3(0.0)) + 0.2; }
      vec3 logAlb(vec4 a){ return log(max(a.rgb, vec3(0.02))); }
    `;
  }
  function makeFilter(s, guides) {
    const common = filterGLSL(s.pano);
    const shared = { uSize: { value: new T.Vector2() }, gA: { value: s.pano ? null : guides.a }, gN: { value: s.pano ? null : guides.n } };
    if (!s.pano) Object.assign(shared, { uInvProj: { value: s.cam.projectionMatrixInverse }, uCamWorld: { value: s.cam.matrixWorld } });
    const mk = (name, uniforms, body, withGuides = true) => new T.ShaderMaterial({
      name, uniforms: withGuides ? { ...shared, ...uniforms } : uniforms, vertexShader: FVS, fragmentShader: (withGuides ? common : '') + body,
      depthTest: false, depthWrite: false, toneMapped: false, blending: T.NoBlending,
    });
    const F = { guides, rts: null, w: 0, h: 0, snaps: [], quad: new T.Mesh(quadGeo), ok: true, checked: false };
    F.quad.frustumCulled = false;
    F.copy = mk('phx-copy', { tSrc: { value: null } }, /* glsl */`
      uniform sampler2D tSrc;
      void main(){ gl_FragColor = vec4(min(max(texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).rgb, vec3(0.0)), vec3(6e4)), 1.0); }`, false);
    F.prep = mk('phx-prep', { tSrc: { value: null }, tSnap: { value: null }, uM: { value: 0 }, uN: { value: 0 }, uPxAng: { value: 0.001 }, uClampK: { value: Q.clampK ?? 5 } }, /* glsl */`
      uniform sampler2D tSrc; uniform sampler2D tSnap; uniform float uM; uniform float uN; uniform float uPxAng; uniform float uClampK;
      vec3 rad(sampler2D t, ivec2 q){ return min(max(texelFetch(t, q, 0).rgb, vec3(0.0)), vec3(6e4)); }
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uSize) - 1;
        vec2 up = uvOf(p);
        vec4 A = GA(up);
        vec3 L = rad(tSrc, p);
        if (A.a < 0.5) { gl_FragColor = vec4(L, -1.0); return; }
        vec4 Np = GN(up);
        vec3 np = Np.xyz / max(length(Np.xyz), 1e-4), Xp = dirOf(up) * Np.w;
        vec3 I = L / albedo(A);
        float l0 = lum(I);
        bool split = uM >= 1.0 && uN > uM + 0.5;
        float kv = split ? 1.0 / ((1.0 / uM + 1.0 / (uN - uM)) * uN) : 0.0;
        // noise of each pixel's mean from the accumulation itself (first M samples against the rest), averaged over the
        // 5x5 pixels on the same surface so the estimate is steady; without history the spread of those pixels stands in
        float vs = 0.0, s1 = 0.0, s2 = 0.0, n = 0.0, m8 = 0.0, mxl = 0.0, n8 = 0.0;
        for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
          ivec2 q = clamp(wrap(p + ivec2(x, y)), ivec2(0), mx);
          vec2 uq = uvOf(q);
          vec4 Aq = GA(uq);
          if (Aq.a < 0.5) continue;
          bool c0 = x == 0 && y == 0;
          if (!c0) {
            vec4 Nq = GN(uq);
            if (dot(np, Nq.xyz / max(length(Nq.xyz), 1e-4)) < 0.9) continue;
            if (abs(dot(np, dirOf(uq) * Nq.w - Xp)) > Np.w * uPxAng * 2.0 * length(vec2(x, y)) + 0.004) continue;
          }
          vec3 aq = albedo(Aq), Iq = rad(tSrc, q) / aq;
          float l = lum(Iq);
          if (split) {
            vec3 S = rad(tSnap, q) / aq, B = max((uN * Iq - uM * S) / (uN - uM), vec3(0.0));
            float d = lum(S) - lum(B);
            vs += d * d * kv;
          }
          s1 += l; s2 += l * l; n += 1.0;
          if (!c0 && abs(x) <= 1 && abs(y) <= 1) { m8 += l; mxl = max(mxl, l); n8 += 1.0; }
        }
        float v = split ? vs / n : max(s2 / n - (s1 / n) * (s1 / n), 0.0);
        // a pixel far above every neighbour on its surface is a firefly: pull it down to the brightest of them (or the noise band)
        if (n8 >= 4.0) { float cap = max(mxl, m8 / n8 + uClampK * sqrt(v)) + 1e-4; if (l0 > cap) I *= cap / l0; }
        gl_FragColor = vec4(min(I, vec3(6e4)), min(sqrt(v), 6e4));
      }`);
    F.atrous = mk('phx-atrous', { tIn: { value: null }, uStep: { value: 1 }, uPxAng: { value: 0.001 }, uSigL: { value: Q.sigL ?? 4 }, uFloor: { value: Q.lumFloor ?? 0.02 }, uLum: { value: 1 }, uGain: { value: Q.varGain ?? 1.8 } }, /* glsl */`
      uniform sampler2D tIn; uniform int uStep; uniform float uPxAng; uniform float uSigL; uniform float uFloor; uniform float uLum; uniform float uGain;
      const float K[3] = float[3](0.375, 0.25, 0.0625);
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy), sz = ivec2(uSize);
        vec4 c = texelFetch(tIn, p, 0);
        if (c.a < 0.0) { gl_FragColor = c; return; }
        vec2 up = uvOf(p);
        vec4 Np = GN(up);
        vec3 np = Np.xyz / max(length(Np.xyz), 1e-4), Xp = dirOf(up) * Np.w, ap = logAlb(GA(up));
        float vb = 0.0, gw = 0.0;   // 3x3 blurred variance steers the luminance edge stop
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          ivec2 q = wrap(p + ivec2(x, y));
          if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
          float sd = texelFetch(tIn, q, 0).a;
          if (sd < 0.0) continue;
          float w = (x == 0 ? 0.5 : 0.25) * (y == 0 ? 0.5 : 0.25);
          vb += sd * sd * w; gw += w;
        }
        vb /= gw;
        float st = float(uStep), lp = lum(c.rgb), tol = Np.w * uPxAng * st;
        float sl = uSigL * sqrt(max(vb, 0.0)) + uFloor * sqrt(st) * lp + 1e-5;   // the floor keeps wide passes from cutting walls into patches
        float w0 = K[0] * K[0];
        vec3 acc = c.rgb * w0, accL = acc; float wsum = w0, wL = w0, vacc = w0 * w0 * c.a * c.a, vaccL = vacc;
        for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
          if (x == 0 && y == 0) continue;
          ivec2 q = wrap(p + ivec2(x, y) * uStep);
          if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
          vec4 cq = texelFetch(tIn, q, 0);
          if (cq.a < 0.0) continue;
          vec2 uq = uvOf(q);
          vec4 Nq = GN(uq);
          float dn = max(dot(np, Nq.xyz / max(length(Nq.xyz), 1e-4)), 0.0);
          float wz = exp(-abs(dot(np, dirOf(uq) * Nq.w - Xp)) / (tol * length(vec2(x, y)) + 0.002));   // distance from p's tangent plane
          float wl = exp(-uLum * abs(lum(cq.rgb) - lp) / sl);
          vec3 da = logAlb(GA(uq)) - ap;
          float wa = exp(-16.0 * dot(da, da));   // keep to one material (one board, one book)
          float k = K[abs(x)] * K[abs(y)] * wl * wa;
          float w = k * pow(dn, 64.0) * wz, wo = k * dn * dn;
          acc += cq.rgb * w; vacc += w * w * cq.a * cq.a; wsum += w;
          accL += cq.rgb * wo; vaccL += wo * wo * cq.a * cq.a; wL += wo;
        }
        // the propagated deviation assumes independent pixels, but after each pass neighbours share samples, so it falls
        // faster than the real noise (about 10x too low by the last pass); uGain keeps the edge stop at the real level,
        // otherwise leftover low-frequency noise passes as detail and stays as cloudy blotches on ceilings
        // pixels that no neighbour matches exactly (creases, thin parts mixed with what is behind them) fall back to looser geometry
        float b = smoothstep(0.04, 0.3, (wsum - w0) / wsum);
        gl_FragColor = vec4(mix(accL / wL, acc / wsum, b), uGain * mix(sqrt(vaccL) / wL, sqrt(vacc) / wsum, b));
      }`);
    F.remod = mk('phx-remod', { tIn: { value: null } }, /* glsl */`
      uniform sampler2D tIn;
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 c = texelFetch(tIn, p, 0);
        gl_FragColor = vec4(c.a < 0.0 ? c.rgb : c.rgb * albedo(GA(uvOf(p))), 1.0);
      }`);
    if (Array.isArray(Q.lumRamp)) LUM_RAMP = Q.lumRamp;   // test hook
    F.mats = [F.copy, F.prep, F.atrous, F.remod];
    if (s.pano) {
      // the cube guides resampled to the panorama's pixels, 4x4 directions per pixel, as the path tracer covers each pixel
      F.bake = mk('phx-bake', { cG: { value: null }, uSize: shared.uSize }, /* glsl */`
        uniform samplerCube cG; uniform vec2 uSize;
        void main(){
          vec4 acc = vec4(0.0);
          for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
            vec2 uv = (gl_FragCoord.xy - 0.5 + (vec2(x, y) + 0.5) / 4.0) / uSize;
            uv.x -= 0.5; uv.y = 1.0 - uv.y;
            float th = uv.x * 6.28318531, ph = uv.y * 3.14159265, sp = sin(ph);
            acc += texture(cG, vec3(sp * cos(th), cos(ph), sp * sin(th)));
          }
          gl_FragColor = acc / 16.0;
        }`, false);
      F.mats.push(F.bake);
    }
    F.ensure = (w, h) => {
      if (F.rts && F.w === w && F.h === h) return;
      F.disposeTargets();
      const mkRT = () => new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false, generateMipmaps: false });
      F.rts = { prep: mkRT(), a: mkRT(), b: mkRT(), out: mkRT() };
      F.snaps = [{ rt: mkRT(), m: 0 }, { rt: mkRT(), m: 0 }];
      F.w = w; F.h = h;
      shared.uSize.value.set(w, h);
      if (s.pano) {
        const lin = () => new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false, generateMipmaps: false });
        F.rts.ga = lin(); F.rts.gn = lin();
        withState(() => {
          R.setScissorTest(false); R.autoClear = false;
          F.bake.uniforms.cG.value = guides.a; F.pass(F.bake, F.rts.ga);
          F.bake.uniforms.cG.value = guides.n; F.pass(F.bake, F.rts.gn);
          F.bake.uniforms.cG.value = null;
        });
        shared.gA.value = F.rts.ga.texture; shared.gN.value = F.rts.gn.texture;
      }
    };
    F.disposeTargets = () => {
      if (F.rts) for (const rt of Object.values(F.rts)) rt.dispose();
      for (const sn of F.snaps) sn.rt.dispose();
      F.rts = null; F.snaps = [];
    };
    F.pass = (mat, rt) => { F.quad.material = mat; R.setRenderTarget(rt); R.render(F.quad, quadCam); };
    F.dispose = () => { F.disposeTargets(); for (const m of F.mats) m.dispose(); guides.dispose(); };
    return F;
  }
  // keeps the accumulation at 2, 4, 8, ... samples (two of them): comparing it with the final mean gives each pixel's noise
  function snapshot(s) {
    const F = s.filter, pt = s.pt; if (!F || !F.ok || !pt) return;
    F.ensure(s.size[0], s.size[1]);
    const sn = F.snaps[0].m <= F.snaps[1].m ? F.snaps[0] : F.snaps[1];
    F.copy.uniforms.tSrc.value = pt.target.texture;
    withState(() => { R.setScissorTest(false); R.autoClear = false; F.pass(F.copy, sn.rt); });
    sn.m = pt.samples;
  }
  function runFilter(s) {
    const F = s.filter, pt = s.pt; if (!F || !F.ok || !pt) return null;
    const [w, h] = s.size, N = pt.samples;
    F.ensure(w, h);
    let snap = null; // the snapshot that splits the samples most evenly
    for (const sn of F.snaps) if (sn.m >= 1 && sn.m < N && (!snap || Math.abs(sn.m - N / 2) < Math.abs(snap.m - N / 2))) snap = sn;
    const pxAng = s.pano ? Math.PI / h : 2 * Math.tan(T.MathUtils.degToRad(s.cam.fov) / 2) / (h * (s.cam.zoom || 1));
    withState(() => {
      R.setScissorTest(false); R.autoClear = false;
      const u = F.prep.uniforms;
      u.tSrc.value = pt.target.texture; u.tSnap.value = snap ? snap.rt.texture : pt.target.texture;
      u.uM.value = snap ? snap.m : 0; u.uN.value = N; u.uPxAng.value = pxAng;
      F.pass(F.prep, F.rts.prep);
      let src = F.rts.prep;
      F.atrous.uniforms.uPxAng.value = pxAng;
      for (let i = 0; i < ATROUS_ITER; i++) {
        const dst = i % 2 ? F.rts.b : F.rts.a;
        F.atrous.uniforms.tIn.value = src.texture; F.atrous.uniforms.uStep.value = 1 << i; F.atrous.uniforms.uLum.value = (Array.isArray(Q.lumRamp) ? Q.lumRamp : LUM_RAMP)[i] ?? 1;
        F.pass(F.atrous, dst); src = dst;
      }
      F.remod.uniforms.tIn.value = src.texture;
      F.pass(F.remod, F.rts.out);
    });
    if (!F.checked) {
      F.checked = true;
      for (const m of F.mats) {
        const prog = R.properties.get(m).currentProgram;
        if (prog && prog.diagnostics && prog.diagnostics.runnable === false) { F.ok = false; console.warn('[foto] ruisfilter werkt niet op deze GPU'); return null; }
      }
    }
    return F.rts.out.texture;
  }

  /* ---- environment for the path tracer: the app's sky, lower hemisphere blended to a neutral bounce (same as the app's probe) ---- */
  let envPromise = null;
  function getEnv(L) {
    if (envPromise) return envPromise;
    const bg = scene.background;
    const src = bg && bg.isDataTexture && bg.image && bg.image.data && bg.image.data.length ? Promise.resolve(bg)
      : new L.RGBELoader().setDataType(T.FloatType).loadAsync(new URL('assets/sky_1k.hdr', document.baseURI).href);
    envPromise = src.then(t => {
      const { data, width: w, height: hh } = t.image, n = data.length / (w * hh);
      const d = new Float32Array(w * hh * 4);
      for (let i = 0, j = 0; i < w * hh; i++, j += n) { d[i * 4] = data[j]; d[i * 4 + 1] = data[j + 1]; d[i * 4 + 2] = data[j + 2]; d[i * 4 + 3] = 1; }
      const rowSum = (y0, y1) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; } return s; };
      const topIsSky = rowSum(0, hh >> 2) > rowSum(hh - (hh >> 2), hh);
      const sky = [0, 0, 0]; let c = 0;
      for (let y = topIsSky ? 0 : hh - (hh >> 2); y < (topIsSky ? hh >> 2 : hh); y += 2) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * 4; sky[0] += d[i]; sky[1] += d[i + 1]; sky[2] += d[i + 2]; c++; }
      const bounce = sky.map(v => v / c * 0.45);
      for (let y = 0; y < hh; y++) {
        const v = topIsSky ? 1 - (y + 0.5) / hh : (y + 0.5) / hh, k = Math.min(1, Math.max(0, (0.56 - v) / 0.1));
        if (k <= 0) continue;
        for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; for (let ch = 0; ch < 3; ch++) d[i + ch] += (bounce[ch] - d[i + ch]) * k; }
      }
      const env = new T.DataTexture(d, w, hh, T.RGBAFormat, T.FloatType);
      env.mapping = T.EquirectangularReflectionMapping; env.flipY = t.flipY; env.colorSpace = T.LinearSRGBColorSpace; env.needsUpdate = true;
      if (t !== bg) t.dispose();
      return env; // CPU only: the path tracer makes its own GPU copy, this one is never uploaded
    }).catch(e => {
      console.warn('[foto] lucht-HDR niet beschikbaar, val terug op verloop', e);
      const g = new L.GradientEquirectTexture(64);
      g.topColor.set('#cfe0ee'); g.bottomColor.set('#8c877e'); g.update();
      return g;
    });
    return envPromise;
  }

  /* ---- geometry preparation for the path tracer (plain copies; the originals are never modified) ---- */
  const badAttr = (k, a) => a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array) || a.normalized || (k === 'color' && a.itemSize !== 4);
  function floatAttr(a, size) { // de-interleave and de-quantize; a missing 4th colour channel becomes 1
    const n = a.count, k = Math.min(size, a.itemSize), out = new Float32Array(n * size);
    for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = c < k ? a.getComponent(i, c) : 1;
    return new T.BufferAttribute(out, size);
  }
  // a copy that shares nothing with the original, so disposing it can never free the original's GPU buffers
  function plainGeometry(g) {
    const c = new T.BufferGeometry();
    if (g.index) c.setIndex(new T.BufferAttribute(g.index.array.slice(), 1));
    for (const k in g.attributes) {
      const a = g.attributes[k];
      c.setAttribute(k, PT_ATTRS.includes(k) && badAttr(k, a) ? floatAttr(a, k === 'color' ? 4 : a.itemSize) : a.isInterleavedBufferAttribute ? floatAttr(a, a.itemSize) : a.clone());
    }
    for (const k in g.morphAttributes) c.morphAttributes[k] = g.morphAttributes[k].map(a => floatAttr(a, a.itemSize));
    c.morphTargetsRelative = g.morphTargetsRelative;
    for (const gr of g.groups) c.addGroup(gr.start, gr.count, gr.materialIndex);
    return c;
  }
  // all instances of an InstancedMesh as one plain mesh (instance colours become vertex colours)
  function bakeInstances(im, budget) {
    const g = im.geometry, P = g.attributes.position, V = P ? P.count : 0, n = im.count;
    if (!V || !n || budget < V) return null;
    const step = Math.max(1, Math.ceil(n * V / budget)), ids = [];
    for (let i = 0; i < n; i += step) ids.push(i);
    const N = g.attributes.normal, UV = g.attributes.uv, C = g.attributes.color, IC = im.instanceColor;
    const m = ids.length, out = new T.BufferGeometry(), pos = new Float32Array(m * V * 3);
    const nrm = N && new Float32Array(m * V * 3), uv = UV && new Float32Array(m * V * 2), col = (C || IC) && new Float32Array(m * V * 4);
    const M = new T.Matrix4(), NM = new T.Matrix3(), v = new T.Vector3(), ic = new T.Color(1, 1, 1);
    ids.forEach((id, k) => {
      im.getMatrixAt(id, M); NM.getNormalMatrix(M);
      if (IC) im.getColorAt(id, ic);
      for (let i = 0; i < V; i++) {
        const o = k * V + i;
        v.fromBufferAttribute(P, i).applyMatrix4(M); pos.set([v.x, v.y, v.z], o * 3);
        if (nrm) { v.fromBufferAttribute(N, i).applyNormalMatrix(NM); nrm.set([v.x, v.y, v.z], o * 3); }
        if (uv) { uv[o * 2] = UV.getX(i); uv[o * 2 + 1] = UV.getY(i); }
        if (col) {
          const r = C ? C.getX(i) : 1, gg = C ? C.getY(i) : 1, b = C ? C.getZ(i) : 1;
          col.set([r * ic.r, gg * ic.g, b * ic.b, 1], o * 4);
        }
      }
    });
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    if (nrm) out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    if (uv) out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new T.BufferAttribute(col, 4));
    const I = g.index, cnt = I ? I.count : V;
    if (I) {
      const idx = new Uint32Array(m * cnt);
      for (let k = 0; k < m; k++) for (let j = 0; j < cnt; j++) idx[k * cnt + j] = I.getX(j) + k * V;
      out.setIndex(new T.BufferAttribute(idx, 1));
    }
    for (let k = 0; k < m; k++) for (const gr of g.groups) out.addGroup(gr.start + k * cnt, Math.min(gr.count, cnt - gr.start), gr.materialIndex);
    const mats = [];
    const vc = mat => { if (!col || !mat || mat.vertexColors) return mat; const c = mat.clone(); c.vertexColors = true; mats.push(c); return c; };
    const mesh = new T.Mesh(out, Array.isArray(im.material) ? im.material.map(vc) : vc(im.material));
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(im.matrix); mesh.layers.mask = im.layers.mask;
    mesh.userData.phxMats = mats; mesh.name = 'phx-instances';
    return mesh;
  }
  // one mesh per material: the path tracer assigns exactly one material per mesh (an array would shift all later ones)
  function splitMaterials(o) {
    const g = o.geometry, base = plainGeometry(g), I = base.index, total = I ? I.count : base.attributes.position.count;
    const byMat = new Map();
    for (const gr of g.groups) {
      const m = o.material[gr.materialIndex];
      if (!m || m.visible === false || !blendOK(m)) continue;
      const a = Math.max(0, gr.start), b = Math.min(total, gr.start + gr.count);
      if (b > a) (byMat.get(m) || byMat.set(m, []).get(m)).push([a, b]);
    }
    const parts = [];
    for (const [m, ranges] of byMat) {
      const n = ranges.reduce((s, [a, b]) => s + b - a, 0), idx = new Uint32Array(n);
      let k = 0;
      for (const [a, b] of ranges) for (let j = a; j < b; j++) idx[k++] = I ? I.getX(j) : j;
      const sub = new T.BufferGeometry();
      for (const key in base.attributes) sub.setAttribute(key, base.attributes[key]);
      sub.setIndex(new T.BufferAttribute(idx, 1));
      const mesh = new T.Mesh(sub, m);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(o.matrix); mesh.layers.mask = o.layers.mask; mesh.name = 'phx-part';
      parts.push(mesh);
    }
    return parts;
  }
  function prepGeometry(set, temp) {
    const swap = [], inst = [], multi = [];
    scene.traverseVisible(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      if (o.isInstancedMesh) { inst.push(o); return; }
      if (Array.isArray(o.material) && !o.isSkinnedMesh) { multi.push(o); return; }
      const g = o.geometry;
      if (PT_ATTRS.some(k => g.attributes[k] && badAttr(k, g.attributes[k]))) swap.push(o);
    });
    for (const o of multi) {
      const parts = o.parent ? splitMaterials(o) : [];
      set(o, 'visible', false);
      for (const p of parts) { o.parent.add(p); p.updateMatrixWorld(true); temp.push(p); }
    }
    for (const o of swap) {
      const c = plainGeometry(o.geometry);
      temp.push({ geometry: c, userData: {} });
      set(o, 'geometry', c);
    }
    let budget = INSTANCE_VERTS;
    for (const im of inst) {
      const mesh = bakeInstances(im, budget);
      set(im, 'visible', false);
      if (!mesh || !im.parent) continue;
      budget -= mesh.geometry.attributes.position.count;
      let list = [mesh];
      if (Array.isArray(mesh.material)) { list = splitMaterials(mesh); mesh.geometry.dispose(); if (list[0]) list[0].userData.phxMats = mesh.userData.phxMats; }
      for (const p of list) { im.parent.add(p); p.updateMatrixWorld(true); temp.push(p); }
    }
  }

  /* ---- temporary scene tweaks while the path tracer snapshots the scene; always undone right after ---- */
  function patchScene({ eye, env, showAllLevels }) {
    const undo = [];
    const set = (o, k, v) => { const own = Object.prototype.hasOwnProperty.call(o, k), old = o[k]; o[k] = v; undo.push(() => { if (own) o[k] = old; else delete o[k]; }); };
    if (showAllLevels) for (const c of scene.children) if (c.isGroup && !c.visible) set(c, 'visible', true);
    const wp = new T.Vector3();
    scene.traverse(o => {
      if (!o.isLight || !o.visible) return;
      const supported = o.isDirectionalLight || o.isPointLight || o.isSpotLight || o.isRectAreaLight;
      if (!supported) return; // hemisphere/ambient lights are ignored by the path tracer; the sky light replaces them
      // stand-in lights of a real-time look (post.js window RectAreaLights: the path tracer brings the real window light)
      if (o.userData.post || o.userData.helper || /^post:/.test(o.name || '')) { set(o, 'visible', false); return; }
      // the path tracer picks one light at random per bounce: dark or far lamps would only dilute the sun's samples
      if (!shownInTree(o) || o.intensity <= 1e-3 || (!o.isDirectionalLight && o.getWorldPosition(wp).distanceTo(eye) > LAMP_RANGE)) set(o, 'visible', false);
    });
    // lit bulbs and lamp shades: let light pass through them, as in the rasterizer (point light sits inside the bulb)
    const seen = new Set(), lamps = [], sphere = new T.Sphere();
    const worldSphere = o => {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      return sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
    };
    scene.traverseVisible(o => {
      if (!o.isMesh || !o.material || !o.geometry) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !m.emissive || !(m.emissiveIntensity > 0) || Math.max(m.emissive.r, m.emissive.g, m.emissive.b) <= 0) continue;
        const s = worldSphere(o);
        if (s.radius > SMALL_EMITTER) continue;
        lamps.push(s.clone());
        if (!seen.has(m)) { seen.add(m); set(m, 'castShadow', false); }
      }
    });
    // the small fitting right on a lit globe (cap, gallery ring) would throw a hard ring-shaped shadow of the point
    // light onto the ceiling; a real opal globe glows as a whole, so these parts get a private shadowless material
    if (lamps.length) {
      const fix = [];
      scene.traverseVisible(o => {
        if (!o.isMesh || !o.material || !o.geometry || o.isInstancedMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some(m => m && seen.has(m))) return;
        const s = worldSphere(o);
        if (s.radius <= 0.3 && lamps.some(l => l.center.distanceTo(s.center) <= l.radius + s.radius + 0.05)) fix.push(o);
      });
      for (const o of fix) {
        const mk = m => { if (!m) return m; const c = m.clone(); c.castShadow = false; undo.push(() => c.dispose()); return c; };
        set(o, 'material', Array.isArray(o.material) ? o.material.map(mk) : mk(o.material));
      }
    }
    // meshes the rasterizer never shows (fade spheres, helpers, colorWrite masks, other camera layers) would still block rays
    const ghosts = [];
    scene.traverseVisible(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // custom shaders (e.g. particles that move their vertices on the GPU) have no meaning for the path tracer either
      if (!o.layers.test(H.camera.layers) || (o.geometry && o.geometry.isInstancedBufferGeometry)
        || mats.every(m => !m || m.visible === false || !blendOK(m) || m.colorWrite === false || m.isShaderMaterial || (m.transparent && m.opacity < 0.01))) ghosts.push(o);
    });
    for (const o of ghosts) set(o, 'visible', false);
    // geometry the path tracer cannot merge as is: compressed glTF (interleaved, quantized), rgb vertex colours,
    // multi-material meshes, instanced meshes (it would ignore the instance matrices). Plain copies until the undo below.
    const temp = [];
    try { prepGeometry(set, temp); } catch (e) { console.warn('[foto] geometrie voorbereiden', e); }
    undo.push(() => { for (const x of temp) { x.removeFromParent?.(); x.geometry.dispose(); if (x.userData.phxMats) for (const m of x.userData.phxMats) m.dispose(); } });
    set(scene, 'environment', env);
    const bg = scene.background;
    if (bg && bg.isTexture && !bg.isCubeTexture && !(bg.image && bg.image.data)) set(scene, 'background', env);
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  }

  /* ---- path tracer lifetime ---- */
  function tracerDispose(pt) {
    if (!pt) return;
    const run = () => {
      const renderers = [pt._pathTracer, pt._lowResPathTracer];
      const mats = new Set(renderers.flatMap(r => [r.material, r._blendQuad.material]));
      for (const r of renderers) { try { r.dispose(); } catch (e) { console.warn('[foto] dispose', e); } }
      try { pt._quad.material.dispose(); pt._quad.dispose(); } catch (e) { /* ok */ }
      pt._colorBackground?.dispose(); pt._internalBackground?.dispose();
      const owned = new Set();
      for (const rt of pt.__arrayTargets || []) { rt.dispose(); rt.fsQuad?.material?.dispose(); owned.add(rt.texture); }
      for (const m of mats) {
        for (const [k, u] of Object.entries(m.uniforms)) {
          // never: the app's own sky (backgroundMap) or render target textures (owned by the targets disposed above)
          if (k === 'backgroundMap' || k === 'sobolTexture' || k === 'target1' || k === 'target2' || k === 'map') continue;
          const v = u.value;
          if (!v || typeof v !== 'object' || owned.has(v)) continue;
          if (typeof v.dispose === 'function') v.dispose();
          else for (const x of Object.values(v)) if (x && x.isTexture) x.dispose();
        }
        m.dispose();
      }
      pt._generator?.geometry?.dispose();
      if (pt._generator) pt._generator.bvh = null;
    };
    // never dispose a material whose program is still compiling (three's compileAsync would throw later)
    const pending = [pt._pathTracer._compilePromise, pt._lowResPathTracer._compilePromise].filter(Boolean);
    if (pending.length) Promise.allSettled(pending).then(run); else run();
  }

  async function makeTracer(L, cam, w, hgt, { pano, showAllLevels, guides }) {
    const pt = new L.WebGLPathTracer(R);
    Object.assign(pt, { renderToCanvas: false, synchronizeRenderSize: false, rasterizeScene: false, dynamicLowRes: false, renderDelay: 0, minSamples: 1, fadeDuration: 0 });
    pt.tiles.set(Q.tiles, Q.tiles);
    pt.bounces = Q.bounces; pt.transmissiveBounces = Q.transmissive; pt.filterGlossyFactor = 0.5;
    pt.textureSize.set(Q.texSize, Q.texSize);
    // set the final shader defines up front so the huge path tracing shader is compiled exactly once (asynchronously)
    const ptr = pt._pathTracer, mat = ptr.material, randomType = Q.randomType != null ? Q.randomType : RANDOM_SOBOL;
    for (const m of [mat, pt._lowResPathTracer.material]) { m.defines.CAMERA_TYPE = pano ? 2 : 0; m.defines.RANDOM_TYPE = randomType; }
    Object.assign(mat.defines, { FEATURE_DOF: 0, FEATURE_FOG: 0, FEATURE_BACKGROUND_MAP: scene.background ? 1 : 0 });
    // the stratified sampler only has a fixed number of dimensions: no portal sampling with it
    const patches = Q.patchShader === false ? [] : patchTracerShader(mat, { portals: randomType !== 2 && Q.portals !== false });
    const info = { patches, portals: 0, panes: 0, guides: null };
    // the library compiles with the canvas bound, but renders into a float target: different program variant
    // (no tone mapping, linear output), which would then be compiled a second time, synchronously, on the first sample
    ptr.compileMaterial = () => withState(() => { R.setRenderTarget(ptr._primaryTarget); return R.compileAsync(ptr._fsQuad._mesh, cam); });
    ptr.setSize(w, hgt);
    const env = await getEnv(L);
    const eye = new T.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const undo = patchScene({ eye, env, showAllLevels });
    // the texture atlas is a WebGLArrayRenderTarget that the material only references by its texture: catch it to dispose it later
    const setRT = R.setRenderTarget;
    pt.__arrayTargets = new Set();
    R.setRenderTarget = function (rt, ...a) { if (rt && rt.isWebGLArrayRenderTarget) pt.__arrayTargets.add(rt); return setRT.call(this, rt, ...a); };
    try {
      pt.setScene(scene, cam);
      // with the scene exactly as the path tracer sees it: windows that lead outside, and the denoiser's guide buffers
      if (patches.includes('portals')) {
        try {
          const p = findPortals(pt, eye);
          mat.uniforms.phxPortals.value.set(p.data); mat.uniforms.phxPortalCount.value = p.count;
          info.portals = p.count; info.panes = p.panes;
        } catch (e) { console.warn('[foto] vensters niet gevonden', e); }
      }
      if (guides) {
        try { info.guides = renderGuides(guides); } catch (e) { console.warn('[foto] ruisfilter niet beschikbaar', e); }
      }
    } finally { R.setRenderTarget = setRT; undo(); }
    mat.onBeforeRender(); // no-op when the defines above were right; otherwise it queues a compile itself
    if (!ptr._compilePromise) ptr._compileFunction();
    pt.__info = info;
    return pt;
  }

  /* ---------------- session (one at a time) ---------------- */
  let S = null;
  const stats = { last: null };

  function roomLabel(pos) {
    try {
      const fl = (H.floors || []).filter(f => pos.y - 0.4 >= f.y).sort((a, b) => b.y - a.y)[0];
      const lvl = fl ? H.floors.indexOf(fl) : 0, id = H.roomAt ? H.roomAt(lvl, pos.x, pos.z) : null;
      return id || 'huis';
    } catch (e) { return 'huis'; }
  }

  function buildUI(kind) {
    const pano = kind === 'pano';
    const ui = {};
    ui.root = h('div', { class: 'phx', role: 'dialog', 'aria-modal': 'true', 'aria-label': pano ? '360°-panorama' : 'Foto' });
    ui.hint = h('div', { class: 'phx-hint', hidden: true }, 'Sleep om rond te kijken · scroll of knijp om te zoomen');
    ui.title = h('h2', { class: 'phx-title' }, pano ? '360°-panorama' : 'Foto');
    ui.meta = h('span', { class: 'phx-meta' }, '');
    ui.barFill = h('i');
    ui.bar = h('div', { class: 'phx-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Voortgang' }, ui.barFill);
    ui.status = h('p', { class: 'phx-status' }, 'Path tracer laden…');
    ui.live = h('span', { class: 'phx-sr', 'aria-live': 'polite' });
    ui.resSeg = h('div', { class: 'phx-seg', role: 'group', 'aria-label': 'Resolutie' });
    ui.resField = h('div', { class: 'phx-field' }, h('span', {}, 'Resolutie'), ui.resSeg);
    ui.expOut = h('output', {}, '±0 EV');
    ui.exp = h('input', { type: 'range', min: '-2', max: '2', step: '0.25', value: '0', 'aria-label': 'Belichting' });
    ui.expField = h('label', { class: 'phx-field' }, h('span', {}, 'Belichting'), ui.exp, ui.expOut);
    ui.dnSeg = h('div', { class: 'phx-seg', role: 'group', 'aria-label': 'Ruisfilter' });
    for (const [v, label] of [[1, 'Aan'], [0, 'Uit']]) {
      const b = h('button', { type: 'button', 'aria-pressed': String(v === 1) }, label);
      b.onclick = () => { for (const x of ui.dnSeg.children) x.setAttribute('aria-pressed', String(x === b)); if (S) { S.denoise = v; S.dirty = true; if (v) refreshFilter(S, performance.now(), true); } };
      ui.dnSeg.append(b);
    }
    ui.dnField = h('div', { class: 'phx-field', title: 'Haalt de korrel weg zonder randen en texturen te vervagen' }, h('span', {}, 'Ruisfilter'), ui.dnSeg);
    ui.done = h('button', { type: 'button', class: 'phx-btn', title: 'Stop met verfijnen en houd dit resultaat' }, 'Klaar');
    ui.save = h('button', { type: 'button', class: 'phx-btn', hidden: !allowSave, html: ICON.save + '<span>Opslaan</span>', title: 'Download als PNG' });
    ui.close = h('button', { type: 'button', class: 'phx-btn primary' }, 'Sluiten');
    ui.note = h('p', { class: 'phx-note', hidden: !PHONE }, 'Let op: op een telefoon is dit traag (1 tot 3 minuten) en wordt het toestel warm. Lagere resolutie gaat sneller.');
    const card = h('div', { class: 'phx-card' },
      h('div', { class: 'phx-head' }, ui.title, ui.meta), ui.bar, ui.status, ui.live,
      h('div', { class: 'phx-row' }, ui.resField, ui.expField, ui.dnField), h('div', { class: 'phx-row' }, h('span', { class: 'phx-grow' }), h('div', { class: 'phx-btns' }, ui.done, ui.save, ui.close)), ui.note);
    ui.card = card;
    ui.root.append(ui.hint, card);
    card.addEventListener('pointerdown', e => e.stopPropagation());
    card.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    document.body.append(ui.root);
    return ui;
  }

  function setRes(ui, opts, cur, onPick) {
    ui.resSeg.textContent = '';
    for (const o of opts) {
      const b = h('button', { type: 'button', 'aria-pressed': String(o.v === cur), title: o.title || '' }, o.label);
      b.onclick = () => { if (b.getAttribute('aria-pressed') === 'true') return; for (const x of ui.resSeg.children) x.setAttribute('aria-pressed', String(x === b)); onPick(o.v); };
      ui.resSeg.append(b);
    }
  }

  function keyGuard(e) {
    if (!S) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (S.phase === 'view' && S.view && !(e.target instanceof HTMLInputElement)) {
      const k = 0.06, v = S.view;
      if (e.key === 'ArrowLeft') v.yaw += k; else if (e.key === 'ArrowRight') v.yaw -= k;
      else if (e.key === 'ArrowUp') v.pitch = Math.min(1.5, v.pitch + k); else if (e.key === 'ArrowDown') v.pitch = Math.max(-1.5, v.pitch - k);
      else if (e.key === '+' || e.key === '=') v.fov = Math.max(25, v.fov / 1.1); else if (e.key === '-') v.fov = Math.min(100, v.fov * 1.1);
    }
    e.stopPropagation(); // keep WASD / E / shortcuts away from the walkthrough while the overlay is open (buttons still work)
  }

  async function start(kind) {
    if (S) return;
    const pano = kind === 'pano';
    let eye = null, showAllLevels = false;
    if (pano) {
      if (H.mode === 'walk') eye = new T.Vector3().setFromMatrixPosition(H.camera.matrixWorld);
      else if (H.walker && Number.isFinite(H.walker.x)) {
        const fl = H.floors && H.floors[H.walker.l]; eye = new T.Vector3(H.walker.x, (fl ? fl.y : 0) + 1.6, H.walker.z); showAllLevels = true;
      } else { toast('Kies eerst Rondlopen: de 360° wordt gemaakt vanaf je eigen plek.'); return; }
    }
    if (!supported()) { toast('Foto maken lukt niet in deze browser: WebGL2 met float-rendering is nodig.'); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    const t0 = performance.now();
    S = { kind, pano, phase: 'load', t0, k: 1, dirty: false, exposureEV: 0, denoise: 1, closed: false, lastSize: '', stats: { kind } };
    const s = S;
    setToolsBusy(true);
    document.documentElement.classList.add('phx-on');
    window.addEventListener('keydown', keyGuard, true);
    R.domElement.addEventListener('webglcontextlost', onContextLost);
    const ui = s.ui = buildUI(kind);
    ui.close.onclick = () => close();
    ui.done.onclick = () => finish(true);
    ui.save.onclick = () => save();
    ui.exp.oninput = () => { s.exposureEV = +ui.exp.value; ui.expOut.value = ui.expOut.textContent = (s.exposureEV > 0 ? '+' : s.exposureEV < 0 ? '−' : '±') + nf1.format(Math.abs(s.exposureEV)).replace(',0', '') + ' EV'; s.dirty = true; };
    ui.close.focus({ preventScroll: true });
    if (PHONE) toast('Let op: op een telefoon is dit traag en wordt je toestel warm.');
    // post.js exposes the walkthrough like a camera (in the evening it stops down for the lamps); the app metering below runs
    // with post.js off, so its gain is kept to expose the photo as dark as the view the user actually sees (only ever darker)
    // and its white balance: at night it takes out part of the lamps' orange, as a camera would
    s.wb = [1, 1, 1];
    try {
      const pi = H.post?.info?.(); s.postGain = H.mode === 'walk' && pi && pi.gain > 0 ? Math.min(1, pi.gain) : 1;
      if (pi && Array.isArray(pi.wb) && pi.wb.length === 3 && pi.wb.every(v => v > 0.2 && v < 5)) s.wb = pi.wb.slice();
    } catch (e) { s.postGain = 1; }
    pauseHost(true);
    s.baseExposure = R.toneMappingExposure;
    s.toneMat = makeToneMaterial(); s.quad = new T.Mesh(quadGeo, s.toneMat); s.quad.frustumCulled = false;

    // camera + size
    R.getDrawingBufferSize(_sz);
    if (pano) {
      s.size = [Q.panoDef, Q.panoDef / 2];
      setRes(ui, Q.panoW.map(w => ({ v: w, label: (w / 1024) + 'K', title: `${w} × ${w / 2}` })), Q.panoDef, w => restart([w, w / 2]));
      s.eye = eye; s.viewQuat = new T.Quaternion(); H.camera.getWorldQuaternion(s.viewQuat);
      s.room = H.walker && H.mode !== 'walk' && H.roomAt ? (H.roomAt(H.walker.l, H.walker.x, H.walker.z) || 'huis') : roomLabel(eye);
    } else {
      const dbw = _sz.x, dbh = _sz.y, scales = [0.5, 0.75, 1];
      const fit = scales.filter(k => dbw * dbh * k * k <= Q.budget).pop() || 0.5;
      const dims = k => [Math.max(64, Math.round(dbw * k)), Math.max(64, Math.round(dbh * k))];
      s.size = dims(fit);
      const full = dims(1), gk = Math.min(Q.gss, Math.sqrt(Q.gMax / (full[0] * full[1])));
      s.guideSize = [Math.round(full[0] * gk), Math.round(full[1] * gk)]; // one guide set serves every resolution
      setRes(ui, scales.map(k => ({ v: k, label: Math.round(k * 100) + '%', title: dims(k).join(' × ') })), fit, k => restart(dims(k)));
      s.camPos = new T.Vector3().setFromMatrixPosition(H.camera.matrixWorld);
      s.room = roomLabel(s.camPos);
    }
    s.stats.size = s.size.slice();

    let L;
    try { L = await loadLibs(T); } catch (e) { fail('De path tracer kon niet geladen worden. Controleer de import map.', e); return; }
    if (s.closed) return;
    s.stats.loadMs = Math.round(performance.now() - t0);
    ui.status.textContent = 'Scène voorbereiden…'; await raf(); await raf();
    if (s.closed) return;
    s.L = L; s.showAllLevels = showAllLevels;
    try { await build(); } catch (e) { fail('Foto maken lukt niet op dit apparaat.', e); return; }
  }

  function makeCam() {
    const s = S, L = s.L;
    if (s.pano) { const c = new L.EquirectCamera(); c.position.copy(s.eye); c.updateMatrixWorld(true); return c; }
    const c = H.camera.clone(); H.camera.updateMatrixWorld();
    H.camera.matrixWorld.decompose(c.position, c.quaternion, c.scale);
    if (c.isPerspectiveCamera) { c.aspect = s.size[0] / s.size[1]; c.updateProjectionMatrix(); }
    c.updateMatrixWorld(true);
    return c;
  }

  async function build() {
    const s = S;
    const tb = performance.now();
    s.cam = makeCam();
    s.appLum = meterApp(s); s.stats.appLum = s.appLum && +s.appLum.toFixed(4);
    const guides = Q.denoiser === false ? null : { pano: s.pano, eye: s.eye, cam: s.cam, size: s.guideSize };
    s.pt = await makeTracer(s.L, s.cam, s.size[0], s.size[1], { pano: s.pano, showAllLevels: s.showAllLevels, guides });
    const info = s.pt.__info;
    if (s.closed) { tracerDispose(s.pt); s.pt = null; info.guides?.dispose(); return; }
    s.stats.patches = info.patches.join(',') || 'geen'; s.stats.portals = info.portals; s.stats.panes = info.panes;
    if (info.guides) {
      try { s.filter = makeFilter(s, info.guides); } catch (e) { console.warn('[foto] ruisfilter', e); info.guides.dispose(); }
    }
    s.stats.denoiser = !!s.filter;
    if (!s.filter) { s.denoise = 0; s.ui.dnField.hidden = true; }
    s.nextSnap = 2;
    s.stats.sceneMs = Math.round(performance.now() - tb);
    s.phase = 'render'; s.tRender = performance.now(); s.target = s.pano ? Q.pano : Q.still;
    s.ui.status.textContent = 'Shader compileren… de eerste keer duurt dit even.';
    s.raf = requestAnimationFrame(frame);
  }

  function restart(size) {
    const s = S; if (!s || !s.pt || (s.phase !== 'render' && s.phase !== 'done')) return;
    s.size = size; s.stats.size = size.slice();
    if (!s.pano) { s.cam.aspect = size[0] / size[1]; s.cam.updateProjectionMatrix(); s.pt.setCamera(s.cam); }
    s.pt._pathTracer.setSize(size[0], size[1]); s.pt.reset();
    if (s.filter) s.filter.disposeTargets();
    s.nextSnap = 2; s.filterTex = null; s.filteredAt = null; s.lastFilterT = 0;
    s.phase = 'render'; s.tRender = performance.now(); s.firstSample = null; s.k = 1; s.ui.done.disabled = false;
  }

  function fmtTime(ms) { const t = ms / 1000; return t < 60 ? nf0.format(t) + ' s' : Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0') + ' min'; }

  function frame(now) {
    const s = S; if (!s || s.closed) return;
    s.raf = requestAnimationFrame(frame);
    if (s.phase === 'view') { drawViewer(); return; }
    const pt = s.pt; if (!pt) return;
    try {
    if (s.phase === 'render') {
      if (pt.isCompiling) {
        s.ui.meta.textContent = fmtTime(now - s.t0);
        if (now - s.tRender > COMPILE_LIMIT_MS) fail('De shader compileert te traag op dit apparaat.', new Error('compile timeout'));
        return;
      }
      if (s.compiledAt == null) { s.compiledAt = now; s.stats.compileMs = Math.round(now - s.tRender); s.tRender = now; s.ui.status.textContent = 'Licht wordt berekend…'; }
      const dt = s.lastNow ? now - s.lastNow : 16; s.lastNow = now;
      // adaptive batch: as many tiles per frame as the GPU manages while the page stays responsive (~25-30 fps)
      if (dt < 36) s.k = Math.min(s.k + 1, 64); else if (dt > 60) s.k = Math.max(1, Math.floor(s.k * 0.7));
      const capMs = (s.pano ? Q.capP : Q.capS) * 1000; // with the denoiser ~200 spp is clean for a still; 360 gets longer
      for (let i = 0; i < s.k && pt.samples < s.target; i++) {
        pt.renderSample();
        if (s.filter && pt.samples === s.nextSnap) { snapshot(s); s.nextSnap *= 2; }
      }
      s.dirty = true;
      if (!s.programOk) {
        // a shader that failed to compile/link renders nothing: bail out with a message instead of a black frame
        const prog = R.properties.get(pt._pathTracer.material).currentProgram;
        if (prog && prog.diagnostics && prog.diagnostics.runnable === false) { fail('De path tracer werkt niet op deze GPU.', new Error('program not runnable')); return; }
        s.programOk = true;
      }
      if (s.autoAt == null && pt.samples >= 16) { s.autoAt = pt.samples; meterExposure(); }
      const el = now - s.tRender;
      if (s.firstSample == null && pt.samples >= 1) s.firstSample = el;
      const frac = Math.min(1, Math.max(pt.samples / s.target, el / capMs));
      s.ui.barFill.style.width = (frac * 100).toFixed(1) + '%'; s.ui.bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      s.ui.meta.textContent = `${Math.floor(pt.samples)} samples · ${fmtTime(now - s.t0)}`;
      if (pt.samples >= s.target || (el >= capMs && pt.samples >= 8)) { finish(false); if (!s.pt || S !== s) return; } // 360: tracer is gone, viewer takes over
    }
    refreshFilter(s, now, false);
    if (s.dirty || sizeKey() !== s.lastSize) { drawFit(); s.dirty = false; }
    } catch (e) { fail('Er ging iets mis tijdens het renderen.', e); }
  }
  const sizeKey = () => { R.getSize(_sz); return _sz.x + 'x' + _sz.y; };

  const filterOn = s => !!(s.denoise && s.filter && s.filter.ok);
  const displayTex = s => (filterOn(s) && s.filterTex ? s.filterTex : s.pt.target.texture);
  // denoise the current accumulation: throttled while rendering, once more when the samples stop
  function refreshFilter(s, now, force) {
    if (!filterOn(s) || !s.pt || s.compiledAt == null || s.pt.samples < 1) return;
    if (s.filteredAt === s.pt.samples && s.filterTex) return;
    if (!force && now - (s.lastFilterT || 0) < Q.filterMs && s.filterTex) return;
    const t = performance.now();
    try { s.filterTex = runFilter(s); } catch (e) { console.warn('[foto] ruisfilter', e); s.filter.ok = false; }
    if (!s.filter.ok || !s.filterTex) { s.filterTex = null; s.denoise = 0; s.ui.dnField.hidden = true; return; }
    s.filteredAt = s.pt.samples; s.lastFilterT = now; s.dirty = true;
    s.stats.filterCpuMs = +(performance.now() - t).toFixed(1);
  }

  function drawFit() {
    const s = S; if (!s || !s.pt) return;
    s.toneMat.uniforms.map.value = displayTex(s);
    s.toneMat.uniforms.uExposure.value = exposureOf(s); s.toneMat.uniforms.uWB.value.fromArray(s.wb);
    s.lastSize = sizeKey();
    withState(() => {
      R.getSize(_sz);
      const tw = s.size[0], th = s.size[1], k = Math.min(_sz.x / tw, _sz.y / th), w = tw * k, hh = th * k;
      R.setRenderTarget(null); R.setScissorTest(false); R.autoClear = true; R.setClearColor(0x0b0f0d, 1);
      R.setViewport((_sz.x - w) / 2, (_sz.y - hh) / 2, w, hh);
      R.render(s.quad, quadCam);
    });
  }

  function exportCanvas() {
    const s = S, [w, hh] = s.size;
    refreshFilter(s, performance.now(), true);
    s.toneMat.uniforms.map.value = displayTex(s);
    s.toneMat.uniforms.uExposure.value = exposureOf(s); s.toneMat.uniforms.uWB.value.fromArray(s.wb);
    const rt = new T.WebGLRenderTarget(w, hh, { type: T.UnsignedByteType, format: T.RGBAFormat, depthBuffer: false, minFilter: T.NearestFilter, magFilter: T.NearestFilter, generateMipmaps: false });
    const px = new Uint8Array(w * hh * 4);
    try {
      withState(() => { R.setRenderTarget(rt); R.setScissorTest(false); R.autoClear = false; R.render(s.quad, quadCam); });
      R.readRenderTargetPixels(rt, 0, 0, w, hh, px);
    } finally { rt.dispose(); }
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const ctx = c.getContext('2d'), img = ctx.createImageData(w, hh), row = w * 4;
    for (let y = 0; y < hh; y++) img.data.set(px.subarray((hh - 1 - y) * row, (hh - y) * row), y * row); // GL rows are bottom-up
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ---- auto exposure: the photo is exposed to look as bright as the walkthrough did from the same spot ----
     The app lights rooms with the sky probe unshadowed (as if outdoors); the path tracer lets daylight in only through the
     windows, as a real interior is lit, which makes it several stops darker. A camera indoors opens up for that, and so
     does this: the app's own frame of the same view is metered the same way and the photo is matched to it. */
  const lumMats = {}; let lumRT = null;
  const LUM_W = 64, LUM_H = 32;
  function lumMaterial(kind) {   // kind: 'flat' (photo), 'equi' (2:1 panorama texture), 'cube' (cube render target)
    if (lumMats[kind]) return lumMats[kind];
    const cube = kind === 'cube';
    return (lumMats[kind] = new T.ShaderMaterial({
      uniforms: { map: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false, blending: T.NoBlending,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`uniform ${cube ? 'samplerCube' : 'sampler2D'} map;
        void main(){
          vec2 cell = 1.0 / vec2(${LUM_W}.0, ${LUM_H}.0), o = floor(gl_FragCoord.xy) * cell;
          float acc = 0.0;   // mean of the cell first, then its log: noise in an early frame does not drag the meter down
          for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
            vec2 uv = o + (vec2(x, y) + 0.5) * cell / 4.0;
            ${cube ? `uv.x -= 0.5; uv.y = 1.0 - uv.y; float th = uv.x * 6.28318531, ph = uv.y * 3.14159265, sp = sin(ph);
            vec3 c = texture(map, vec3(sp * cos(th), cos(ph), sp * sin(th))).rgb;` : `vec3 c = texelFetch(map, ivec2(uv * vec2(textureSize(map, 0))), 0).rgb;`}
            acc += dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
          }
          gl_FragColor = vec4(log(max(acc / 16.0, 1e-4)), 0.0, 0.0, 1.0);
        }` }));
  }
  // centre-weighted log-average luminance of a frame (a panorama is weighted by solid angle instead)
  function logAverage(tex, kind) {
    if (!lumRT) lumRT = new T.WebGLRenderTarget(LUM_W, LUM_H, { type: T.FloatType, format: T.RGBAFormat, depthBuffer: false, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
    const mat = lumMaterial(kind); mat.uniforms.map.value = tex;
    const q = new T.Mesh(quadGeo, mat); q.frustumCulled = false;
    const px = new Float32Array(LUM_W * LUM_H * 4);
    withState(() => { R.setRenderTarget(lumRT); R.setScissorTest(false); R.autoClear = false; R.render(q, quadCam); });
    R.readRenderTargetPixels(lumRT, 0, 0, LUM_W, LUM_H, px);
    mat.uniforms.map.value = null;
    let sum = 0, wsum = 0;
    for (let y = 0; y < LUM_H; y++) for (let x = 0; x < LUM_W; x++) {
      const v = px[(y * LUM_W + x) * 4]; if (!Number.isFinite(v)) continue;
      const dx = (x + 0.5) / LUM_W - 0.5, dy = (y + 0.5) / LUM_H - 0.5;
      const w = kind === 'flat' ? 1.5 - Math.min(1, 2.2 * Math.hypot(dx, dy * 0.8)) : Math.cos(dy * Math.PI);
      sum += v * w; wsum += w;
    }
    return wsum ? Math.exp(sum / wsum) : null;
  }
  // the walkthrough's frame of this view, linear (before tone mapping), metered like the photo
  function meterApp(s) {
    if (H.mode !== 'walk') return null;   // the dollhouse view has no ceilings: not a fair reference for a room
    let rt = null;
    const rnd = R.render;
    try {
      if (renderPatch) R.render = renderPatch;
      withState(() => {
        R.setScissorTest(false); R.autoClear = true;
        if (s.pano) {
          rt = new T.WebGLCubeRenderTarget(256, { type: T.HalfFloatType, generateMipmaps: false });
          const cc = new T.CubeCamera(H.camera.near || 0.05, H.camera.far || 400, rt);
          for (const c of cc.children) c.layers.mask = H.camera.layers.mask;
          cc.position.copy(s.eye); cc.updateMatrixWorld(true); cc.update(R, scene);
        } else {
          rt = new T.WebGLRenderTarget(256, Math.max(16, Math.round(256 * s.size[1] / s.size[0])), { type: T.HalfFloatType, generateMipmaps: false });
          R.setRenderTarget(rt); R.render(scene, s.cam);
        }
      });
      R.render = rnd;
      const l = logAverage(rt.texture, s.pano ? 'cube' : 'flat');
      return l && Number.isFinite(l) && l > 1e-4 ? l : null;
    } catch (e) { console.warn('[foto] belichting van de app meten', e); return null; }
    finally { R.render = rnd; rt?.dispose(); }
  }
  function meterExposure() {
    const s = S; if (!s || !s.pt) return;
    const lavg = logAverage(s.pt.target.texture, s.pano ? 'equi' : 'flat'); if (!lavg) return;
    // matched to the app; without that reference, a fixed key (mid grey) with a modest limit
    const ev = s.appLum ? Math.log2(s.appLum * (s.postGain || 1) / Math.max(1e-6, lavg)) : Math.log2(AUTO_KEY / Math.max(1e-6, lavg * s.baseExposure));
    s.autoEV = s.appLum ? Math.max(-2, Math.min(AUTO_EV_APP, ev)) : Math.max(-1, Math.min(AUTO_EV_MAX, ev));
    s.stats.autoEV = +s.autoEV.toFixed(2); s.stats.meteredEV = +ev.toFixed(2); s.stats.meter = s.appLum ? 'app' : 'key';
    s.dirty = true;
  }
  const exposureOf = s => s.baseExposure * Math.pow(2, (s.autoEV || 0) + s.exposureEV);
  function supported() {
    try { return !!(R.capabilities.isWebGL2 && R.extensions.has('EXT_color_buffer_float')); } catch (e) { return false; }
  }
  function onContextLost() { if (S) fail('De GPU gaf het op (WebGL-context verloren). Probeer een lagere resolutie.', new Error('context lost')); }

  function finish(early) {
    const s = S; if (!s || s.phase !== 'render' || !s.pt) return;
    const now = performance.now();
    if (s.compiledAt == null) return; // still compiling: nothing to keep yet
    meterExposure();
    const sp = Math.floor(s.pt.samples);
    s.stats.samples = sp; s.stats.renderMs = Math.round(now - s.tRender); s.stats.totalMs = Math.round(now - s.t0); s.stats.early = early;
    s.stats.samplesPerSec = +(sp / Math.max(0.001, (now - s.tRender) / 1000)).toFixed(1);
    stats.last = { ...s.stats };
    s.ui.barFill.style.width = '100%'; s.ui.bar.setAttribute('aria-valuenow', '100');
    s.ui.done.disabled = true;
    refreshFilter(s, now, true); s.dirty = true;
    if (s.pano) { s.ui.status.textContent = 'Panorama klaar, viewer openen…'; openViewer(); return; }
    s.phase = 'done';
    s.ui.status.textContent = `Klaar · ${sp} samples in ${fmtTime(now - s.tRender)}` + (allowSave ? '. Opslaan downloadt een PNG.' : '.');
    s.ui.live.textContent = 'Foto klaar';
  }

  /* ---- 360° viewer: sphere with the baked panorama, own camera, drag to look, wheel/pinch to zoom ---- */
  function openViewer() {
    const s = S;
    s.panoCanvas = exportCanvas();
    tracerDispose(s.pt); s.pt = null;
    if (s.filter) { s.filter.dispose(); s.filter = null; s.filterTex = null; }
    const tex = new T.CanvasTexture(s.panoCanvas);
    tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = R.capabilities.getMaxAnisotropy(); tex.generateMipmaps = true; tex.minFilter = T.LinearMipmapLinearFilter;
    const geo = new T.SphereGeometry(50, 128, 64);
    geo.scale(1, 1, -1); // maps the sphere's uv onto the path tracer's equirect convention (u = 0.5 looks along +x), seen from inside
    const mat = new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide, toneMapped: false, depthWrite: false, fog: false });
    const vs = new T.Scene(); vs.add(new T.Mesh(geo, mat));
    const cam = new T.PerspectiveCamera(75, 1, 0.1, 200);
    const e = new T.Euler().setFromQuaternion(s.viewQuat, 'YXZ');
    s.view = { scene: vs, cam, tex, geo, mat, yaw: e.y, pitch: Math.max(-1.4, Math.min(1.4, e.x)), fov: 75 };
    s.phase = 'view';
    const ui = s.ui;
    ui.title.textContent = '360°-panorama';
    ui.status.textContent = 'Sleep om rond te kijken, scroll of knijp om te zoomen.';
    ui.meta.textContent = `${s.stats.samples} samples · ${fmtTime(s.stats.totalMs)}`;
    ui.bar.hidden = true; ui.resField.hidden = true; ui.expField.hidden = true; ui.dnField.hidden = true; ui.done.hidden = true; ui.note.hidden = true;
    ui.hint.hidden = false;
    ui.root.classList.add('view');
    ui.live.textContent = 'Panorama klaar';
    attachDrag(ui.root);
    setTimeout(() => { if (S === s && ui.hint) ui.hint.hidden = true; }, 5000);
  }

  function attachDrag(el) {
    const s = S, ptrs = new Map(); let pinch = null;
    const onDown = e => {
      if (e.target.closest('.phx-card')) return;
      el.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); el.classList.add('drag');
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: s.view.fov }; }
    };
    const onMove = e => {
      const p = ptrs.get(e.pointerId); if (!p || !s.view) return;
      const v = s.view;
      if (ptrs.size === 1) {
        const k = THREE_DEG * v.fov / Math.max(1, innerHeight);
        v.yaw += (e.clientX - p.x) * k; v.pitch = Math.max(-1.5, Math.min(1.5, v.pitch + (e.clientY - p.y) * k));
      }
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); v.fov = Math.max(25, Math.min(100, pinch.fov * pinch.d / Math.max(1, d))); }
    };
    const onUp = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) el.classList.remove('drag'); };
    const onWheel = e => { if (!s.view || e.target.closest('.phx-card')) return; e.preventDefault(); s.view.fov = Math.max(25, Math.min(100, s.view.fov * Math.exp(e.deltaY * 0.0012))); };
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp); el.addEventListener('wheel', onWheel, { passive: false });
  }
  const THREE_DEG = Math.PI / 180;

  function drawViewer() {
    const v = S.view; if (!v) return;
    withState(() => {
      R.getSize(_sz);
      v.cam.aspect = _sz.x / Math.max(1, _sz.y); v.cam.fov = v.fov; v.cam.updateProjectionMatrix();
      v.cam.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
      R.setRenderTarget(null); R.setScissorTest(false); R.setViewport(0, 0, _sz.x, _sz.y); R.autoClear = true;
      R.render(v.scene, v.cam);
    });
  }

  function save() {
    const s = S; if (!s || !allowSave) return;
    let c = null;
    if (s.phase === 'view') c = s.panoCanvas;
    else if (s.pt && s.compiledAt != null && s.pt.samples >= 1) c = exportCanvas();
    if (!c) { toast('Nog even wachten: er is nog geen beeld.'); return; }
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `ons-huis-${s.pano ? '360-' : ''}${s.room}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.png`;
    c.toBlob(b => {
      if (!b) { toast('Opslaan mislukt.'); return; }
      const a = h('a', { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(`Opgeslagen als ${name}`);
    }, 'image/png');
  }

  function fail(msg, err) {
    console.warn('[foto]', err);
    toast(msg);
    close();
  }

  function close() {
    const s = S; if (!s) return;
    s.closed = true; S = null;
    cancelAnimationFrame(s.raf);
    window.removeEventListener('keydown', keyGuard, true);
    R.domElement.removeEventListener('webglcontextlost', onContextLost);
    if (s.pt) { try { tracerDispose(s.pt); } catch (e) { console.warn('[foto] dispose', e); } s.pt = null; }
    if (s.filter) { try { s.filter.dispose(); } catch (e) { console.warn('[foto] dispose', e); } s.filter = null; s.filterTex = null; }
    for (const k of Object.keys(lumMats)) { lumMats[k].dispose(); delete lumMats[k]; }
    if (lumRT) { lumRT.dispose(); lumRT = null; }
    if (s.view) { s.view.tex.dispose(); s.view.geo.dispose(); s.view.mat.dispose(); s.view = null; }
    s.toneMat?.dispose(); s.quad = null; s.panoCanvas = null;
    s.ui?.root.remove();
    document.documentElement.classList.remove('phx-on');
    pauseHost(false);
    setToolsBusy(false);
    const back = toolEls[s.kind === 'pano' ? 'pano' : 'foto'];
    if (back && back.focus) back.focus({ preventScroll: true });
  }

  addTool({ id: 'foto', label: 'Foto', title: 'Fotorealistische foto van dit beeld (path tracing)', icon: ICON.foto, onClick: () => start('still') });
  addTool({ id: 'pano', label: '360°', title: '360°-panorama vanaf je plek (path tracing)', icon: ICON.pano, onClick: () => start('pano') });

  installed = {
    still: () => start('still'), pano: () => start('pano'), close, save,
    get state() { return S ? { kind: S.kind, phase: S.phase, samples: S.pt ? S.pt.samples : (S.stats.samples || 0), size: S.size, k: S.k, denoise: !!(S.denoise && S.filter), filteredAt: S.filteredAt || 0 } : null; },
    get stats() { return stats.last; },
    finish: () => finish(true),
    quality: Q, phone: PHONE, canSave: allowSave, importMap: IMPORT_MAP,
    _debug: { get session() { return S; }, exportCanvas: () => (S && S.pt ? exportCanvas() : null) }, // for tests only
  };
  H.photo = installed;
  return installed;
}

/* ---------------- self-boot ---------------- */
function boot(t0 = performance.now()) {
  const H = window.HOUSE;
  if (H && H.scene && H.renderer && H.camera) {
    if (H.THREE) { install(H); return; }
    import('three').then(T => install(H, T)).catch(e => console.warn('[foto] three.js niet gevonden', e));
    return;
  }
  if (performance.now() - t0 < 120000) setTimeout(() => boot(t0), 150);
}
if (typeof window !== 'undefined') boot();
