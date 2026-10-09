/* vault.js — wachtwoordpoort + versleutelde foto's (add-on voor de Ons Huis-walkthrough)
 *
 *  - De poort (#vault) staat als markup + CSS in index.html, zodat het huis nooit even zichtbaar is; dit module maakt hem werkend.
 *    Het huis laadt gewoon door achter de poort. Zolang hij open staat krijgt de app geen toetsen (lopen) en geen focus.
 *  - vault/vault.json { salt, iter, check }: sleutel = PBKDF2-SHA256(wachtwoord, trim + kleine letters) -> AES-GCM-256;
 *    check is een versleutelde bekende tekst om het wachtwoord te controleren. Bestanden: vault/<naam>.txt = base64(iv12 || ciphertext).
 *    Maken / bijwerken: tools/vault.mjs (bronrepo), nooit in app/.
 *  - "Onthouden op dit apparaat": de ruwe sleutel (niet het wachtwoord) in localStorage, anders alleen voor deze tab (sessionStorage).
 *  - API: window.VAULT en HOUSE.vault = { ready: Promise, url(naam) -> Promise<blob-URL>, json(naam) -> Promise, unlocked, forget() }.
 *  - Laden (vóór de hoofdmodule):  <script type="module" src="./modules/vault.js"></script>
 */

const LS = 'onshuis.vault', CHECK = 'onshuis-vault-v1';
const BASE = new URL('vault/', document.baseURI);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', json: 'application/json' };
const S = globalThis.crypto?.subtle;
const unb64 = s => Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0));
const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const store = (k, v) => { for (const st of ['localStorage', 'sessionStorage']) try { if (v && st === k) window[st].setItem(LS, v); else window[st].removeItem(LS); } catch (e) { } };
const stored = () => { for (const st of ['localStorage', 'sessionStorage']) try { const v = window[st].getItem(LS); if (v) return JSON.parse(v); } catch (e) { } return null; };

let key = null, open; const ready = new Promise(r => open = r);
let metaP = null; // a failed fetch is retried on the next attempt
const meta = () => metaP || (metaP = fetch(new URL('vault.json', BASE), { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(new Error('vault.json ' + r.status))).catch(e => { metaP = null; throw e; }));
async function decrypt(txt, k = key) { const u = unb64(txt); return new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, k, u.subarray(12))); }
async function verify(k) { try { return new TextDecoder().decode(await decrypt((await meta()).check, k)) === CHECK; } catch (e) { return false; } }
async function derive(pw) {
  const m = await meta(), base = await S.importKey('raw', new TextEncoder().encode(pw.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey']);
  return S.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(m.salt), iterations: m.iter }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
const cache = new Map();
async function fetchPlain(name) {
  await ready;
  const r = await fetch(new URL(name + '.txt', BASE)); if (!r.ok) throw new Error(`vault: ${name} ${r.status}`);
  return decrypt(await r.text());
}
const api = {
  ready,
  get unlocked() { return !!key; },
  url(name) { if (!cache.has(name)) cache.set(name, fetchPlain(name).then(u => URL.createObjectURL(new Blob([u], { type: MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' })), e => { cache.delete(name); throw e; })); return cache.get(name); },
  async json(name) { return JSON.parse(new TextDecoder().decode(await fetchPlain(name))); },
  forget() { store(null); },
};
window.VAULT = api;
// HOUSE is assigned later by the main module: hang the vault on it the moment it appears
{ let H = window.HOUSE; if (H) H.vault = api; else try { Object.defineProperty(window, 'HOUSE', { configurable: true, enumerable: true, get: () => H, set: v => { H = v; if (v && typeof v === 'object') v.vault = api; } }); } catch (e) { } }

/* ---------------- gate ---------------- */
const gate = document.getElementById('vault'), form = gate?.querySelector('form'), pw = gate?.querySelector('#vaultPw'),
  rem = gate?.querySelector('#vaultRem'), go = gate?.querySelector('button[type="submit"]'), msg = gate?.querySelector('#vaultMsg');
const shown = () => gate && !document.documentElement.classList.contains('vault-ok');
const say = (t, bad) => { if (!msg) return; msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };
function show() {
  document.documentElement.classList.remove('vault-ok');
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => pw?.focus({ preventScroll: true }), 0);
  idle();
}
// behind the gate the house is built and drawn until its first frames are up (shaders compiled), then drawing pauses:
// typing stays smooth, phones stay cool, and the adaptive quality in post.js does not judge the device by a hidden view
let paused = false;
function idle() {
  if (!shown() || paused) return;
  const H = window.HOUSE;
  if (!H?.pauseRender || !document.getElementById('loading')?.hidden) return void setTimeout(idle, 250);
  setTimeout(() => { if (shown() && !paused) { paused = true; window.HOUSE.pauseRender(true); } }, 1500);
}
function unlock(k, remember) {
  key = k; open(api);
  if (paused) { paused = false; window.HOUSE?.pauseRender?.(false); }
  document.documentElement.classList.add('vault-ok');
  if (gate) { pw.value = ''; say(''); gate.setAttribute('aria-hidden', 'true'); }
  if (remember !== undefined) S.exportKey('raw', k).then(raw => meta().then(m => store(remember ? 'localStorage' : 'sessionStorage', JSON.stringify({ k: b64(new Uint8Array(raw)), s: m.salt })))).catch(() => { });
}
// while the gate is up the walkthrough gets no keys (WASD / arrows typed into the field) and no focus
const swallow = e => { if (shown() && !(e.key === 'Tab' && gate.contains(e.target))) e.stopImmediatePropagation(); };
for (const t of ['keydown', 'keyup', 'keypress']) addEventListener(t, swallow, true);
addEventListener('focusin', e => { if (shown() && !gate.contains(e.target)) pw?.focus({ preventScroll: true }); }, true);

async function submit(e) {
  e?.preventDefault();
  if (!S) return say('Deze browser kan de pagina niet ontgrendelen. Open hem via https in een recente browser.', true);
  if (!pw.value.trim()) { say('Vul het wachtwoord in.', true); pw.focus(); return; }
  go.disabled = true; say('Even controleren…');
  let k = null;
  try { k = await derive(pw.value); if (!(await verify(k))) k = null; }
  catch (err) { go.disabled = false; return say('De beveiligde bestanden konden niet geladen worden. Controleer de verbinding en probeer het opnieuw.', true); }
  go.disabled = false;
  if (k) return unlock(k, rem?.checked !== false);
  say('Dat wachtwoord klopt niet. Probeer het nog eens.', true);
  form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  pw.select(); pw.focus({ preventScroll: true });
}
if (form) form.addEventListener('submit', submit);

(async () => {
  if (!S) { show(); say('Deze browser kan de pagina niet ontgrendelen: dat kan alleen via een beveiligde verbinding (https) in een recente browser.', true); if (go) go.disabled = true; return; }
  const s = stored();
  if (s?.k) try {
    const m = await meta();
    if (s.s === m.salt) { const k = await S.importKey('raw', unb64(s.k), 'AES-GCM', false, ['decrypt']); if (await verify(k)) return unlock(k); }
    store(null); // stale: the vault was re-encrypted with a new password
  } catch (e) { }
  show();
  meta().catch(() => say('De beveiligde bestanden konden niet geladen worden. Controleer de verbinding en probeer het opnieuw.', true));
})();
