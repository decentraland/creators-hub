# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Decentraland Creator Hub is a monorepo (npm workspaces) with three packages:

- **`@dcl/asset-packs`** (`packages/asset-packs`) — Curated 3D assets and Smart Items for Decentraland scenes. Publishes to npm.
- **`@dcl/inspector`** (`packages/inspector`) — Web-based 3D scene inspector using Babylon.js and Redux/Redux-Saga. Publishes to npm.
- **`creator-hub`** (`packages/creator-hub`) — Electron desktop app (main/preload/renderer architecture) with React + Redux Toolkit frontend. Uses `decentraland-ui2` (MUI-based) for UI components.

Dependencies flow: `asset-packs` → `inspector` → `creator-hub` (each depends on the previous via `file:` links).

## Common Commands

### Setup

```bash
make init          # Full setup: clean, install deps, protoc, build all
```

### Build

```bash
make build                # Build all packages (order: asset-packs → inspector → creator-hub)
make build-asset-packs    # Build only asset-packs
make build-inspector      # Build only inspector
make build-creator-hub    # Build only creator-hub
```

### Development

```bash
cd packages/creator-hub && npm run start    # Electron app in watch mode
cd packages/inspector && npm run start      # Inspector in watch mode
cd packages/asset-packs && npm run start    # Asset packs dev server (port 8001)
```

### Testing

```bash
make test                  # Unit tests for all packages (vitest)
make test-e2e              # E2E tests (Playwright) for inspector + creator-hub

# Per-package tests
cd packages/creator-hub && npm run test:unit      # All unit tests (main, preload, renderer, shared)
cd packages/creator-hub && npm run test:main       # Main process tests only
cd packages/creator-hub && npm run test:renderer   # Renderer tests only
cd packages/creator-hub && npm run test:shared     # Shared tests only
cd packages/inspector && npm run test              # Inspector unit tests
cd packages/inspector && npm run test:e2e          # Inspector E2E tests
```

**Note:** run vitest from inside the package (`cd packages/<pkg> && npx vitest run`). Invoking `npx vitest run` from the repo root sweeps up every workspace's specs without their per-package configs/setup and reports mass failures that are pure cwd artifacts.

**Note:** the inspector's Playwright e2e needs the browser binaries installed once (`npx playwright install chromium`) and a dev server already running at `E2E_URL` (default `http://localhost:8000`) — `npm run start` in `packages/inspector` with `VITE_INSPECTOR_PORT` set serves one. Without the binary the suite fails at launch with `browserType.launch: Executable doesn't exist`, which reads like a code failure.

### Code Quality

```bash
make lint          # ESLint across all packages
make lint-fix      # ESLint autofix + syncpack
make format        # Prettier check
make format-fix    # Prettier write
make typecheck     # TypeScript type checking across all workspaces
```

**Note:** `make lint-fix` runs `make sync-deps` first, which can fail on branches that pin `@dcl/*` packages to SDK-toolchain tarball URLs (syncpack reports `UnsupportedMismatch`). When this happens, run `npm run lint:fix` directly to skip syncpack and still get ESLint autofixes — **from the repo ROOT**. `lint`, `lint:fix`, `format` and `format:fix` are root-only scripts; running them inside `packages/inspector` fails with `Missing script: "lint:fix"` (the workspace defines only `test`/`typecheck`).

**Note:** the pre-commit hook can stage files you didn't touch. `.simple-git-hooks.json` runs `npx nano-staged`, whose tasks are repo-WIDE (`eslint . --fix`, `prettier --write "**/*"`) — it rewrites the whole tree and then stages those rewrites. Always stage explicitly (`git add -- <paths>`, never `git add .`/`-A`), commit only the files the current change actually touched, and confirm with `git show --name-only --format="" HEAD`. Matters most when two agents share one working tree. A MERGE commit is the one case where the hook is actively harmful: the merge stages every incoming file, so the hook reformats and stages the other branch's code into your merge commit. Verify the resolved files by hand (prettier/eslint on those paths, plus typecheck and tests) and commit the merge with `--no-verify`.

**Note:** npm won't repair a missing transitive lockfile node. When `npm ls` / a build's `ELSPROBLEMS` reports a transitive dep `missing` (e.g. `buffer-crc32` under the `@dcl/sdk-commands` tarball subtree), a plain `npm install` will NOT add it — npm trusts the existing lockfile and reports "up to date". Add the `node_modules/<dep>` package node to `package-lock.json` directly (version + registry `resolved`/`integrity`), then `npm install`/`npm ci` to reify it. Since the parent packages declare the dep, the node then sticks.

### Protocol Buffers

Proto files live at `packages/inspector/src/lib/data-layer/proto/`. After modifying `.proto` files:

```bash
make protoc        # Regenerate TypeScript from .proto files
```

## Architecture Notes

### Creator Hub (Electron)

- **main/** — Electron main process (Node.js). Manages scenes, runs local servers, handles IPC.
- **preload/** — Preload scripts bridging main↔renderer via contextBridge.
- **renderer/** — React SPA with Redux Toolkit, `react-router-dom`, `react-intl` for i18n. Uses `decentraland-ui2` (wraps MUI).
- **shared/** — Shared types and utilities used across main/preload/renderer.
- Build tool: Vite for all three layers.
- **Every inspector-iframe RPC channel must share `initRpc`'s transport.** `AuthenticatedMessageTransport` (`renderer/src/modules/rpc/transport.ts`) is what checks sender and origin on inbound messages — `@dcl/mini-rpc`'s own `MessageTransport` uses its `origin` argument only as the `postMessage` target, not as a filter. `initRpc` builds ONE instance and hands it to every channel (`StorageRPC`, `SceneRpc*`, `CodeParserRPC`), so a new channel inherits the check for free. Constructing a fresh transport for a new channel silently opens an unauthenticated path beside the hardened ones.

### Inspector

- 3D editor using Babylon.js with a React UI layer.
- State management: Redux Toolkit + Redux-Saga.
- Data layer communicates via Protocol Buffers (gRPC-like, using `@dcl/mini-rpc`).
- Build: custom `build.js` using esbuild.
- **Codegen safety (UI Designer splices):** when emitting author-controlled strings into generated/spliced TS source, escape BOTH positions — _values_ via proper string-literal escaping and _identifiers_ (variable/prop/callback names) via the `isValidIdentifier` gate (`lib/sdk/operations/validators.ts`). Raw `"${name}"` interpolation is an injection / build-break vector.
- **UI Designer canvas direct-manipulation commits are async.** A drag/resize handler splices the source, which round-trips (RPC parse → tree rebuild) later. Clearing the live CSS offset / `isDragging` on mouseup _before_ that lands snaps the node back to its old position for a frame, then jumps to the new one. Hold the dropped state optimistically (local state applied in render) until the committed value matches, then release it (`Canvas.tsx` `optimisticPos`).
- **Testing the UI Designer in the Creator Hub app:** CH loads the inspector iframe from `packages/inspector/public` at _runtime_ (`creator-hub/main/src/modules/inspector.ts`), so rebuilding the inspector's `public/` (e.g. `npm run start` watch in `packages/inspector`) is enough — no CH rebuild. The UI Designer panel is hidden by default (`inspector/src/redux/ui/index.ts` → `hiddenPanels: { [PanelName.UI_DESIGNER]: true }`); the inspector's own toolbar `ModeSwitcher` (the 2D/3D tablist) opens it, so no source flip is needed. A UI authored via code-as-source is plain `@dcl/react-ecs` — the scene preview renders it natively with no `@dcl/asset-packs` overlay.
- **Driving the panel from browser automation:** set an input through the native value setter and dispatch `input`, not `change` — React subscribes to `input` for text inputs, so a synthetic `change` leaves the value in the DOM and never commits. It reads back correctly from the element you just set, which makes it look committed; the give-away is that the value is absent from `node.uiTransform` on the next write. And `getComputedStyle` over CDP is unreliable for `:hover`/`:focus-within` — it has returned `opacity: 1` with neither matching, and the inverse. Screenshots are the ground truth for hover states.
- **The UI Designer also runs in the standalone inspector, in DEV builds only.** `npm run start` in `packages/inspector` prints the port to open. That is a proxy in front of esbuild's own server, which it fronts to add the COOP/COEP headers and to rewrite the Bevy agent realm's `__ORIGIN__` — the two things esbuild's static serve can't do (`bevy-agent-realm.js` holds that contract; CH's `main/src/modules/inspector.ts` keeps a second copy it can't import). The proxy port is random unless `VITE_INSPECTOR_PORT` is set, and setting it to the same value on both sides is what lets the Creator Hub load a live-reloading inspector — including under the Bevy renderer, which needs those headers for SharedArrayBuffer. esbuild's upstream is pinned to an EPHEMERAL port (`serve({ port: 0 })`) precisely so it can't collide: it defaults to 8000, which is the port most people reach for, and it would otherwise win the race against the proxy asking for the same one. Code-mode there parses with `@oxc-parser/wasm` in the tab instead of CH main's native `oxc-parser` (identical AST, asserted in `lib/logic/code-parser/wasm.spec.ts`) and reads/writes the in-memory scene fixture (`feeded-local-fs.ts`), so edits touch no real scene. Both halves are gated: the wasm parser sits behind the `INSPECTOR_DEV_PARSER` define (false under `--production`, so esbuild drops the branch and the ~740KB wasm), and the parser is only consulted when the CH RPC bridge is absent. Changing `build.js` (e.g. its loaders) requires restarting any running watch server — its config is read once at startup, and a stale one serves 503 for every request.
- **Code-as-source is the UI Designer's single source of truth.** Every UI root is a real `@dcl/react-ecs` component file under the scene's `src/ui/` (file-per-root, with a generated `src/ui/index.tsx` aggregator that calls `ReactEcsRenderer.setUiRenderer` directly, no `asset-packs` involvement), and the canvas is a live view that splices that source in place (byte-span edits via `emit-adapter.ts`, never a full AST regeneration). The earlier ECS-composite pipeline (`asset-packs::UI`/`UIBindings`/`UIDesign` schemas, the derive/split/materialize runtime, and the engine-entity `*-ui-*` operations) has been fully removed. See `docs/solutions/feature-implementation/ui-designer-code-as-source.md` for the full parse/splice architecture.
- **Binding surface = typed `export const state: State` object (primary), with hand-authored `@ui-bind`/`@ui-action` JSDoc markers as the fallback.** A field bound to the typed convention reads as `value={state.score}` in source; a marker-bound field reads as `value={score}`. Adding a variable through the editor always seeds/writes into the typed `state` object (`code/state-convention.ts`) — markers only ever originate from hand-authored or foreign code, never from the editor itself.
- **UI root lifecycle ops live in `code/store.ts`** (`createRoot`/`renameRoot`/`removeRoot`). Rename is write-new-file + delete-old-file, not a true rename — the scene-storage bridge only exposes read/write/delete, no `rename`.
- **Adding a representable react-ecs element or prop to the code-as-source parser means touching three files together:** `code/parse-adapter.ts` (read — recognize it, otherwise it silently falls back to an opaque/read-only node), `code/emit-adapter.ts` (write — a new span-splice `Edit` builder), and `code/ecs-shape.ts` (PB ⇄ ergonomic value transform, when the prop needs one). Mirror the existing thin-slice pattern rather than growing a general-purpose codegen.
- **Generating react-ecs source? Two library facts bite codegen.** `useState` is exported on the `ReactEcs` NAMESPACE (`ReactEcs.useState`) — a bare `import { useState } from '@dcl/sdk/react-ecs'` does NOT resolve. And `UiLabelProps.value` is REQUIRED, so a generated wrapper that moves `value` off the element must return a type still carrying it (`useInteraction<T extends InteractionLayer>`, `code/aggregator.ts`) or the scene stops compiling. Neither is caught by the inspector's own typecheck — verify generated source by extracting it and running `tsc` against the real `@dcl/react-ecs` types.
- **The `inspector::` namespace is NOT stripped from shipped scenes.** `dumpEngineToComposite` filters exactly three names — `inspector::Selection`, `editor::Toggle`, and the composite root — so every other editor component on an entity is serialized into `main.composite` and bundled by sdk-commands verbatim. That is load-bearing, not a leak: the composite is the only per-scene store that survives a restart (the inspector iframe's origin port changes each app launch, so its localStorage starts empty every session), and it is how `inspector::UIState` persists the Scene Info panel visibility. Adding editor state there means adding it to the shipped scene — deliberate for anything that must survive reopening, wrong for anything transient.
- **The UI Designer's 2D/3D mode persists in `.editor/project.json` (`ProjectInfo.uiDesignerOpen`), NOT the scene composite.** Editor-only (never bundled into the shipped scene) and durable across app relaunch. The host seeds it into the inspector as the `uiDesignerOpen` config/URL param (`EditorPage`); `useRestorePersistedMode` restores it synchronously on load; a toggle writes back over the `SceneRpcOutbound` `set_ui_designer_mode` method → `updateProjectInfo`. The old composite-based `inspector::UIState.uiDesignerOpen` was removed — its client→host→autosave write was never flushed on editor close, so it never actually reached `main.composite` (confirmed absent after a 2D→Back cycle). Inspector-iframe `localStorage` is not an option either: the ephemeral-port origin resets each app launch.
- **`UiBackgroundProps` drops the video-texture case.** `PBUiBackground.texture` is a full `TextureUnion` (`texture` / `avatarTexture` / `videoTexture`), but the react-ecs AUTHORING type flattens it into two optional props — `texture?: UiTexture` and `avatarTexture?: UiAvatarTexture` — with no video variant (`grep videoTexture node_modules/@dcl/react-ecs/dist/` is empty). The designer emits react-ecs source, so `FillField` offers Colour/Image/Avatar only. The ceiling is the TS wrapper, NOT the protocol or the renderer. Restoring video needs an upstream `js-sdk-toolchain` change AND a way for a self-contained `src/ui/*.tsx` to reference a `videoPlayerEntity` (an ECS entity carrying `VideoPlayer` — which a standalone UI file has no natural handle on).
- **Platform/device does NOT come from `UiCanvasInformation`.** `PBUiCanvasInformation` carries only `devicePixelRatio`/`width`/`height`/`interactableArea`/`screenInsetArea`, so anything derived from it is a screen-size heuristic. Use `@dcl/sdk/platform` — `getPlatform(): Platform | null` / `isMobile()` — which returns null until the explorer replies (so a scene renders the desktop branch for the first few frames, then self-corrects on the next tick).
- **Canvas CSS defaults mirror the PROTOCOL's absent-value default, not Yoga's library default — and where the explorer disagrees with the proto, the explorer wins.** react-ecs leaves most `uiTransform` fields unwritten, so what an unauthored node gets in-world is `ui_transform.proto`'s documented default, which is not always Yoga's (`flexShrink`: proto 1, Yoga 0 — forcing 0 made canvas labels hold full width while in-world ones wrapped per character). And the proto is not always right either: it documents `alignContent`'s default as flex-start, but the explorer empirically stretches wrapped lines. Verify in-world before encoding a default in `Canvas.tsx` `nodeStyle`, and comment which source you followed.
- **Never store editor metadata in a react-ecs `key`.** react-ecs uses stock `react-reconciler`, so React's key diffing runs above the host config: a changed key unmounts the fiber → `removeChildEntity` → `engine.removeEntity` RECURSIVELY over the whole subtree, then recreates it (`reconciler/index.ts:207-213`). Anything editable — a display name, say — would destroy and rebuild the entity tree on every edit.
- **Multi-node ops must batch their splices.** Synthetic ids are positional per parse, so the FIRST op's reparse invalidates every id after it. `Tree` delivers a multi-item drop by calling `onDrop` once per item, so a naive loop of store ops corrupts the source. Build one `Edit[]` and apply it in a single `applySourceEdits` (see `removeNodes` in `emit-adapter.ts`). Multi-node MOVE uses this — `spliceUiTransformPositions` (`code/store.ts`) commits every dragged node in one batch; see [`docs/UIDesigner.md`](docs/UIDesigner.md).
- **Bevy editor hot-reload is decided by file names, never by timing.** `sdk-commands start --data-layer` rebuilds the bundle for the editor's own autosave (`assets/scene/main.composite`, `entity-names.ts`) and for IDE code saves alike, and its `SCENE_UPDATE` WebSocket message names no file. Creator Hub main therefore relays the bundler's per-file log lines (`bevy-realm.ts` → `notify_scene_build`) and `lib/renderer/bevy/build-reload-bridge.ts` reloads only when a cycle names a source file the inspector did not write itself (`lib/logic/own-writes.ts`), or after a Script component edit. Script inputs have no live path: the bundle bakes each `asset-packs::Script` layout in at build time (`@dcl/sdk-commands` `collectScriptData`) and its inlined `runtime-script.ts` resolves the params once at startup, so an input edit is invisible until a reload — issued at once while the scene runs, deferred to the next Play while it is frozen. Forwarding Script as a raw CRDT PUT (`set_component_raw`) was tried and parked: it needs a matching runtime in js-sdk-toolchain (branch `fix/script-live-inputs`), which was pushed back on. Do not reintroduce a "recent local edit" quiet window: the autosave→rebuild→notify chain lands at ~1.3 s and races any window, which produced both spurious reloads and swallowed Script updates. The standalone bevy-editor repo uses the same log lines.
- **Nothing in the Bevy editor can read engine-written state on a frozen scene without ticking it — so don't.** The editor agent (`agents/bevy`) is a separate super-user scene: its SDK getters (`GltfContainerLoadingState.getOrNull(entity)`) see only its own ECS and return null for the inspected scene. And every engine console READ (`crdt_snapshot`, `scene_entities`, `inspect_component`) is answered by the scene THREAD's copy of the world, which a frozen scene refreshes only on a tick — while console WRITES (`set_component`, `new_entity`) apply to the renderer immediately and are queued for the scene thread until the next tick (a `set 1086.Transform = …` reply says nothing about that). `tick_scene` runs the scene's systems for a frame per edit (it surfaced a scene-script runtime error live), so it is not an editor tool. Anything the panels need from a model — e.g. Animator clip names — is parsed from the GLTF file itself via the mount context's `loadAsset` (`lib/renderer/bevy/gltf-animations.ts`; unnamed clips are `Animation<index>` like the engine). Engine-written state becomes readable once the scene ticks on Play.
- **Interaction-state styling is a "recognized construct"** — a `useInteraction({ base, hover, press, active })` call spread onto an element (`code/interaction-convention.ts`). The parser special-cases that spread instead of opacifying it, so the node stays first-class and splice-editable. Reuse this pattern for other constructs (e.g. platform variants): an inline ternary inside `uiTransform`/`uiBackground` instead sets `dynamicProps`, a hard write barrier that freezes EVERY panel edit on the node. Two consequences worth knowing: an opaque node renders `children: []`, so a mis-resolved construct makes the whole subtree vanish from the canvas; and for a node with interaction states, every modeled prop must live in the layers — a JSX attribute would shadow the spread and, for the pointer props, replace the helper's own hover/press trackers.

### Asset Packs

- Runtime built with `@dcl/sdk-commands` (SDK7 scene).
- TypeScript library (`dist/`) + catalog.json + binary assets (`bin/`).
- Scripts for validating, uploading to S3, and downloading assets.
- Public API is exported via `src/definitions.ts` (built to `dist/definitions.js`, the package `main`). Cross-package VALUE imports from `@dcl/asset-packs` in the inspector only resolve after rebuilding asset-packs (`make build-asset-packs`). This also affects the inspector's **vitest unit tests**, which import the built `@dcl/asset-packs` — a source edit in asset-packs won't be seen (in imports, typecheck, or tests) until rebuilt. `npm run build:lib` (in `packages/asset-packs`) is the minimal/fast rebuild to refresh `dist/`.
- **`@dcl/asset-packs` is the shared home for generic helpers the inspector consumes** (e.g. `parseHexColor` / `validateAssetPath` in `src/validation.ts`). When deleting an asset-packs feature module, relocate its generically useful exports there (and keep the `definitions.ts` re-export) instead of inlining them into inspector consumers.

## CI / GitHub Actions

CI is orchestrated by `.github/workflows/ci.yml`, which calls reusable (`on: [workflow_call]`) sub-workflows. Key conventions and gotchas:

- **Build once, reuse.** `build.yml` builds the portable artifacts (proto gen, asset-packs `dist/bin/catalog.json`, inspector `dist/public`) a single time per run, gated by a combined source-hash `actions/cache`. QA jobs (`typechecking`, `tests`) consume them via the `.github/actions/download-build` composite action instead of rebuilding. Don't reintroduce per-job `make protoc` / `make build-*` in the QA jobs. The publish chain (asset-packs → inspector → creator-hub) still builds its own tarballs on purpose.
- **A reusable workflow's `needs:` can only reference jobs in the same file.** Cross-workflow ordering and artifact prerequisites are expressed at the `ci.yml` caller level (e.g. `tests: needs: [build]`), not inside `tests.yml`. Artifacts are run-scoped and shared across all called reusable workflows.
- **`e2e` is decoupled from the publish chain — enforced by branch protection, not `needs`.** `tests.yml` is unit-only; the Playwright suites live in `e2e.yml` (`e2e-inspector` + `e2e-creator-hub`), wired as `e2e: needs: [build, tests]` in `ci.yml`. It is a leaf job — nothing depends on it — so the publish chain (`drop_pre_release → asset-packs → inspector → creator-hub`) starts after `unit`/`lint`/ `typechecking` instead of waiting ~12 min for e2e (that serialization was the pipeline's long pole). **Do NOT add `e2e` to `drop_pre_release`'s `needs`.** Because the DAG no longer gates on e2e, `e2e-inspector` and `e2e-creator-hub` MUST be **required status checks in branch protection**, or they silently become optional. On `main` pushes (no branch protection) the chain publishes in parallel with e2e — safe because the merged code already passed e2e on the PR.
- **Lint workflows with `actionlint`, not the JS toolchain.** `make format`/ `make lint`/`make test` do NOT cover `.github/**` YAML (Prettier globs `js,ts,tsx,json` and `.prettierignore` excludes `.github`; ESLint is `js,cjs,ts`).
- **`actionlint` mis-lints composite `action.yml` files** as workflows and reports bogus "jobs/on section missing" errors. Validate `.github/actions/*/action.yml` with a YAML parser instead; run `actionlint` on `.github/workflows/*.yml`.
- **Cache whole output directories, not file lists.** The build cache once listed inspector outputs individually and missed `bundle.css`; warm-cache runs then served an unstyled app, and every e2e "flake" was really a cache hit (`build.yml`).
- **Debugging `e2e-inspector` failures: read the `[e2e-diag]` log lines first** (plus the `inspector-e2e-diagnostics` artifact). The suite dumps DOM boxes, console/page errors, and a screenshot on readiness timeout — match those before changing any config.
- **Pin third-party actions to a full commit SHA** with a trailing `# vX.Y.Z` comment (e.g. `nick-fields/retry@<sha> # v4.0.0`); leave first-party `actions/*` as major tags. `upload-artifact` (max v7) and `download-artifact` (v8) are independently versioned but artifact-format-compatible across v4+ — keep both at v7 for consistency.
- **Creator-hub PR builds are unsigned zip-only; releases build the full signed dmg.** electron-builder auto-skips code signing on PRs ("Current build is a part of pull request, code signing will be skipped"), so on PRs the two `.dmg` builds (~115 s) were pure cost with no signed output. `mac.target` in `electron-builder.cjs` is `DRY_RUN`-gated: zip-only (both arches) on PRs, full `dmg + zip` on `main` (`dry-run: false`). Don't re-add dmg to the PR path or expect signing/notarization on PR builds.
- **Build/tool targets must self-provision — the build job skips `make install` on a node_modules cache hit.** `build.yml`'s install step is gated on the node_modules cache, so any target that runs during a build cannot assume `make install` ran. Make each ensure its own inputs: `protoc: $(PROTOC)` (self-download); `build-bevy-agent: install-bevy-agent` (the Bevy agent's pinned `@dcl/sdk` must be installed locally or esbuild resolves root's wrong version). The node_modules cache path must also cover every nested project's `node_modules` (e.g. `packages/inspector/agents/bevy/node_modules`), or a cache hit serves an incomplete tree. Symptoms of a gap: cold-cache failures like `protoc: not found` (Error 127) or `No matching export … CameraLayer`.
- **Every job that can run `make install` MUST checkout with `submodules: true`.** The install chain calls `init-submodules` (`git submodule update --init`), which clones the `devtools-frontend` submodule over its `.gitmodules` SSH URL; `checkout` only rewrites that to a token-authenticated HTTPS URL when `submodules: true` is set, so a cache-miss install otherwise dies with `Permission denied (publickey)`. This is **orthogonal to the build cache** — a green build-artifact download does NOT skip install; `node_modules` is a separate cache keyed on `package-lock.json`, so any lockfile bump (or fresh branch) makes install run and hit the submodule. Invisible on warm-cache PR runs, which is why it slipped past `build.yml` and both `e2e.yml` jobs one at a time. Adding a new install-running job? Add `submodules: true`.

## Code Style

- **ESLint**: `@typescript-eslint/consistent-type-imports` is enforced (use `import type` for type-only imports).
- **Lint scope**: `make lint` / `npm run lint` runs `eslint . --ext js,cjs,ts` — it does **not** lint `.tsx` files. Real violations DO hide there, so lint touched `.tsx` explicitly before shipping (`npx eslint "packages/inspector/src/**/*.tsx"`). Two `import/order` errors survived on the UI Designer branch precisely because the gate skips them. A standalone `.tsx` run also reports two spurious errors to ignore: `consistent-type-imports` on the `@dcl/react-ecs` JSX-pragma default import (e.g. `ui-renderer.tsx`), and `react-hooks/exhaustive-deps` "Definition for rule … was not found" (the plugin isn't loaded for a standalone invocation).
- **Prettier**: `.prettierrc` is the contract — follow it, don't infer style from surrounding code. Single quotes, semicolons, trailing commas, 100 char print width, `arrowParens: "avoid"`, and an override making `**/*.{css,scss,html}` use DOUBLE quotes. Note the `npm run format` glob is only `**/*.{js,ts,tsx,json}`: CSS is configured but never checked, so stylesheets drift and a passing `npm run format` says nothing about them.
- **Import order**: ESLint enforced. React first, then `@dcl/*`, then `decentraland-*`, then MUI/internal, then relative.
- **Component-directory barrels**: inspector component directories use a per-directory `index.ts` barrel (`export { X } from './X'`) — ~30/31 dirs follow this. Add one when creating a component; don't strip these barrels for file-count reduction — it breaks the established convention.
- **Unused vars**: prefix with `_` (e.g., `_unused`).
- **Comments**: code must be self-explanatory (clear names, small functions). Do NOT write comments that only restate what the next line does — delete them. Keep only comments that add value the code can't convey: the non-obvious _why_ (rationale, trade-off, gotcha, bug/constraint reference), invariants, or warnings.
- **Module type**: ESM (`"type": "module"` in all package.json files).
- **Node version**: 22.x or higher required.

## Styled Components Conventions

Files matching `*.styled.ts` / `*.styled.tsx` must follow these rules:

- Import `styled`, `keyframes`, and MUI components from `decentraland-ui2` (not `@emotion/styled` or `@mui/material`).
- Use object syntax only (no template literals): `styled(Box)(({ theme }) => ({ ... }))`.
- Use `styled('tag')` form for HTML elements (not `styled.tag`).
- Use theme tokens for all colors, spacing, typography, breakpoints — no hardcoded values.
- Define styled components as `const`, group all `export { ... }` at the end of the file alphabetically.
- No comments, no `!important`, no inline styles in styled component files.
- Keep styled components in separate `Component.styled.ts` files alongside `Component.tsx`.

## Gotchas

Hard-won traps that reading the code does not reveal. Testing-specific ones live in [`docs/testing-standards.md`](docs/testing-standards.md).

### Redux state freeze + in-place mutating helpers

Redux Toolkit auto-freezes state via Immer (the `createSlice` default). Helpers that mutate objects in place (e.g. asset-packs' `deepReplaceAssetPath` / `substituteAssetPathInComposite`) throw `TypeError: Cannot assign to read only property` — or fail silently — when passed payloads read from Redux. Deep-clone (`structuredClone(x)`) at the boundary before passing Redux-sourced data to any mutating helper. Symptoms when missed: writes silently no-op, original placeholder tokens (e.g. `{assetPath}/...`) survive into the engine.

### Asset-pack composite placeholders must resolve before the engine serializes

Asset-pack `composite.json` files encode references as portable placeholders: paths as `{assetPath}/...`, ids as `{self}` / `{self:Component}` / `{N:Component}`, and `SyncComponents.componentIds` as component-**name** strings (e.g. `"asset-packs::States"`). Each must be resolved to a concrete value before the runtime engine serializes the component. The runtime `core-schema::Sync-Components` `componentIds` schema is `Array(Int64)`, so an unresolved name reaching it makes the CRDT serializer throw `SyntaxError: Cannot convert <name> to a BigInt` every tick. Resolution lives in two places: the Inspector resolves names→ids on ingest (`add-asset`'s `parseSyncComponents`); the SPAWN_ENTITY runtime path resolves post-`Composite.instance` in `add-child.ts` (`remapSyncComponentIds`, beside the `{self}` id/trigger remap). When adding a placeholder-bearing field — or debugging a `Cannot convert … to a BigInt` serialize crash — ensure both paths resolve it.

### GLB image URIs with `..` need bevy-explorer ≥ `7546497`

The optimizer's shared sidecar folder makes GLBs reference textures through `../` URIs. Bevy explorer builds before decentraland/bevy-explorer commit `7546497` ("Resolve glTF texture and buffer uris against the content map", engine package `0.1.0-34847389052.commit-7546497`) joined such a uri onto the gltf's parent with `Path::join`, which keeps `..`, so the content-map lookup missed and models rendered with only their emissive map; Unity always normalized. The inspector pins the engine in `packages/inspector/package.json`; if that symptom reappears, the pin is stale — the fix belongs in the explorer, not in relocating textures beside each model (that was tried, and it forfeits cross-folder dedup).

### `~system/CommsApi` `consumeMessages` returns a bare array

`consumeMessages({ topic })` resolves to a **bare array** of `{ sender, data }`, not the `{ messages: [...] }` wrapper its TypeScript type implies (the explorer's `CommsApiWrap.ConsumeMessages` serializes a raw JSON array). Destructuring `const { messages } = await consumeMessages(...)` yields `undefined` and throws on `.length` — and inside a `try/catch` that silently drops every message with no error. Read it as an array, tolerating both shapes: `Array.isArray(res) ? res : (res?.messages ?? [])`.

## Design handoff

Design specs live in Figma ("📗️ Design System | Creator Hub"). The Figma MCP tools are capped on a View seat and then return `reached the Figma MCP tool call limit` for **every** call, `get_metadata` included — the cap is account-wide, not per-tool. When that happens, read the frame with the Claude-in-Chrome browser tools instead: open the `?node-id=` URL, select a variant in the Layers panel, `shift+2` to zoom to selection, then `computer`→`zoom` over viewport regions to read labels. A component's variants are enumerated in the Layers panel, which is the fastest way to learn every state a panel must cover.

### Electron response headers must be overridden case-insensitively

`session.webRequest.onHeadersReceived` rebuilds the whole response header block from the object the handler returns, writing one line per key with **no case-insensitive de-duplication** — and it keys `details.responseHeaders` by the _wire_ casing, which is lowercase over HTTP/2 (what every CDN in front of `decentraland.org` speaks). So `{ ...details.responseHeaders, 'Cross-Origin-Embedder-Policy': [...] }` does not replace the response's own header, it **appends a second one**. Chromium joins duplicates (`credentialless, credentialless`), fails to parse the structured field and falls back to `unsafe-none` — an injection that reads correctly while having no effect at all. A duplicated `Access-Control-Allow-Origin` is rejected outright. Drop every casing of a name before setting it (`setHeader` in `main/src/security-restrictions.ts`), and assert header counts **case-insensitively** in tests — a same-case lookup cannot see the duplicate, which is why the #1456 suite passed while the bug shipped. Symptom when missed: #1485, the GLB import spinner never resolving with no error in the UI or Sentry.

## Skills

Skills live in `.ai/skills/*/SKILL.md`. Read the relevant `SKILL.md` when a task matches a skill's domain.

## Standards

Read the relevant standards doc when the task touches its domain:

- [`docs/coding-standards.md`](docs/coding-standards.md) — React patterns and antipatterns (controlled-input prop-sync, memoized components built in render). Read when touching `TextField`, the tree `<Input>`, or building any component with a buffered value.
- [`docs/testing-standards.md`](docs/testing-standards.md) — how to write a test here, plus every testing gotcha: Vitest conventions and mocking traps (`vi.mock` factories replacing whole modules, fake timers leaking across `describe`s), and E2E patterns (real keyboard input vs `fill()`, locators vs `ElementHandle`s, focus-actually-on-element gates, outcome waits vs fixed sleeps). Read before writing or debugging any test.
- [`docs/DESIGN.md`](docs/DESIGN.md) — the inspector design system: `theme/vars.css` palette by role, the light→dark `--base-*` ramp gotcha + correct dark-surface pairing, spacing/fonts, and focus/contrast/motion/ARIA conventions. Read when writing or reviewing inspector CSS/`.tsx` styling (colors, focus states, accessibility). Note: `brand-guidelines` (Anthropic) does NOT apply here.
- [`docs/UIDesigner.md`](docs/UIDesigner.md) — the UI Designer (2D) mode: how to test it (standalone-vs-Creator-Hub limits, browser-automation traps), and the 2D toolbar, tool modes, scene-run intent, multi-node move, and mode-persistence architecture. Read when touching the 2D toolbar, the canvas direct-manipulation, or the 2D/3D switch.
