/* post.js: the real-time look of "Ons Huis" (three.js 0.170.0, import map only).
   Boots itself when window.HOUSE exists; `install(H)` is exported for explicit use.

   Hoog / Normaal: EffectComposer
     GTAO pre-pass (depth + normals, Poisson-denoised; half resolution on Normaal)
     → scene pass into a half-float target (MSAA x4 on Hoog), the AO goes into indirect light only
     → bloom on emissive / over-bright pixels (threshold follows the exposure)
     → finish pass: white balance, vignette, tone mapping, sRGB, dither (+ optional film grain)
     → SMAA on Normaal.
   Snel: no composer. Direct render with the same lighting model, exposure and white balance (in the material
   output) and the canvas' own MSAA.

   Lighting model, injected into every lit material (onBeforeCompile on Material.prototype):
   - Indoor surfaces get only a fraction of the open-sky light: a room is lit through its windows, not by the sky
     all around. A per-fragment world-position test against a small room map (room id per level + roof heights)
     decides indoor / outdoor.
   - Window light: RectAreaLights in the window openings of the room you stand in, as bright as the sky behind them.
   - Lamps light only their own room (point lights cast no shadows; without this they shine through walls).
   - Screen-space AO darkens indirect light and env reflections in corners and under furniture.
   XR: while renderer.xr.isPresenting everything passes straight to the plain renderer.render, all neutral.
   photo.js: while the host is paused (HOUSE.pauseRender) the window lights are switched off. A render of the main view
   while paused (compare.js capture) gets them back for that one frame and is exposed for its own pose. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const VERSION = 'post-1';
const QKEY = 'onshuis.post.kwaliteit';

/* ---------------- quality levels ---------------- */
const LEVELS = {
  hoog: { name: 'Hoog', composer: true, msaa: 4, ao: 1, aoSamples: 16, pdSamples: 16, rect: 4, bloom: 1, aa: 'msaa', dpr: 2, shadow: 2048 },
  normaal: { name: 'Normaal', composer: true, msaa: 0, ao: 0.5, aoSamples: 12, pdSamples: 8, rect: 2, bloom: 0.5, aa: 'smaa', dpr: 1.5, shadow: 2048 },
  snel: { name: 'Snel', composer: false, msaa: 0, ao: 0, aoSamples: 0, pdSamples: 0, rect: 1, bloom: 0, aa: 'native', dpr: 1.5, shadow: 1024 },
};
const ORDER = ['hoog', 'normaal', 'snel'];

/* ---------------- look (tuned against the test shots; all live-editable through HOUSE.post.cfg) ---------------- */
const CFG = {
  debug: 0,                                    // 1 = room map, 2 = AO (diagnostics)
  tm: 'neutral',                               // aces | agx | neutral (Khronos PBR Neutral keeps white walls white and wood its own colour)
  tmGain: { aces: 1.0, agx: 1.0, neutral: 1.0, linear: 1.0 },
  gainIn: 2.8, gainOut: 1.0, gainDoll: 1.08,   // exposure on top of the host's, by day
  gainLamp: 0.55,                              // indoors with only the lamps on; mixed light blends both (in exposure units)
  gainNightMax: 2.0, gainNightOut: 1.0,
  lampGlow: 4,                                 // lamp shades / bulbs: a real opal globe is far brighter than the wall it lights
  fill: 0.08, fillNear: 0.25,                  // lamp bounce light: share of a lamp's intensity that comes back from the room
  adapt: 0.45,                                 // seconds, eye adaptation in/out of the house
  kIn: 0.15, kSpecIn: 0.18, kInSnel: 0.22,      // share of the open-sky light that reaches indoor surfaces
  inTint: [1.12, 1.0, 0.84],                   // indoor bounce light is warmer than the blue open sky (white walls, wood floors)
  kDoll: 0.8,                                  // dollhouse: the rooms are open to the sky
  winT: 0.75,                                  // window transmission (glass + frame)
  ao: { strength: 1.0, direct: 0.35, nightDirect: 0.6 },
  gtao: { radius: 0.5, distanceExponent: 1.6, thickness: 1.0, distanceFallOff: 1.0, scale: 1.25, screenSpaceRadius: false },
  pd: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 2, rings: 2 },
  bloom: { strength: 0.16, radius: 0.55, threshold: 1.6, knee: 0.6 },
  vignette: 0.22, vignetteDoll: 0.12, grain: 0,
  wbNight: 0.45,                                // share of the lamp colour cast a camera would correct at night
  shadow: { texels: 1.6, bias: -0.00025 },
};

/* ---------------- shader patch ---------------- */
const GLSL_DECL = /* glsl */`
uniform sampler2D postAO;
uniform vec3 postWB;
uniform sampler2D postRoomMap;
uniform vec4 postMapXf;
uniform vec4 postP0;
uniform vec4 postP1;
uniform vec2 postInvRes;
uniform float postDbg;
uniform vec3 postTint;
uniform vec4 postP2;
uniform sampler2D postAODepth;
uniform vec4 postAOInfo;
float postLinZ( float d ) { return postAOInfo.z * postAOInfo.w / ( postAOInfo.w - d * ( postAOInfo.w - postAOInfo.z ) ); }
// AO lookup. A reduced-resolution AO buffer is upsampled depth-aware (bilinear weights times depth similarity),
// otherwise every silhouette (wall against ceiling, furniture against floor) gets a bright fringe.
float postAOFetch() {
	vec2 uv = gl_FragCoord.xy * postInvRes;
	if ( postAOInfo.x < 0.5 ) return texture2D( postAO, uv ).r;
	vec2 px = 1.0 / postAOInfo.xy, st = uv * postAOInfo.xy - 0.5, f = fract( st ), b = ( floor( st ) + 0.5 ) * px;
	float zf = postLinZ( gl_FragCoord.z ), s = 0.0, ws = 0.0;
	for ( int k = 0; k < 4; k ++ ) {
		vec2 o = vec2( mod( float( k ), 2.0 ), floor( float( k ) * 0.5 ) );
		vec2 q = b + o * px;
		float dz = ( postLinZ( texture2D( postAODepth, q ).r ) - zf ) / zf;
		float w = ( mix( 1.0 - f.x, f.x, o.x ) * mix( 1.0 - f.y, f.y, o.y ) + 1e-3 ) / ( 4e-4 + dz * dz );
		s += texture2D( postAO, q ).r * w; ws += w;
	}
	return s / ws;
}
uniform float postPLRoom[ 16 ];
uniform float postRectRoom[ 4 ];
float postCode;
float postInK;
float postInKs;
float postAOv;
bool postIn;
vec3 postTintV;
vec3 postFill;
vec3 postFillN;
float postLampMask( float r ) {
	if ( postP0.x < 0.5 || r < -0.5 ) return 1.0;
	if ( r < 0.5 ) return postIn ? 0.12 : 1.0;
	if ( ! postIn ) return 0.0;
	return ( abs( postCode - r ) < 0.5 || postCode > 252.5 || r > 252.5 ) ? 1.0 : 0.0;
}
float postRectMask( float r ) {
	if ( r < -0.5 ) return 1.0;
	if ( postP0.x < 0.5 || ! postIn ) return 0.0;
	return ( abs( postCode - r ) < 0.5 || postCode > 252.5 ) ? 1.0 : 0.0;
}
`;
// runs at the top of lights_fragment_begin, after geometryNormal / geometryViewDir exist
const GLSL_CLASSIFY = /* glsl */`
postCode = 0.0; postIn = false; postInK = 1.0; postInKs = 1.0; postAOv = 1.0; postTintV = vec3( 1.0 ); postFill = vec3( 0.0 ); postFillN = vec3( 0.0 );
if ( postP0.x > 0.5 ) {
	mat3 postVR = transpose( mat3( viewMatrix ) );
	vec3 postN = postVR * geometryNormal;
	// classify a point just in front of the surface, nudged towards the eye: slivers where wall boxes meet
	// (seams, wall / ceiling junctions) then read as the room you see them from instead of the wall zone
	vec3 postQ = postVR * ( geometryPosition - viewMatrix[ 3 ].xyz ) + postN * 0.06 + postVR * geometryViewDir * 0.07;
	vec4 postCell = texture2D( postRoomMap, ( postQ.xz - postMapXf.xy ) * postMapXf.zw );
	float postC = postQ.y < postP1.y ? postCell.r : ( postQ.y < postP1.z ? postCell.g : postCell.b );
	postCode = floor( postC * 255.0 + 0.5 );
	postIn = postCode > 0.5 && postQ.y < postCell.a * 16.0 - postP1.w;
	if ( postIn ) {
		bool postZone = postCode > 252.5 && postCode < 253.5;
		postInK = postZone ? mix( postP0.y, 1.0, 0.5 ) : postP0.y;
		postInKs = postZone ? mix( postP0.z, 1.0, 0.5 ) : postP0.z;
		postTintV = postZone ? mix( postTint, vec3( 1.0 ), 0.5 ) : postTint;
	}
	#if defined( OPAQUE ) && ! defined( USE_ALPHATEST ) && ! defined( USE_ALPHAHASH )
	if ( postP0.w > 0.0 ) postAOv = mix( 1.0, postAOFetch(), postP0.w );
	#endif
}
`;
const GLSL_PL = /* glsl */`
		#if UNROLLED_LOOP_INDEX < 16
		{
			float postM = postLampMask( postPLRoom[ i ] );
			if ( postIn && postPLRoom[ i ] > 0.5 && postM > 0.5 ) {
				if ( postCode < 252.5 ) postFill += pointLight.color; else postFillN += directLight.color;
			}
			directLight.color *= postM * mix( 1.0, postAOv, postP1.x );
		}
		#endif`;
const GLSL_RECT = /* glsl */`
		#if UNROLLED_LOOP_INDEX < 4
		rectAreaLight.color *= postRectMask( postRectRoom[ i ] ) * mix( 1.0, postAOv, postP1.x );
		#endif`;
// after aomap_fragment: AO + indoor share on indirect light only (emissive and direct sun stay untouched)
const GLSL_APPLY = /* glsl */`
if ( postP0.x > 0.5 ) {
	reflectedLight.indirectDiffuse *= postInK * postAOv * postTintV;
	float postNV = saturate( dot( geometryNormal, geometryViewDir ) );
	#ifdef STANDARD
	float postR = material.roughness;
	#else
	float postR = 0.5;
	#endif
	float postSO = saturate( pow( postNV + postAOv, exp2( - 16.0 * postR - 1.0 ) ) - 1.0 + postAOv );
	reflectedLight.indirectSpecular *= postInKs * postSO * postTintV;
	#ifdef USE_CLEARCOAT
	clearcoatSpecularIndirect *= postInKs * postSO;
	#endif
	#ifdef USE_SHEEN
	sheenSpecularIndirect *= postInKs * postAOv;
	#endif
	reflectedLight.indirectDiffuse += ( postFill * postP2.x + postFillN * postP2.y ) * BRDF_Lambert( material.diffuseColor ) * postAOv;
	totalEmissiveRadiance *= postP2.z;
	if ( postDbg > 0.5 ) { // diagnostics: 1 = room map (black outdoor, yellow wall zone, blue stairs, grey above the roof), 2 = AO
		vec3 postDc = postCode < 0.5 ? vec3( 0.0 ) : postCode > 253.5 ? vec3( 0.1, 0.3, 1.0 ) : postCode > 252.5 ? vec3( 1.0, 0.85, 0.1 ) :
			0.25 + 0.75 * fract( sin( postCode * vec3( 12.9898, 78.233, 37.719 ) ) * 43758.5453 );
		if ( postCode > 0.5 && ! postIn ) postDc = vec3( 0.35 );
		if ( postDbg > 1.5 ) postDc = vec3( postAOv );
		reflectedLight.directDiffuse = vec3( 0.0 ); reflectedLight.directSpecular = vec3( 0.0 ); reflectedLight.indirectSpecular = vec3( 0.0 );
		reflectedLight.indirectDiffuse = postDc * 0.25;
	}
}
`;
let LFB = null; // patched lights_fragment_begin (null = this three build is not what we expect: no patch)
function patchedLightsChunk() {
  if (LFB !== null) return LFB;
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const A = 'vec3 geometryClearcoatNormal = vec3( 0.0 );', B = 'getPointLightInfo( pointLight, geometryPosition, directLight );', C = 'rectAreaLight = rectAreaLights[ i ];';
  if (!src.includes(A) || !src.includes(B) || !src.includes(C)) { console.warn('[post] unexpected lights_fragment_begin, lighting patch off'); return (LFB = ''); }
  return (LFB = src.replace(A, GLSL_CLASSIFY + A).replace(B, B + GLSL_PL).replace(C, C + GLSL_RECT));
}

/* ---------------- finish pass: white balance, vignette, tone mapping, sRGB, dither, grain ---------------- */
const TM_DEFINE = {
  [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING', [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING', [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
  [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING', [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING', [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
};
const TM_BY_NAME = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, linear: THREE.LinearToneMapping };
const TM_NAME = Object.fromEntries(Object.entries(TM_BY_NAME).map(([k, v]) => [v, k]));
class FinishPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null }, toneMappingExposure: { value: 1 }, uWB: { value: new THREE.Vector3(1, 1, 1) },
      uVig: { value: 0.2 }, uAspect: { value: new THREE.Vector2(1, 1) }, uGrain: { value: 0 }, uSeed: { value: 0 },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'PostFinish', uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: /* glsl */`
        precision highp float;
        uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
        attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse; uniform vec3 uWB; uniform float uVig; uniform vec2 uAspect; uniform float uGrain; uniform float uSeed;
        varying vec2 vUv;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        float hash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
        void main() {
          vec4 c = texture2D( tDiffuse, vUv );
          c.rgb *= uWB;
          vec2 d = ( vUv - 0.5 ) * uAspect;
          c.rgb *= 1.0 - uVig * smoothstep( 0.08, 0.62, dot( d, d ) );
          #if defined( LINEAR_TONE_MAPPING )
            c.rgb = LinearToneMapping( c.rgb );
          #elif defined( REINHARD_TONE_MAPPING )
            c.rgb = ReinhardToneMapping( c.rgb );
          #elif defined( CINEON_TONE_MAPPING )
            c.rgb = CineonToneMapping( c.rgb );
          #elif defined( ACES_FILMIC_TONE_MAPPING )
            c.rgb = ACESFilmicToneMapping( c.rgb );
          #elif defined( AGX_TONE_MAPPING )
            c.rgb = AgXToneMapping( c.rgb );
          #elif defined( NEUTRAL_TONE_MAPPING )
            c.rgb = NeutralToneMapping( c.rgb );
          #endif
          #ifdef SRGB_TRANSFER
            c = sRGBTransferOETF( c );
          #endif
          if ( uGrain > 0.0 ) {
            float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
            float g = hash12( gl_FragCoord.xy + uSeed * 61.7 ) + hash12( gl_FragCoord.xy * 1.37 + uSeed * 17.3 ) - 1.0;
            c.rgb += uGrain * g * ( 0.25 + 0.75 * ( 1.0 - l ) ) * 0.06;
          }
          c.rgb += ( hash12( gl_FragCoord.xy ) + hash12( gl_FragCoord.xy + 19.19 ) - 1.0 ) / 255.0;
          gl_FragColor = vec4( c.rgb, 1.0 );
        }`,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._sig = '';
  }
  render(renderer, writeBuffer, readBuffer) {
    const tm = renderer.toneMapping, srgb = THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer, sig = tm + '|' + srgb;
    if (sig !== this._sig) {
      this._sig = sig; const d = {}; if (TM_DEFINE[tm]) d[TM_DEFINE[tm]] = ''; if (srgb) d.SRGB_TRANSFER = '';
      this.material.defines = d; this.material.needsUpdate = true;
    }
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

/* GTAO as a pre-pass: no output of its own, optional reduced resolution, glass / foliage / helpers left out of the
   G-buffer, no second shadow-map render and no sky drawn into the normal buffer. */
class AOPrePass extends GTAOPass {
  constructor(scene, camera, hidden) {
    super(scene, camera, 16, 16);
    this.output = GTAOPass.OUTPUT.Off; this.needsSwap = false; this.resScale = 1; this._hiddenList = hidden; this._hid = [];
  }
  setSize(w, h) { super.setSize(Math.max(1, Math.round(w * this.resScale)), Math.max(1, Math.round(h * this.resScale))); }
  overrideVisibility() { this._hid.length = 0; for (const o of this._hiddenList()) if (o.visible) { o.visible = false; this._hid.push(o); } }
  restoreVisibility() { for (const o of this._hid) o.visible = true; this._hid.length = 0; }
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    const sc = this.scene, bg = sc.background, au = renderer.shadowMap.autoUpdate;
    sc.background = null; renderer.shadowMap.autoUpdate = false;
    try { super.render(renderer, writeBuffer, readBuffer, dt, mask); } finally { sc.background = bg; renderer.shadowMap.autoUpdate = au; }
  }
}
class ScaledBloomPass extends UnrealBloomPass {
  constructor() { super(new THREE.Vector2(16, 16), CFG.bloom.strength, CFG.bloom.radius, CFG.bloom.threshold); this.resScale = 1; }
  setSize(w, h) { super.setSize(Math.max(2, Math.round(w * this.resScale)), Math.max(2, Math.round(h * this.resScale))); }
}

/* ---------------- helpers ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};
function gpuName(R) {
  try { const gl = R.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) { return ''; }
}
// device guess: phones, tablets and headsets Snel (same test as the host's LOWQ), integrated GPUs Normaal, a real desktop GPU Hoog
function autoLevel(R) {
  const ua = navigator.userAgent || '', g = gpuName(R);
  if (/OculusBrowser|Quest|Pico|Wolvic/i.test(ua)) return 'snel';
  if (/SwiftShader|llvmpipe|Software|Basic Render/i.test(g)) return 'snel';
  // the host's own LOWQ test (touch screen or a narrow window) plus mobile user agents: these get the cheap path
  const coarse = matchMedia('(pointer: coarse)').matches, narrow = innerWidth <= 760;
  if (coarse || narrow || /Mobile|Android|iPad|iPhone/i.test(ua)) return 'snel';
  if (/NVIDIA|GeForce|RTX|Quadro|Radeon|AMD|Apple M\d|Apple GPU/i.test(g) && !/Radeon\(TM\) Graphics|Vega \d Graphics/i.test(g)) return 'hoog';
  return 'normaal';
}

/* ---------------- install ---------------- */
export function install(H) {
  if (!H || !H.renderer || !H.scene || !H.camera) throw new Error('post.js: window.HOUSE is incomplete');
  if (H.post && H.post.version === VERSION) return H.post;
  const R = H.renderer, scene = H.scene, camera = H.camera, D = H.data || {};
  const qs = new URLSearchParams(location.search);
  if (qs.get('post') === '0') return null;
  if (qs.get('tm') && TM_BY_NAME[qs.get('tm')]) CFG.tm = qs.get('tm');
  if (qs.get('grain')) CFG.grain = +qs.get('grain') || 0;
  const LVL = D.LV || [{ floor: 0 }, { floor: 2.76 }, { floor: 5.39 }];
  const lvlY = [LVL[1] ? LVL[1].floor - 0.1 : 99, LVL[2] ? LVL[2].floor - 0.1 : 99];
  const levelOfY = y => (y < lvlY[0] ? 0 : y < lvlY[1] ? 1 : 2);
  const origRender = R.render; // may itself be a wrapper from another module; we always call through it
  const plain = (s, c) => origRender.call(R, s, c);

  /* ---- room map: room code per level (1..N rooms, 253 wall zone, 254 stairs), roof top in alpha ---- */
  const ROOMS = D.ROOMS || [];
  const MAP = (() => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of ROOMS) for (const q of r.rects) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[3]); }
    if (!isFinite(x0)) { x0 = -1; x1 = 1; z0 = -1; z1 = 1; }
    const C = 0.05, PAD = 1.2; x0 -= PAD; z0 -= PAD; x1 += PAD; z1 += PAD;
    const NX = Math.ceil((x1 - x0) / C), NZ = Math.ceil((z1 - z0) / C), N = NX * NZ;
    const L = [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)];
    const fill = (g, q, code, over) => {
      const i0 = clamp(Math.round((q[0] - x0) / C), 0, NX), i1 = clamp(Math.round((q[1] - x0) / C), 0, NX);
      const j0 = clamp(Math.round((q[2] - z0) / C), 0, NZ), j1 = clamp(Math.round((q[3] - z0) / C), 0, NZ);
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const k = j * NX + i; if (over || !g[k]) g[k] = code; }
    };
    ROOMS.forEach((r, k) => { if (L[r.lvl]) for (const q of r.rects) fill(L[r.lvl], q, Math.min(250, k + 1), false); });
    for (const f of D.FLIGHTS || []) { const q = [f.x0, f.x1, f.zMin, f.zMax]; if (L[f.l]) fill(L[f.l], q, 254, true); if (L[f.l + 1]) fill(L[f.l + 1], q, 254, true); }
    // close the gaps that interior walls leave between rooms (<= 0.25 m), twice so wall junctions fill too
    const K = 5;
    for (let pass = 0; pass < 2; pass++) for (const g of L) {
      const s = g.slice();
      for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
        const k = j * NX + i; if (s[k]) continue;
        let best = 0, bd = 99;
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          let a = 0, da = 0, b = 0, db = 0;
          for (let t = 1; t <= K; t++) { const ii = i - di * t, jj = j - dj * t; if (ii < 0 || jj < 0) break; const v = s[jj * NX + ii]; if (v) { a = v; da = t; break; } }
          for (let t = 1; t <= K; t++) { const ii = i + di * t, jj = j + dj * t; if (ii >= NX || jj >= NZ) break; const v = s[jj * NX + ii]; if (v) { b = v; db = t; break; } }
          if (a && b && da + db <= K + 1) { const d = Math.min(da, db); if (d < bd) { bd = d; best = da <= db ? a : b; } }
        }
        if (best) g[k] = best;
      }
    }
    // wall zone: 0.2 m around the indoor area (window reveals and sills, the thickness of the outer walls)
    const Z = 4;
    for (const g of L) {
      const row = new Uint8Array(N);
      for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { let any = 0; for (let t = -Z; t <= Z && !any; t++) { const ii = i + t; if (ii >= 0 && ii < NX && g[j * NX + ii] && g[j * NX + ii] !== 253) any = 1; } row[j * NX + i] = any; }
      for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
        const k = j * NX + i; if (g[k]) continue;
        for (let t = -Z; t <= Z; t++) { const jj = j + t; if (jj >= 0 && jj < NZ && row[jj * NX + i]) { g[k] = 253; break; } }
      }
    }
    const data = new Uint8Array(N * 4);
    for (let k = 0; k < N; k++) { data[k * 4] = L[0][k]; data[k * 4 + 1] = L[1][k]; data[k * 4 + 2] = L[2][k]; data[k * 4 + 3] = 255; }
    const tex = new THREE.DataTexture(data, NX, NZ, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false; tex.needsUpdate = true;
    tex.colorSpace = THREE.NoColorSpace;
    const cell = (x, z) => { const i = Math.floor((x - x0) / C), j = Math.floor((z - z0) / C); return i < 0 || j < 0 || i >= NX || j >= NZ ? -1 : j * NX + i; };
    return {
      x0, z0, x1, z1, NX, NZ, C, L, data, tex, cell,
      code(x, y, z) { const k = cell(x, z); return k < 0 ? 0 : L[levelOfY(y)][k]; },
      roof(x, z) { const k = cell(x, z); return k < 0 ? 16 : data[k * 4 + 3] / 255 * 16; },
      inside(x, y, z) { const k = cell(x, z); if (k < 0) return false; const c = L[levelOfY(y)][k]; return c > 0 && y < data[k * 4 + 3] / 255 * 16 - 0.15; },
    };
  })();

  // roof heights: one top-down orthographic render of the 'ceil' groups (ceilings, slabs, roofs), read back once
  function bakeRoofs() {
    const ceils = [];
    for (const n of ['L0', 'L1', 'L2']) {
      const g = scene.children.find(c => c.name === n); if (!g) continue;
      const c = scene.children[scene.children.indexOf(g) + 1]; if (c && c.isGroup && !c.name) ceils.push(c);
    }
    if (!ceils.length) return false;
    const { NX, NZ, C, x0, z0 } = MAP, W = NX * C, Dd = NZ * C, cx = x0 + W / 2, cz = z0 + Dd / 2;
    const rt = new THREE.WebGLRenderTarget(NX, NZ, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    const cam = new THREE.OrthographicCamera(-W / 2, W / 2, Dd / 2, -Dd / 2, 0.5, 80);
    cam.position.set(cx, 40, cz); cam.up.set(0, 0, -1); cam.lookAt(cx, 0, cz); cam.updateMatrixWorld(true);
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: `varying float vY; void main() { vec4 p = vec4( position, 1.0 );
        #ifdef USE_INSTANCING
        p = instanceMatrix * p;
        #endif
        p = modelMatrix * p; vY = p.y; gl_Position = projectionMatrix * viewMatrix * p; }`,
      fragmentShader: `varying float vY; void main() { float h = clamp( vY / 16.0, 0.0, 1.0 ) * 255.0; gl_FragColor = vec4( floor( h ) / 255.0, fract( h ), 0.0, 1.0 ); }`,
    });
    const vis = scene.children.map(c => c.visible), cv = ceils.map(c => c.visible), bg = scene.background, ov = scene.overrideMaterial, au = R.shadowMap.autoUpdate;
    const prevRT = R.getRenderTarget(), cc = R.getClearColor(new THREE.Color()), ca = R.getClearAlpha(), xr = R.xr.enabled;
    const buf = new Uint8Array(NX * NZ * 4);
    try {
      scene.children.forEach(c => { c.visible = ceils.includes(c); });
      scene.background = null; scene.overrideMaterial = mat; R.shadowMap.autoUpdate = false; R.xr.enabled = false;
      R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear(); plain(scene, cam);
      R.readRenderTargetPixels(rt, 0, 0, NX, NZ, buf);
    } finally {
      scene.children.forEach((c, i) => { c.visible = vis[i]; }); ceils.forEach((c, i) => { c.visible = cv[i]; });
      scene.background = bg; scene.overrideMaterial = ov; R.shadowMap.autoUpdate = au; R.xr.enabled = xr;
      R.setRenderTarget(prevRT); R.setClearColor(cc, ca); rt.dispose(); mat.dispose();
    }
    let n = 0;
    for (let r = 0; r < NZ; r++) {
      const j = NZ - 1 - r; // GL row 0 is the bottom of the image = largest z
      for (let i = 0; i < NX; i++) {
        const p = (r * NX + i) * 4, a = buf[p + 3];
        if (!a) continue; // nothing overhead: keep 255 (no roof limit)
        const y = (buf[p] + buf[p + 1] / 255) / 255 * 16;
        MAP.data[(j * NX + i) * 4 + 3] = clamp(Math.round(y / 16 * 255), 1, 254); n++;
      }
    }
    MAP.tex.needsUpdate = true;
    return n > 0;
  }
  let roofOK = false;
  try { roofOK = bakeRoofs(); } catch (e) { console.warn('[post] roof bake failed', e); }

  /* ---- shared uniforms ---- */
  const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); WHITE.needsUpdate = true;
  const U = {
    postAO: { value: WHITE },
    postWB: { value: new THREE.Vector3(1, 1, 1) }, // white balance on Snel (no finish pass there); 1 otherwise
    postRoomMap: { value: MAP.tex },
    postMapXf: { value: new THREE.Vector4(MAP.x0, MAP.z0, 1 / (MAP.NX * MAP.C), 1 / (MAP.NZ * MAP.C)) },
    postP0: { value: new THREE.Vector4(0, 1, 1, 0) }, // on, indoor diffuse share, indoor specular share, AO strength
    postP1: { value: new THREE.Vector4(0, lvlY[0], lvlY[1], 0.15) }, // AO on lamp / window light, level 1 y, level 2 y, roof margin
    postInvRes: { value: new THREE.Vector2(1, 1) },
    postDbg: { value: 0 },
    postAODepth: { value: WHITE },
    postAOInfo: { value: new THREE.Vector4(0, 0, 0.05, 400) }, // AO buffer size (0 = full resolution), camera near / far
    postP2: { value: new THREE.Vector4(0, 0, 1, 0) }, // lamp bounce: per lamp of the room, near lamps for stairs / reveals
    postTint: { value: new THREE.Vector3(1, 1, 1) }, // colour of indoor bounce light relative to the open sky
    postPLRoom: { value: new Float32Array(16).fill(-1) },
    postRectRoom: { value: new Float32Array(4).fill(-1) },
  };
  const setActive = on => { U.postP0.value.x = on ? 1 : 0; if (!on) { U.postWB.value.set(1, 1, 1); U.postAO.value = WHITE; U.postAODepth.value = WHITE; U.postAOInfo.value.x = 0; } };

  /* ---- material patch ---- */
  function patchShader(shader) {
    const fs = shader.fragmentShader;
    if (!fs.includes('#include <lights_fragment_begin>') || !fs.includes('#include <aomap_fragment>') || !fs.includes('#include <common>')) return;
    const lfb = patchedLightsChunk(); if (!lfb) return;
    shader.fragmentShader = fs.replace('#include <common>', '#include <common>\n' + GLSL_DECL)
      .replace('#include <lights_fragment_begin>', lfb)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + GLSL_APPLY)
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb *= postWB;\n#include <tonemapping_fragment>');
    Object.assign(shader.uniforms, U);
  }
  const protoOBC = THREE.Material.prototype.onBeforeCompile, protoKey = THREE.Material.prototype.customProgramCacheKey;
  THREE.Material.prototype.onBeforeCompile = function postOnBeforeCompile(shader, renderer) { patchShader(shader, this, renderer); };
  THREE.Material.prototype.customProgramCacheKey = function () { return this.onBeforeCompile === THREE.Material.prototype.onBeforeCompile ? VERSION : this.onBeforeCompile.toString(); };
  // materials that bring their own onBeforeCompile get ours chained after theirs (with a cache key of their own)
  const seenMats = new WeakSet();
  function adoptMaterial(m) {
    if (!m || seenMats.has(m)) return; seenMats.add(m);
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') && !m.__post) {
      const inner = m.onBeforeCompile, ownKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') ? m.customProgramCacheKey : null, k = inner.toString();
      m.onBeforeCompile = function (s, r) { inner.call(this, s, r); patchShader(s, this, r); };
      m.customProgramCacheKey = function () { return (ownKey ? ownKey.call(this) : k) + '|' + VERSION; };
      m.__post = true;
    }
    m.needsUpdate = true;
  }
  const hiddenForAO = [];
  let lastScan = -1e9;
  function scanScene(force) {
    const now = performance.now(); if (!force && now - lastScan < 2000) return; lastScan = now;
    hiddenForAO.length = 0;
    scene.traverse(o => {
      if (o.isPoints || o.isLine || o.isSprite) { hiddenForAO.push(o); return; }
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      let hide = !!o.userData.helper;
      for (const m of ms) { if (!m) continue; adoptMaterial(m); if (m.transparent || m.alphaTest > 0 || m.alphaMap || m.transmission > 0) hide = true; }
      if (hide) hiddenForAO.push(o);
    });
  }
  scanScene(true);

  /* ---- window light ---- */
  RectAreaLightUniformsLib.init();
  const WINDOWS = [];
  (function findWindows() {
    const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
    for (const w of D.WALLS || []) {
      const [l, axis, , , c0, c1, ops] = w; if (!ops || !LVL[l]) continue;
      const fl = LVL[l].floor;
      for (const op of ops) {
        const [a, b, type, sill = 0, head = 2.2] = op;
        if (type !== 'w' && type !== 'g') continue;
        const s = (a + b) / 2, y = fl + (sill + head) / 2;
        const P = (along, c) => (axis === 'x' ? V3(along, y, c) : V3(c, y, along));
        const lo = P(s, Math.min(c0, c1) - 0.3), hi = P(s, Math.max(c0, c1) + 0.3);
        const cLo = MAP.code(lo.x, y, lo.z), cHi = MAP.code(hi.x, y, hi.z);
        const roomLo = cLo > 0 && cLo < 253, roomHi = cHi > 0 && cHi < 253;
        if (roomLo === roomHi) continue; // interior opening, or nothing on either side
        const inPlus = roomHi, code = inPlus ? cHi : cLo;
        const nIn = axis === 'x' ? V3(0, 0, inPlus ? 1 : -1) : V3(inPlus ? 1 : -1, 0, 0);
        const face = inPlus ? Math.max(c0, c1) + 0.01 : Math.min(c0, c1) - 0.01;
        WINDOWS.push({ code, lvl: l, center: P(s, face), nIn, along: axis === 'x' ? V3(1, 0, 0) : V3(0, 0, 1), w: (b - a) * 0.92, h: (head - sill) * 0.92, T: CFG.winT, E: null });
      }
    }
    // openings that are not in WALLS: the light well of the skylight in the woonkamer, the roof window of slaapkamer 3
    const extra = [
      { room: 'woonkamer', center: V3(5.08, 2.5, 2.55), nIn: V3(0, -1, 0), along: V3(1, 0, 0), w: 1.3, h: 1.3, T: 0.5 },
      { room: 'sk3', center: V3(4.885, 7.6, 9.72), nIn: V3(0, -0.743, -0.669), along: V3(1, 0, 0), w: 0.85, h: 1.38, T: 0.7 },
    ];
    for (const e of extra) {
      const idx = ROOMS.findIndex(r => r.id === e.room); if (idx < 0) continue;
      const code = idx + 1, p = e.center.clone().addScaledVector(e.nIn, 0.3);
      if (MAP.code(p.x, p.y, p.z) !== code) continue; // the house changed: skip rather than guess
      WINDOWS.push({ code, lvl: ROOMS[idx].lvl, center: e.center, nIn: e.nIn.clone().normalize(), along: e.along, w: e.w, h: e.h, T: e.T, E: null });
    }
    for (const w of WINDOWS) w.area = w.w * w.h;
  })();
  // sky irradiance through each window, from the HDR sky with the same lower-hemisphere blend the host uses for its probe
  let skySrc = null, skyS = null;
  function skySamples(tex) {
    const img = tex.image; if (!img || !img.data || !img.width) return null;
    const { data, width: w, height: h } = img, n = Math.round(data.length / (w * h)); if (n < 3) return null;
    const rowSum = (y0, y1) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * n; s += data[i] + data[i + 1] + data[i + 2]; } return s; };
    const topIsSky = rowSum(0, h >> 2) > rowSum(h - (h >> 2), h);
    const sky = [0, 0, 0]; let c = 0;
    for (let y = topIsSky ? 0 : h - (h >> 2); y < (topIsSky ? h >> 2 : h); y += 2) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * n; sky[0] += data[i]; sky[1] += data[i + 1]; sky[2] += data[i + 2]; c++; }
    const bounce = sky.map(v => v / Math.max(1, c) * 0.45), meanSky = (sky[0] + sky[1] + sky[2]) / 3 / Math.max(1, c), cap = meanSky * 6;
    const S = 4, out = [];
    for (let y = 0; y < h; y += S) {
      const v = topIsSky ? 1 - (y + 0.5) / h : (y + 0.5) / h, el = (v - 0.5) * Math.PI, ce = Math.cos(el), se = Math.sin(el), k = clamp((0.56 - v) / 0.1, 0, 1);
      const dw = ce * (2 * Math.PI / w * S) * (Math.PI / h * S);
      for (let x = 0; x < w; x += S) {
        const i = (y * w + x) * n, phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
        const L = [0, 1, 2].map(ch => { const d0 = data[i + ch]; return Math.min(cap, d0 + (bounce[ch] - d0) * k); });
        out.push(Math.cos(phi) * ce, se, Math.sin(phi) * ce, L[0] * dw, L[1] * dw, L[2] * dw);
      }
    }
    return new Float32Array(out);
  }
  function irradiance(nOut) {
    if (!skyS) return [Math.PI * 0.55, Math.PI * 0.58, Math.PI * 0.62].map(v => v * 0.5); // before the HDR arrives
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < skyS.length; i += 6) { const c = skyS[i] * nOut.x + skyS[i + 1] * nOut.y + skyS[i + 2] * nOut.z; if (c > 0) { r += skyS[i + 3] * c; g += skyS[i + 4] * c; b += skyS[i + 5] * c; } }
    return [r, g, b];
  }
  function refreshSky() {
    const bg = scene.background;
    if (!bg || !bg.isDataTexture || bg === skySrc) return;
    skySrc = bg; skyS = skySamples(bg);
    for (const w of WINDOWS) w.E = null;
  }
  const rectPool = [], rectOn = []; // rectOn: lights currently in the scene
  const _m4 = new THREE.Matrix4(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  function setRectCount(n) {
    while (rectPool.length < n) {
      const L = new THREE.RectAreaLight(0xffffff, 0, 1, 1); L.name = 'post:window'; L.userData.post = true; L.userData.helper = true;
      L.matrixAutoUpdate = true; rectPool.push(L);
    }
    for (let i = 0; i < rectPool.length; i++) {
      const L = rectPool[i], want = i < n;
      if (want && !L.parent) scene.add(L); else if (!want && L.parent) L.parent.remove(L);
    }
    rectOn.length = 0; for (let i = 0; i < n; i++) rectOn.push(rectPool[i]);
    winSig = '';
  }
  let winSig = '';
  function placeWindows(camPos, code, lvl, enabled, envI) {
    const n = rectOn.length; if (!n) return;
    let pick = [];
    if (enabled) {
      const cand = WINDOWS.filter(w => w.lvl === lvl);
      cand.sort((a, b) => ((a.code === code ? -100 + -a.area : 0) + a.center.distanceTo(camPos)) - ((b.code === code ? -100 + -b.area : 0) + b.center.distanceTo(camPos)));
      pick = cand.slice(0, n);
    }
    const sig = pick.map(w => WINDOWS.indexOf(w)).join(',');
    if (sig !== winSig) {
      winSig = sig;
      rectOn.forEach((L, i) => {
        const w = pick[i];
        if (!w) { L.userData.room = -1; L.userData.win = null; return; }
        L.position.copy(w.center); L.width = w.w; L.height = w.h;
        _z.copy(w.nIn).negate(); _y.crossVectors(_z, w.along);
        _m4.makeBasis(w.along, _y, _z); L.quaternion.setFromRotationMatrix(_m4);
        L.userData.room = w.code; L.userData.win = w;
      });
    }
    for (const L of rectOn) {
      const w = L.userData.win;
      if (!w || !enabled) { L.intensity = 0; continue; }
      if (!w.E) { const nOut = w.nIn.clone().negate(), E = irradiance(nOut); w.E = E; }
      const [r, g, b] = w.E, lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum <= 0) { L.intensity = 0; continue; }
      L.color.setRGB(r / lum, g / lum, b / lum, THREE.LinearSRGBColorSpace);
      L.intensity = lum / Math.PI * w.T * envI;
    }
  }

  /* ---- light order as three's WebGLLights sees it, to feed the per-light room masks ---- */
  const lampRoom = new WeakMap(); const _wp = new THREE.Vector3();
  let orderTick = 0;
  function updateLightMasks() {
    const lights = [];
    scene.traverseVisible(o => { if (o.isLight && o.layers.test(camera.layers)) lights.push(o); });
    lights.sort((a, b) => (b.castShadow ? 2 : 0) - (a.castShadow ? 2 : 0) + (b.map ? 1 : 0) - (a.map ? 1 : 0));
    const pl = U.postPLRoom.value, rr = U.postRectRoom.value; pl.fill(-1); rr.fill(-1);
    let ip = 0, ir = 0;
    for (const L of lights) {
      if (L.isPointLight) {
        if (ip < 16) {
          L.getWorldPosition(_wp);
          let e = lampRoom.get(L);
          if (!e || !e.p.equals(_wp)) {
            const k = MAP.cell(_wp.x, _wp.z), c = MAP.code(_wp.x, _wp.y, _wp.z);
            e = { p: _wp.clone(), code: k < 0 ? 0 : c === 0 ? 0 : c === 253 ? -1 : c };
            lampRoom.set(L, e);
          }
          pl[ip] = e.code;
        }
        ip++;
      } else if (L.isRectAreaLight) {
        if (ir < 4) rr[ir] = L.userData.post ? (L.userData.room ?? -1) : -1;
        if (L.userData.post && rr[ir] < 0 && ir < 4) rr[ir] = 0; // unused window light: lights nothing
        ir++;
      }
    }
  }

  /* ---- sun shadow: fit the orthographic shadow camera to what matters, small normal bias ---- */
  const sun = (() => { let s = null; scene.traverse(o => { if (!s && o.isDirectionalLight && o.castShadow) s = o; }); return s; })();
  const hostShadow = sun ? { bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, map: sun.shadow.mapSize.x,
    l: sun.shadow.camera.left, r: sun.shadow.camera.right, t: sun.shadow.camera.top, b: sun.shadow.camera.bottom, n: sun.shadow.camera.near, f: sun.shadow.camera.far } : null;
  const HOUSE_BOX = new THREE.Box3(new THREE.Vector3(MAP.x0 + 0.6, 0, MAP.z0 + 0.6), new THREE.Vector3(MAP.x1 - 0.6, 10.2, MAP.z1 - 0.6));
  let shadowSig = '';
  const _sc = new THREE.OrthographicCamera(), _pts = Array.from({ length: 8 }, () => new THREE.Vector3()), _box = new THREE.Box3();
  function fitShadow(mode, camPos, outdoors) {
    if (!sun || !sun.visible) return;
    const s = sun.shadow, ms = s.mapSize.x;
    const around = mode === 'walk' && outdoors;
    const key = [sun.position.x.toFixed(2), sun.position.y.toFixed(2), sun.position.z.toFixed(2), sun.target.position.x.toFixed(2), mode, around ? Math.round(camPos.x / 4) + ':' + Math.round(camPos.z / 4) : '', ms].join('|');
    if (key === shadowSig) return; shadowSig = key;
    _box.copy(HOUSE_BOX);
    if (mode === 'doll') _box.expandByVector(new THREE.Vector3(3, 0, 3));
    if (around) _box.union(new THREE.Box3(new THREE.Vector3(camPos.x - 14, 0, camPos.z - 14), new THREE.Vector3(camPos.x + 14, 8, camPos.z + 14)));
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    _sc.position.setFromMatrixPosition(sun.matrixWorld); _sc.lookAt(_wp.setFromMatrixPosition(sun.target.matrixWorld)); _sc.updateMatrixWorld(true);
    const inv = _sc.matrixWorldInverse;
    const { min, max } = _box; let k = 0;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) _pts[k++].set(x, y, z).applyMatrix4(inv);
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, zn = Infinity, zf = -Infinity;
    for (const p of _pts) { l = Math.min(l, p.x); r = Math.max(r, p.x); b = Math.min(b, p.y); t = Math.max(t, p.y); zn = Math.min(zn, -p.z); zf = Math.max(zf, -p.z); }
    const pad = 0.3, c = s.camera;
    c.left = l - pad; c.right = r + pad; c.bottom = b - pad; c.top = t + pad; c.near = Math.max(0.5, zn - 2); c.far = zf + 2;
    c.updateProjectionMatrix();
    const texel = Math.max(c.right - c.left, c.top - c.bottom) / ms;
    s.normalBias = texel * CFG.shadow.texels;
    s.bias = CFG.shadow.bias * 40 / Math.max(10, c.far - c.near);
  }
  function setShadowSize(n) {
    if (!sun || R.xr.isPresenting) return;
    const s = sun.shadow; if (s.mapSize.x === n) return;
    s.mapSize.set(n, n); if (s.map) { s.map.dispose(); s.map = null; } shadowSig = '';
  }

  /* ---- composer ---- */
  let composer = null, rp = null, ao = null, bloom = null, fin = null, smaa = null, fxaa = null, curSamples = -1;
  function buildComposer(lv) {
    const samples = lv.msaa && R.capabilities.maxSamples >= lv.msaa ? lv.msaa : 0;
    if (!composer) {
      const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples });
      composer = new EffectComposer(R, rt); composer.setPixelRatio(1);
      rp = new RenderPass(scene, camera);
      ao = new AOPrePass(scene, camera, () => hiddenForAO);
      bloom = new ScaledBloomPass();
      fin = new FinishPass();
      smaa = new SMAAPass(16, 16);
      fxaa = new ShaderPass(FXAAShader);
      for (const p of [ao, rp, bloom, fin, smaa, fxaa]) composer.addPass(p);
      curSamples = samples;
    } else if (samples !== curSamples) {
      composer.reset(new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples })); curSamples = samples;
    }
    ao.enabled = lv.ao > 0; ao.resScale = lv.ao || 1;
    if (lv.ao > 0) { ao.updateGtaoMaterial({ ...CFG.gtao, samples: lv.aoSamples }); ao.updatePdMaterial({ ...CFG.pd, samples: lv.pdSamples }); }
    bloom.enabled = lv.bloom > 0; bloom.resScale = lv.bloom || 1;
    const msaaOK = lv.aa === 'msaa' && samples > 0;
    smaa.enabled = lv.aa === 'smaa'; fxaa.enabled = lv.aa === 'msaa' && !msaaOK;
    sizeSig = '';
  }
  let sizeSig = '';
  const _db = new THREE.Vector2();
  function syncSize() {
    R.getDrawingBufferSize(_db);
    const w = Math.max(1, Math.round(_db.x * st.scale)), h = Math.max(1, Math.round(_db.y * st.scale)), sig = w + 'x' + h;
    if (sig !== sizeSig) {
      sizeSig = sig;
      if (composer) composer.setSize(w, h);
      if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / w, 1 / h);
    }
    return [w, h];
  }

  /* ---- state ---- */
  const forced = qs.get('q') && LEVELS[qs.get('q')] ? qs.get('q') : null;
  const saved = store.get(QKEY);
  const st = {
    enabled: true, choice: forced || (LEVELS[saved] ? saved : 'auto'), level: 'normaal', auto: !forced, scale: 1,
    gain: 1, gainInit: false, last: 0, ema: 16.7, slowFor: 0, fastFor: 0, holdUntil: 0, paused: false,
    calls: 0, tris: 0, frames: 0, err: 0, inside: false, room: 0, lvl: 0, xr: false, envI: -1,
  };
  const deviceLevel = autoLevel(R);
  const hostTM = R.toneMapping; // given back while an XR session runs (plain host rendering)
  R.toneMapping = TM_BY_NAME[CFG.tm] ?? hostTM;

  function applyLevel(name, why) {
    const lv = LEVELS[name]; if (!lv) return;
    st.level = name; st.scale = 1; st.holdUntil = performance.now() + 4000; st.slowFor = st.fastFor = 0;
    if (!R.xr.isPresenting) {
      const dpr = Math.min(window.devicePixelRatio || 1, lv.dpr);
      if (Math.abs(R.getPixelRatio() - dpr) > 1e-3) R.setPixelRatio(dpr);
    }
    setShadowSize(lv.shadow);
    setRectCount(lv.rect);
    if (lv.composer) buildComposer(lv);
    sizeSig = ''; shadowSig = '';
    syncButton();
    if (why === 'auto-down') H.ui?.toast?.(`Beeld vereenvoudigd voor soepel lopen (kwaliteit: ${lv.name})`);
  }
  function setChoice(choice, persist) {
    st.choice = choice;
    if (persist) store.set(QKEY, choice === 'auto' ? null : choice);
    st.auto = choice === 'auto';
    applyLevel(choice === 'auto' ? deviceLevel : choice);
  }

  /* ---- UI: Kwaliteit ---- */
  const ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 5.2L20 9l-4.3 3.8L17 18.5 12 15.6 7 18.5l1.3-5.7L4 9l5.8-.8z"/></svg>';
  function syncButton() {
    if (!H.ui || !H.ui.addTool) return;
    const lv = LEVELS[st.level], auto = st.choice === 'auto';
    H.ui.addTool({
      id: 'kwaliteit', icon: ICON, label: `Kwaliteit: ${auto ? 'Auto' : lv.name}`,
      title: `Beeldkwaliteit: ${lv.name}${auto ? ' (automatisch gekozen voor dit apparaat)' : ''}. Klik om te wisselen: Auto, Hoog, Normaal, Snel.`,
      onClick: () => {
        const seq = ['auto', ...ORDER], next = seq[(seq.indexOf(st.choice) + 1) % seq.length];
        setChoice(next, true);
        H.ui.toast?.(next === 'auto' ? `Beeldkwaliteit automatisch: ${LEVELS[st.level].name}` : `Beeldkwaliteit: ${LEVELS[next].name}`);
      },
    });
  }

  /* ---- pause (photo.js owns the frame): window lights off so a path tracer does not count them twice ---- */
  if (typeof H.pauseRender === 'function' && !H.pauseRender.__post) {
    const inner = H.pauseRender;
    const wrapped = function (on = true) { st.paused = !!on; if (st.paused) for (const L of rectPool) L.intensity = 0; return inner.call(this, on); };
    wrapped.__post = true; H.pauseRender = wrapped;
  }

  /* ---- per-frame ---- */
  const _cam = new THREE.Vector3();
  function lampLevel() { let m = 0; scene.traverseVisible(o => { if (o.isPointLight && !o.userData.post) m = Math.max(m, o.intensity); }); return m; }
  let lampK = 0, lampColor = new THREE.Color(1, 0.76, 0.48), refLamp = null;
  function frame(now) {
    const dt = st.last ? Math.min(0.25, (now - st.last) / 1000) : 0.016; st.last = now;
    const lv = LEVELS[st.level], mode = H.mode || 'walk';
    refreshSky();
    if ((st.frames & 63) === 0) scanScene(false);
    camera.getWorldPosition(_cam);
    const inside = MAP.inside(_cam.x, _cam.y, _cam.z), code = MAP.code(_cam.x, _cam.y, _cam.z), lvl = levelOfY(_cam.y);
    st.inside = inside; st.room = code; st.lvl = lvl;
    const envI = scene.environmentIntensity ?? 1, night = clamp((1 - envI) / 0.95, 0, 1);
    // lamp level: every 16 frames, and at once when the time of day moves or the lamps switch (one reference lamp is watched:
    // between 17:30 and sunset the lamps come on while the sky, and so envI, stays the same); a still capture always measures
    if ((st.frames & 15) === 0 || Math.abs(envI - st.envI) > 1e-3 || st.paused || (refLamp && refLamp.intensity !== st.refI)) {
      st.envI = envI;
      lampK = clamp(lampLevel() / 11, 0, 1);
      refLamp = null;
      scene.traverse(o => { if (o.isPointLight && !o.userData.post) { refLamp ||= o; if (o.intensity > 0) lampColor.copy(o.color); } });
      st.refI = refLamp ? refLamp.intensity : 0;
    }
    // indoor light share, AO
    const doll = mode !== 'walk';
    const kIn = doll ? CFG.kDoll : lv.composer ? CFG.kIn : CFG.kInSnel;
    if (ao && lv.ao > 0) { const want = doll ? Math.min(lv.ao, 0.5) : lv.ao; if (ao.resScale !== want) { ao.resScale = want; sizeSig = ''; } }
    U.postP0.value.set(1, kIn, doll ? CFG.kDoll : lv.composer ? CFG.kSpecIn : CFG.kInSnel, lv.ao > 0 && ao && ao.enabled ? CFG.ao.strength : 0);
    U.postDbg.value = CFG.debug;
    { const t = CFG.inTint, l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2], k = doll ? 0.4 : 1; U.postTint.value.set(1 + (t[0] / l - 1) * k, 1 + (t[1] / l - 1) * k, 1 + (t[2] / l - 1) * k); }
    U.postP1.value.x = CFG.ao.direct + (CFG.ao.nightDirect - CFG.ao.direct) * night * (lv.ao > 0 ? 1 : 0);
    // windows of the room you are in (walk), none in the dollhouse (the rooms are open to the sky there)
    // while paused (photo.js / compare.js own the frame) a render of the main view is a still capture: it gets its window light
    // and the exposure for its own pose; the lights go dark again right after, so a path tracer never counts them
    const capture = st.paused;
    placeWindows(_cam, code, lvl, !doll, envI);
    if ((st.frames % 10) === 0 || winSig !== st.maskSig || capture) { updateLightMasks(); st.maskSig = winSig; }
    fitShadow(doll ? 'doll' : 'walk', _cam, !inside);
    // exposure: a camera exposes for the room; outdoors the host's exposure stands
    // exposure: daylight and lamp light add up; a camera exposes for their sum (harmonic blend of the two exposures)
    const dayB = (1 - night) / CFG.gainIn, lampB = lampK / CFG.gainLamp, lampShare = lampB / Math.max(1e-4, dayB + lampB);
    const target = doll ? CFG.gainDoll : inside ? clamp(1 / Math.max(1e-3, dayB + lampB), CFG.gainLamp * 0.85, Math.max(CFG.gainNightMax, CFG.gainIn * (1 - night)))
      : CFG.gainOut + (CFG.gainNightOut - CFG.gainOut) * night;
    U.postP2.value.set(CFG.fill, CFG.fillNear, 1 + (CFG.lampGlow - 1) * lampK, 0);
    const gain0 = st.gain;
    if (!st.gainInit || capture) { st.gain = target; st.gainInit = true; }
    st.gain += (target - st.gain) * (1 - Math.exp(-dt / Math.max(0.01, CFG.adapt)));
    const tmName = TM_NAME[R.toneMapping] || 'aces';
    const exposure = R.toneMappingExposure * st.gain * (CFG.tmGain[tmName] ?? 1);
    // white balance: at night a camera takes out part of the lamp colour
    const wbK = CFG.wbNight * lampShare * (doll ? 0.4 : inside ? 1 : 0.5);
    const wb = fin ? fin.uniforms.uWB.value : new THREE.Vector3();
    if (wbK > 0) {
      const c = lampColor, r = Math.pow(1 / Math.max(0.05, c.r), wbK), g = Math.pow(1 / Math.max(0.05, c.g), wbK), b = Math.pow(1 / Math.max(0.05, c.b), wbK);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; wb.set(r / lum, g / lum, b / lum);
    } else wb.set(1, 1, 1);
    if (!capture) st.wb = wb; // photo.js develops its path traced still with the same white balance

    R.info.autoReset = false; R.info.reset();
    try {
      if (lv.composer && composer) {
        const [w, h] = syncSize();
        U.postInvRes.value.set(1 / w, 1 / h);
        if (ao.enabled) {
          U.postAO.value = ao.pdRenderTarget.texture; U.postAODepth.value = ao.depthTexture;
          const aw = ao.pdRenderTarget.width, ah = ao.pdRenderTarget.height;
          U.postAOInfo.value.set(aw < w - 1 ? aw : 0, aw < w - 1 ? ah : 0, camera.near, camera.far);
        }
        fin.uniforms.toneMappingExposure.value = exposure;
        fin.uniforms.uVig.value = doll ? CFG.vignetteDoll : CFG.vignette;
        fin.uniforms.uAspect.value.set(w / Math.max(w, h), h / Math.max(w, h)).multiplyScalar(1.15);
        fin.uniforms.uGrain.value = CFG.grain; fin.uniforms.uSeed.value = (st.frames % 64);
        if (bloom.enabled) {
          bloom.strength = CFG.bloom.strength; bloom.radius = CFG.bloom.radius;
          bloom.threshold = CFG.bloom.threshold / Math.max(1e-3, exposure);
          bloom.highPassUniforms.smoothWidth.value = CFG.bloom.knee / Math.max(1e-3, exposure);
        }
        setActive(true);
        composer.render(dt);
      } else {
        R.getDrawingBufferSize(_db); U.postInvRes.value.set(1 / _db.x, 1 / _db.y);
        setActive(true); U.postWB.value.copy(wb);
        const e = R.toneMappingExposure; R.toneMappingExposure = exposure;
        try { plain(scene, camera); } finally { R.toneMappingExposure = e; }
      }
    } finally {
      setActive(false);
      st.calls = R.info.render.calls; st.tris = R.info.render.triangles;
      R.info.autoReset = true;
      if (capture) { for (const L of rectPool) L.intensity = 0; st.gain = gain0; }
    }
    st.frames++;
    if (!capture) watchdog(dt, now);
  }

  /* ---- adaptive quality: < 30 fps for 3 s → lower resolution, then (auto only) a lower level ---- */
  function watchdog(dt, now) {
    if (forced || document.hidden || now < st.holdUntil || dt <= 0 || dt > 0.2) return;
    st.ema += (dt * 1000 - st.ema) * 0.1;
    const lv = LEVELS[st.level];
    if (st.ema > 33.3) { st.slowFor += dt; st.fastFor = 0; } else if (st.ema < 18) { st.fastFor += dt; st.slowFor = 0; } else { st.slowFor = Math.max(0, st.slowFor - dt); st.fastFor = 0; }
    if (st.slowFor > 3) {
      st.slowFor = 0; st.holdUntil = now + 3000;
      if (lv.composer && st.scale > 0.71) { st.scale = Math.round((st.scale - 0.15) * 100) / 100; sizeSig = ''; }
      else if (st.auto && ORDER.indexOf(st.level) < ORDER.length - 1) applyLevel(ORDER[ORDER.indexOf(st.level) + 1], 'auto-down');
      else if (!lv.composer && R.getPixelRatio() > 1.01 && !R.xr.isPresenting) R.setPixelRatio(Math.max(1, R.getPixelRatio() - 0.25));
    } else if (st.fastFor > 6 && st.scale < 1) { st.fastFor = 0; st.scale = Math.min(1, Math.round((st.scale + 0.15) * 100) / 100); sizeSig = ''; st.holdUntil = now + 3000; }
  }

  /* ---- render hook: the host's own renderer.render(scene, camera) becomes our frame ---- */
  let inFrame = false;
  // XR: plain host rendering. The window lights leave the scene (they would only cost shader time on a headset)
  // and the sun shadow gets the host's own camera back; both return when the session ends.
  function xrSwitch(on) {
    st.xr = on;
    if (on) { setRectCount(0); restoreShadow(); R.toneMapping = hostTM; }
    else { setRectCount(LEVELS[st.level].rect); shadowSig = ''; sizeSig = ''; R.toneMapping = TM_BY_NAME[CFG.tm] ?? hostTM; }
  }
  function restoreShadow() {
    if (!sun || !hostShadow) return;
    const c = sun.shadow.camera;
    Object.assign(c, { left: hostShadow.l, right: hostShadow.r, top: hostShadow.t, bottom: hostShadow.b, near: hostShadow.n, far: hostShadow.f }); c.updateProjectionMatrix();
    sun.shadow.bias = hostShadow.bias; sun.shadow.normalBias = hostShadow.normalBias; shadowSig = '';
  }
  const hook = function (s, c) {
    const xr = R.xr.isPresenting;
    if (xr !== st.xr && s === scene && !inFrame) { try { xrSwitch(xr); } catch (e) { console.warn('[post] xr switch', e); } }
    if (inFrame || !st.enabled || s !== scene || c !== camera || R.getRenderTarget() !== null || xr) return origRender.call(this, s, c);
    inFrame = true;
    try { frame(performance.now()); }
    catch (e) {
      setActive(false);
      if (st.err++ < 3) console.error('[post]', e);
      if (st.err >= 3) { st.enabled = false; console.warn('[post] switched off after repeated errors'); }
      origRender.call(this, s, c);
    } finally { inFrame = false; }
  };
  R.render = hook;

  // first level + all existing materials recompiled with the patch
  applyLevel(st.choice === 'auto' ? deviceLevel : st.choice);
  scene.traverse(o => { if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.needsUpdate = true; });
  H.on?.('change', () => { lastScan = -1e9; });

  const api = {
    version: VERSION, ready: true, cfg: CFG, levels: LEVELS, map: MAP, windows: WINDOWS,
    get quality() { return st.level; },
    setQuality(q, persist = false) { if (q === 'auto' || LEVELS[q]) setChoice(q, persist); return st.level; },
    setToneMapping(name) { if (TM_BY_NAME[name] !== undefined) { CFG.tm = name; R.toneMapping = TM_BY_NAME[name]; } return CFG.tm; },
    // a render outside the main view (the mirrors' cube captures): the same room-aware shading (lamps stay in their room,
    // indoor sky share, lamp fill) but no screen-space AO, which only fits the main camera
    shade(fn) {
      if (!st.enabled) return fn();
      updateLightMasks(); const p = U.postP0.value, x = p.x, w = p.w; p.x = 1; p.w = 0;
      try { return fn(); } finally { p.x = x; p.w = w; }
    },
    lightsMoved() { if (st.enabled) updateLightMasks(); }, // the host moved point lights to other rooms: re-mask them now, not in 10 frames
    setEnabled(on) {
      st.enabled = !!on;
      if (!on) { restoreShadow(); for (const L of rectPool) L.intensity = 0; }
      return st.enabled;
    },
    info() {
      const lv = LEVELS[st.level];
      return {
        version: VERSION, quality: st.level, choice: st.choice, device: deviceLevel, gpu: gpuName(R), auto: st.auto, scale: st.scale, dpr: R.getPixelRatio(),
        toneMapping: TM_NAME[R.toneMapping], gain: +st.gain.toFixed(3), wb: st.wb ? st.wb.toArray().map(v => +v.toFixed(4)) : [1, 1, 1], exposure: +(R.toneMappingExposure * st.gain).toFixed(3), inside: st.inside, room: st.room,
        ao: lv.ao ? (lv.ao === 1 ? 'vol' : 'half') : 'uit', windowLights: rectOn.length, msaa: curSamples, aa: lv.aa, calls: st.calls, triangles: st.tris,
        emaMs: +st.ema.toFixed(1), roofBaked: roofOK, windows: WINDOWS.length, size: sizeSig, shadow: sun ? { map: sun.shadow.mapSize.x, w: +(sun.shadow.camera.right - sun.shadow.camera.left).toFixed(2), normalBias: +sun.shadow.normalBias.toFixed(4), bias: sun.shadow.bias } : null,
      };
    },
    uninstall() {
      R.render = origRender; R.toneMapping = hostTM; THREE.Material.prototype.onBeforeCompile = protoOBC; THREE.Material.prototype.customProgramCacheKey = protoKey;
      api.setEnabled(false); for (const L of rectPool) L.parent?.remove(L);
      scene.traverse(o => { if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.needsUpdate = true; });
      composer?.dispose(); delete H.post;
    },
  };
  H.post = api;
  return api;
}

/* ---------------- self-boot ---------------- */
(function boot() {
  const go = () => { try { install(window.HOUSE); } catch (e) { console.error('[post] install failed', e); } };
  if (window.HOUSE) { go(); return; }
  let n = 0; const t = setInterval(() => { if (window.HOUSE) { clearInterval(t); go(); } else if (++n > 600) clearInterval(t); }, 100);
})();
