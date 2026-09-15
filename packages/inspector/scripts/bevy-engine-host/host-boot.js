/* eslint-env browser */
// Bevy engine host boot script. Kept as an EXTERNAL same-origin module (not
// inline in engine.html) so the host page's Content-Security-Policy can use a
// strict `script-src 'self' …` with no `'unsafe-inline'` — an injected inline
// script then can't execute in this privileged, editor-bridged frame. Copied
// into `public/bevy-engine/` alongside engine.html by scripts/copy-bevy-engine.ts.
const params = new URLSearchParams(window.location.search);
const realm = params.get('realm') ?? undefined;
const position = params.get('position') ?? undefined;
const systemScene = params.get('systemScene') ?? undefined;
// `preview=true` makes the engine treat this session as a preview: notably it
// renders OUT-OF-BOUNDS geometry (dithered) instead of discarding it, so items
// the user drags outside the scene layout stay visible in the editor (#1391).
// The engine's show-outside-bounds mesh tag is gated on is_preview.
const preview = params.get('preview') === 'true';
// Leave `portables` UNDEFINED so the engine loads its default
// `basiccontroller.dcl.eth` portable — same as bevy-editor. Since the
// react-web engine layout, that PX PROVIDES the player's movement controller,
// so it's REQUIRED for avatar WASD walking. (We previously forced
// `portables=''` to skip its content-server fetch on the old engine, where
// movement was engine-built-in; on this engine that silently killed WASD
// walking while leaving camera/arrows working — a confusing footgun.)
const portables = undefined;

// The engine's asset processor reads/writes a cache the service worker
// manages; register it under `/bevy-engine/` (this page's dir → that scope).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service_worker.js').catch(e => {
      console.warn('[bevy engine-host] service worker registration failed', e);
    });
  });
}

// boot.js (engine ≥ commit-7546497) reads these HOST-PROVIDED globals at module eval for its
// URL sync; without them the module throws before defining __bevyLaunch and the frame stays
// white. The react-web HUD derives them from its ?<service>= params. This editor host has no
// such params, so mirror the engine's own rule — each service at its default host under the
// base domain. They only decide which params the sync omits as "default".
const BASE_DOMAIN = 'decentraland.org';
const SERVICE_HOSTS = {
  realmProvider: 'https://realm-provider-ea',
  catalyst: 'https://peer',
  worldsServer: 'https://worlds-content-server',
  places: 'https://places',
  commsGatekeeper: 'https://comms-gatekeeper',
  previewGatekeeper: 'https://comms-gatekeeper-local',
  assetBundleRegistry: 'https://asset-bundle-registry',
  storage: 'https://storage',
  ethereumRpc: 'wss://rpc',
  socialRpc: 'wss://rpc-social-service-ea',
  opensea: 'https://opensea',
  reels: 'https://reels',
};
window.__defaultBaseDomain = () => BASE_DOMAIN;
window.__serviceUrl = name => `${SERVICE_HOSTS[name] ?? `https://${name}`}.${BASE_DOMAIN}`;
window.__defaultRealm = () => `${window.__serviceUrl('realmProvider')}/main`;

// Boot contract, set BEFORE injecting boot.js (it reads these at module
// eval). `PUBLIC_URL` is intentionally left UNSET so engine.js resolves its
// `pkg/` wasm relative to its own module URL — i.e. the same-origin
// `/bevy-engine/engine/` dir we serve — instead of a CDN.
// `editor: true` tells the engine this is an editor session: it runs the scene's
// main() once and then auto-freezes it at tick 3 (bevy-explorer #1015), the
// deterministic "static subject to edit" state. Always true — this host page only
// ever boots the embedded editor engine. The agent no longer force-freezes
// (see ENGINE_AUTO_FREEZES_EDITOR_SCENE); play/stop still ride /freeze_scene.
window.__bevyBootConfig = { systemScene, portables, preview, editor: true };

// Load the engine's boot module as a runtime <script> (NOT an import): it
// ships in the engine package under `/bevy-engine/engine/` and must load
// from there, same-origin, with a relative URL.
const boot = document.createElement('script');
boot.type = 'module';
boot.src = 'engine/boot.js';
boot.onerror = () => console.error('[bevy engine-host] failed to load engine/boot.js');
document.head.appendChild(boot);

// The engine fetches `<systemScene>/about` exactly once at launch to load the
// editor-agent PX; a refused connection silently drops the agent for the whole
// session. Boot is near-instant once the GPU/wasm caches are warm, so it can
// win the race against a still-starting realm server — hold the launch until
// the systemScene realm actually answers (bounded), then launch.
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      /* not up yet — retry */
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn(`[bevy engine-host] ${url} still not answering — launching anyway`);
}

async function launchWhenReady() {
  // 45s matches the EditorPage `loadTimedOut` backstop — past that the host
  // has already surfaced its load-error recovery, so retrying longer here
  // just holds a black viewport with no feedback.
  if (systemScene) await waitForServer(`${systemScene}/about`, 45_000);
  while (window.__bevyReadyToLaunch !== true) {
    await new Promise(r => setTimeout(r, 100));
  }
  window.__bevyLaunch(realm, position);
}

void launchWhenReady();
