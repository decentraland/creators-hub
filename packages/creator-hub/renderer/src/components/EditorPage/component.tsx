import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ArrowBackIosIcon from '@mui/icons-material/ArrowBackIos';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import CodeIcon from '@mui/icons-material/Code';
import SpeedOutlinedIcon from '@mui/icons-material/SpeedOutlined';
import PublicIcon from '@mui/icons-material/Public';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { CircularProgress as Loader, Tooltip } from 'decentraland-ui2';
import { IconButton } from '@mui/material';

import { isClientNotInstalledError } from '/shared/types/client';
import { isProjectError } from '/shared/types/projects';
import { RENDERER } from '/shared/types/settings';
import { isWorkspaceError } from '/shared/types/workspace';

import { t } from '/@/modules/store/translation/utils';
import { captureViewportFallback, initRpc } from '/@/modules/rpc';
import { resizeImage } from '/@/modules/image';
import { actions as aiActions } from '/@/modules/store/ai';
import { config } from '/@/config';
import { useEditor } from '/@/hooks/useEditor';
import { useSettings } from '/@/hooks/useSettings';
import { useWorkspace } from '/@/hooks/useWorkspace';
import { useSceneCustomCode } from '/@/hooks/useSceneCustomCode';
import { useDeploy } from '/@/hooks/useDeploy';
import { useConnectionStatus } from '/@/hooks/useConnectionStatus';
import { useBevyBuildForwarding } from '/@/hooks/useBevyBuildForwarding';
import { useDebugLogForwarding } from '/@/hooks/useDebugLogForwarding';
import { useMobileDebugForwarding } from '/@/hooks/useMobileDebugForwarding';
import { ConnectionStatus } from '/@/lib/connection';

import EditorPng from '/assets/images/editor.png';

import { ai, analytics } from '#preload';
import { useDispatch, useSelector } from '#store';
import { useFeatureFlags } from '/@/hooks/useFeatureFlags';
import { useAiSession } from '/@/hooks/useAiSession';
import { actions as snackbarActions } from '/@/modules/store/snackbar';
import { actions as editorActions } from '/@/modules/store/editor';
import { actions as optimizerActions } from '/@/modules/store/optimizer';
import { createGenericNotification } from '/@/modules/store/snackbar/utils';
import { Button } from '../Button';
import { Header } from '../Header';
import { Row } from '../Row';
import { ButtonGroup } from '../Button';
import { ConnectionStatusIndicator } from '../ConnectionStatusIndicator';
import { MobileQRCode } from '../Modals/MobileQRCode';
import { AssistantIcon } from '../Icons';
import { AiChatPanel } from '../AiChatPanel';
import { DetachedPlaceholder } from '../AiChatPanel/DetachedPlaceholder';
import { OptimizeModal } from '../OptimizeModal';
import { DeployModal } from './DeployModal';
import { PreviewOptions, PublishOptions } from './MenuOptions';
import { getPublishButtonText, getPublishOptions } from './utils';

import type { ModalType, ModalState } from './DeployModal';
import type { PreviewOptionsProps } from './MenuOptions';

import './styles.css';

// The AI panel is drag-resizable like the inspector's own panels; its width persists
// across sessions (global, not per-scene). Bounds keep both the panel and the iframe usable.
const AI_PANEL_WIDTH_KEY = 'creator-hub:ai-panel-width';
const AI_PANEL_MIN = 320;
const AI_PANEL_DEFAULT = 360;
const AI_PANEL_IFRAME_MIN = 360; // never squeeze the editor below this

function clampAiPanelWidth(px: number): number {
  const max = Math.max(AI_PANEL_MIN, window.innerWidth - AI_PANEL_IFRAME_MIN);
  return Math.min(Math.max(px, AI_PANEL_MIN), max);
}
function readAiPanelWidth(): number {
  try {
    const raw = localStorage.getItem(AI_PANEL_WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampAiPanelWidth(n) : AI_PANEL_DEFAULT;
  } catch {
    return AI_PANEL_DEFAULT;
  }
}

// The Bevy realm launches `sdk-commands start --no-client --data-layer`; an old
// scene's local `@dcl/sdk-commands` predates those flags and fails with a raw CLI
// usage dump (e.g. "unknown or unexpected option: --no-client"). Detect that so we
// can show a clear "update dependencies" message instead of the dump (#1457).
// Require BOTH the option-rejection phrasing AND one of our flags — matching a bare
// "--data-layer"/"--no-client" mention would misfire on an unrelated build error that
// merely prints the flag as text.
function isOutdatedDepsError(message: string): boolean {
  const rejectsOption = /(?:unknown|unexpected|unrecognized|invalid)[^\n]{0,40}option/i.test(
    message,
  );
  const namesBevyFlag = /--(?:no-client|data-layer)/i.test(message);
  return rejectsOption && namesBevyFlag;
}

// Routes an AI scene-mutation op (from main) to the inspector SceneRpc client. One entry
// per SceneRpc mutation method; add a line here + the matching client method + MCP tool as
// Phase 2 grows (set_component, remove_entity, place_smart_item, …).
type SceneClient = ReturnType<typeof initRpc>['scene'];
const SCENE_OP_HANDLERS: Record<
  string,
  (scene: SceneClient, params: Record<string, unknown>) => Promise<unknown>
> = {
  create_entity: (scene, p) =>
    scene.createEntity(p.name as string | undefined, p.parent as number | undefined),
  remove_entity: (scene, p) => scene.removeEntity(p.entity as number),
  set_parent: (scene, p) => scene.setParent(p.entity as number, p.parent as number),
  set_component: (scene, p) =>
    scene.setComponent(
      p.entity as number,
      p.component as string,
      p.value as Record<string, unknown>,
    ),
  remove_component: (scene, p) => scene.removeComponent(p.entity as number, p.component as string),
  attach_script: (scene, p) =>
    scene.attachScript(p.entity as number, p.path as string, p.priority as number | undefined),
  search_catalog: (scene, p) =>
    scene.searchCatalog(p.query as string | undefined, p.limit as number | undefined),
  place_smart_item: (scene, p) =>
    scene.placeSmartItem(
      p.assetId as string,
      p.name as string | undefined,
      p.position as { x: number; y: number; z: number } | undefined,
    ),
  undo: scene => scene.undo(),
  get_scene_metrics: scene => scene.getSceneMetrics(),
  get_selection: scene => scene.getSelection(),
  get_scene_settings: scene => scene.getSceneSettings(),
  set_scene_settings: (scene, p) => scene.setSceneSettings(p),
};

export function EditorPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const {
    error,
    project,
    refreshProject,
    saveAndGetThumbnail,
    inspectorPort,
    openPreview,
    openCode,
    updateScene,
    loadingPreview,
    previewCancelled,
    previewProgress,
    loadingPublish,
    isInstallingProject,
    killPreview,
    publishScene,
    getMobileQR,
    supportsMultiInstance,
    supportsMcp,
    supportsUiDesigner,
    isPreviewRunning,
    startBevyRealm,
    killBevyRealm,
  } = useEditor();
  const { settings, updateAppSettings } = useSettings();
  const { updatePackages } = useWorkspace();
  const { flags: featureFlags } = useFeatureFlags();
  // The AI assistant is an experimental opt-in (Settings → Experimental), like the Bevy
  // renderer — not a remote feature flag.
  const aiChatEnabled = settings.aiAssistant;
  const { executeDeployment, getDeployment } = useDeploy();
  const deployment = project ? getDeployment(project.path) : undefined;

  const isDeploying = loadingPublish || deployment?.status === 'pending';

  const publishButtonText = useMemo(
    () => getPublishButtonText({ loadingPublish, deployment }),
    [loadingPublish, deployment],
  );

  const userId = useSelector(state => state.analytics.userId);
  const { detectCustomCode, isLoading: isDetectingCustomCode } = useSceneCustomCode(project);
  const { status } = useConnectionStatus();
  const iframeRef = useRef<ReturnType<typeof initRpc>>();
  // Clear the AI selection chips: deselect everything in the inspector (only the renderer
  // holds the iframe RPC). Optimistically empty the store so the chips vanish immediately;
  // the next selection poll confirms. No-op under Bevy (no selection RPC).
  const handleClearAiSelection = useCallback(() => {
    void iframeRef.current?.scene.clearSelection().catch(() => undefined);
    dispatch(aiActions.setSelection([]));
  }, [dispatch]);
  // The AI session engine + detached-window bridge (#1504). Runs whenever the assistant is
  // on, independent of whether the chat is shown inline or popped out. It also relays the
  // detached window's "clear selection" back to the inspector here.
  const [aiOpen, setAiOpen] = useState(false);
  const {
    detachedOpen: aiDetached,
    openDetached: openAiWindow,
    closeDetached: closeAiWindow,
  } = useAiSession(aiChatEnabled, project?.path, handleClearAiSelection, () => setAiOpen(false));
  const hydratedOptimizedAssetsPathRef = useRef<string | null>(null);
  const [modalState, setModalState] = useState<ModalState>({ type: undefined });
  // Draggable width of the AI panel (like the inspector's own panels). Persisted globally.
  const [aiPanelWidth, setAiPanelWidth] = useState(readAiPanelWidth);
  const [aiResizing, setAiResizing] = useState(false);
  const [mobileQRData, setMobileQRData] = useState<{ url: string; qr: string } | null>(null);
  // When the Bevy renderer is selected the engine loads from a headless
  // sdk-commands realm, and the inspector shares its data-layer WS. We start it
  // for the project and hold the URLs to thread into the iframe config below.
  const useBevy = settings.renderer === RENDERER.BEVY;
  const [bevyRealm, setBevyRealm] = useState<{ url: string; wsUrl: string } | null>(null);
  // A broken scene (e.g. a TS error) makes the Bevy realm's `sdk-commands start`
  // fail, or the scene never finishes loading — leaving the editor stuck on the
  // loader with no way out. Capture the failure (or a load timeout) so the loading
  // screen can offer Back + Open code + the error message (#1380).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  const isOffline = status === ConnectionStatus.OFFLINE;
  const showDebugPanel = settings.previewOptions.debugger;

  useDebugLogForwarding(iframeRef, isPreviewRunning, showDebugPanel, project?.path);
  useMobileDebugForwarding(iframeRef, isPreviewRunning, project?.path);
  useBevyBuildForwarding(iframeRef, useBevy ? project?.path : undefined);

  const handleIframeRef = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement, Event>) => {
      const iframe = e.currentTarget;
      if (project) {
        if (iframeRef.current) {
          iframeRef.current.dispose();
          iframeRef.current = undefined;
        }
        const rpc = initRpc(iframe, project, { writeFile: updateScene });
        iframeRef.current = rpc;
        void rpc.scene.setFeatureFlags(featureFlags).catch(console.error);
      }
    },
    [project, updateScene, featureFlags],
  );

  const handleRefresh = useCallback(() => {
    const rpc = iframeRef.current;
    if (!rpc) return;
    const { iframe } = rpc;
    const { src } = iframe;
    rpc.dispose();
    iframeRef.current = undefined;
    iframe.src = src;
  }, []);

  useEffect(() => {
    const rpc = iframeRef.current;
    if (rpc) {
      void rpc.scene.setFeatureFlags(featureFlags).catch(console.error);
    }
  }, [featureFlags]);

  // Answer the AI assistant's `editor_screenshot` tool: main asks the renderer to capture
  // the viewport (only the renderer can reach the inspector iframe). Babylon renders its own
  // canvas via the scene RPC. That path returns null under Bevy (its wgpu canvas can't be
  // read via toDataURL, and the engine's /screenshot command may be unavailable), so fall
  // back to a compositor capture of just the viewport region: ask the inspector where the
  // viewport is inside its (cross-origin) iframe, offset by the iframe's position in this
  // window, and capturePage that rect in main — then downscale to the requested size (#1526).
  useEffect(() => {
    if (!aiChatEnabled) return;
    const { cleanup } = ai.onScreenshotRequest(async req => {
      const rpc = iframeRef.current;
      let dataUrl: string | null = null;
      try {
        if (rpc) dataUrl = await rpc.scene.takeScreenshot(req.width, req.height);
      } catch {
        dataUrl = null;
      }
      if (dataUrl === null && rpc) {
        const raw = await captureViewportFallback(rpc.iframe, rpc.scene);
        dataUrl = raw !== null ? await resizeImage(raw, req.width, req.height) : null;
      }
      ai.screenshotResult(req.id, dataUrl);
    });
    return cleanup;
  }, [aiChatEnabled]);

  // Answer the AI assistant's scene-mutation ops (Phase 2): main asks the renderer to run
  // an inspector SceneRpc mutation on the live engine, and we reply with the result. Only
  // the renderer holds the iframe RPC handle. Ops are serialized on the main side.
  useEffect(() => {
    if (!aiChatEnabled) return;
    const { cleanup } = ai.onSceneOpRequest(async req => {
      const rpc = iframeRef.current;
      const handler = SCENE_OP_HANDLERS[req.op];
      if (!rpc) return ai.sceneOpResult(req.id, false, 'No scene is open.');
      if (!handler) return ai.sceneOpResult(req.id, false, `Unknown scene op "${req.op}".`);
      try {
        const value = await handler(rpc.scene, req.params);
        ai.sceneOpResult(req.id, true, value);
      } catch (e) {
        ai.sceneOpResult(req.id, false, e instanceof Error ? e.message : String(e));
      }
    });
    return cleanup;
  }, [aiChatEnabled]);

  // While the AI panel is open, keep the assistant aware of the editor selection: poll the
  // inspector for the selected entities and mirror them into the ai store (shown as a composer
  // chip, attached as context on send). Cheap read; only runs while the panel is visible.
  // Rejects harmlessly under the Bevy renderer (no selection RPC) — selection just stays empty.
  useEffect(() => {
    // Poll while the chat is visible anywhere — inline or in the detached window (#1504).
    if (!aiOpen && !aiDetached) {
      dispatch(aiActions.setSelection([]));
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const rpc = iframeRef.current;
      if (!rpc) return;
      try {
        const { selected } = await rpc.scene.getSelection();
        if (!cancelled) dispatch(aiActions.setSelection(selected));
      } catch {
        /* Bevy renderer, or a transient miss — leave the last known selection */
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [aiOpen, aiDetached, dispatch]);

  useEffect(() => {
    if (isWorkspaceError(error, 'PROJECT_NOT_FOUND') || isProjectError(error)) {
      navigate('/scenes');
    }

    return () => {
      const rpc = iframeRef.current;
      if (rpc) {
        rpc.dispose();
        iframeRef.current = undefined;
      }
    };
  }, [error]);

  // converting for an optimized preview: the button shows progress + an inline cancel (✕)
  const isOptimizing = loadingPreview && !!previewProgress;

  // Start (or tear down) the Bevy realm as the renderer setting / project changes.
  // The iframe render is gated on the realm being ready when Bevy is selected, so
  // the inspector boots already pointed at the right data-layer + realm.
  const projectPath = project?.path;

  // Usage analytics: fire once each time the inline AI chat panel is opened. Anonymous project
  // id, matching the id space of the AI Turn events so "opened" and "used" correlate. Fires on
  // the false→true transition only (aiOpen starts false).
  useEffect(() => {
    if (!aiOpen || projectPath === undefined) return;
    void analytics
      .getProjectId(projectPath)
      .then(project_id => analytics.track('AI Chat Opened', { project_id }));
  }, [aiOpen, projectPath]);

  useEffect(() => {
    if (!projectPath || !useBevy) {
      setBevyRealm(null);
      return;
    }
    // Wait for dependency install to finish before starting the realm. On a
    // freshly created scene CH installs deps, then this effect fires — starting
    // `sdk-commands start` while node_modules is still being written fails with
    // "Could not find package.json for module @dcl/sdk-commands". Gating on
    // isInstallingProject (in the deps below) re-runs this once install completes,
    // and keeps the loader spinning (not the error screen) meanwhile.
    if (isInstallingProject) {
      setBevyRealm(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setLoadTimedOut(false);
    void startBevyRealm(projectPath)
      .then(realm => {
        if (!cancelled) setBevyRealm(realm ?? null);
      })
      .catch(error => {
        console.error('[Bevy] Failed to start realm:', error);
        if (!cancelled) {
          setBevyRealm(null);
          // Surface the failure so the loader shows Back + the error instead of
          // spinning forever. `sdk-commands start` rejects with the build error
          // line (see bevy-realm.ts waitFor) — show it.
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      void killBevyRealm(projectPath);
    };
  }, [projectPath, useBevy, isInstallingProject, startBevyRealm, killBevyRealm]);

  const isReady = !!project && inspectorPort > 0 && (!useBevy || bevyRealm !== null);

  // A load timeout backstop: even if the realm "starts", a broken scene can leave
  // the editor never becoming ready. After a grace period on the loader, offer the
  // same escape hatch (Back + Open code) rather than an infinite spinner. Don't run
  // the timer while deps are still installing — a fresh scene's npm install can
  // exceed the grace period and isn't a load failure.
  useEffect(() => {
    if (isReady || loadError || isInstallingProject) {
      setLoadTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setLoadTimedOut(true), 45_000);
    return () => clearTimeout(timer);
  }, [isReady, loadError, isInstallingProject, projectPath, useBevy]);

  const openModal = useCallback((type: ModalType, initialStep?: ModalState['initialStep']) => {
    setModalState({ type, initialStep });
  }, []);

  const handleOpenPreviewWithErrorHandling = useCallback(async () => {
    try {
      await openPreview(settings.previewOptions);
    } catch (error: any) {
      if (isClientNotInstalledError(error)) {
        setModalState({ type: 'install-client' });
      }
    }
  }, [openPreview, settings.previewOptions]);

  const handleActionWithWarningCheck = useCallback(
    async (action: () => void | Promise<void>) => {
      if (!settings.previewOptions.showWarnings) {
        await action();
        return;
      }

      const hasCustomCode = await detectCustomCode();

      if (hasCustomCode) {
        setModalState({
          type: 'warning',
          onContinue: action,
        });
        return;
      }

      await action();
    },
    [settings.previewOptions.showWarnings, detectCustomCode],
  );

  const handleBack = useCallback(async () => {
    const rpc = iframeRef.current;
    // Refresh the project (saves + regenerates the thumbnail) on the way out, but
    // never let it block navigation. The thumbnail is a screenshot over the scene
    // RPC — Babylon captures its canvas, Bevy captures via its engine's
    // `/screenshot` command; both are timeout-bounded and non-fatal, so a throw
    // or stall can't wedge Back.
    if (rpc) {
      try {
        await refreshProject(rpc);
      } catch (error) {
        console.error('[Editor] refreshProject on back failed:', error);
      }
    }
    killPreview();
    navigate('/scenes');
  }, [navigate, refreshProject, killPreview]);

  // Recover from the outdated-deps load error (#1457): update the scene's packages.
  // installProject toggles isInstallingProject, which re-runs the realm-start effect
  // once the install finishes — so the editor retries automatically with fresh deps.
  // Clear the error now so the loader shows the spinner instead of the error screen.
  const handleUpdateDependencies = useCallback(() => {
    if (!project) return;
    setLoadError(null);
    updatePackages(project);
  }, [project, updatePackages]);

  const handleOpenPublishModal = useCallback(async () => {
    await handleActionWithWarningCheck(() => openModal('publish'));
  }, [handleActionWithWarningCheck, openModal]);

  const handleCloseModal = useCallback(
    async (continued: boolean = false) => {
      setModalState({ type: undefined });
      if (continued && modalState.onContinue) {
        await modalState.onContinue();
      }
    },
    [modalState],
  );

  // Restore the per-project Optimize Assets preference when a project opens. Selecting the
  // toggle is inert — conversion only happens when Preview is pressed. Runs once per project
  // path so it never fights a live user toggle.
  useEffect(() => {
    if (!project) return;
    if (hydratedOptimizedAssetsPathRef.current === project.path) return;
    hydratedOptimizedAssetsPathRef.current = project.path;
    const persisted = settings.optimizedAssetsByPath?.[project.path] ?? false;
    if (persisted !== settings.previewOptions.optimizedAssets) {
      updateAppSettings({
        ...settings,
        previewOptions: { ...settings.previewOptions, optimizedAssets: persisted },
      });
    }
  }, [project?.path, settings, updateAppSettings]);

  const handleChangePreviewOptions = useCallback(
    (options: PreviewOptionsProps['options']) => {
      // Persist the choice per project so it comes back on next time this scene is opened
      // (restored by the effect above). Kept separate from the global previewOptions so
      // the preference never carries across projects. Selecting Optimize Assets is inert:
      // the conversion runs when Preview is pressed, with feedback on the Preview button.
      const optimizedAssetsByPath = project
        ? { ...settings.optimizedAssetsByPath, [project.path]: options.optimizedAssets }
        : settings.optimizedAssetsByPath;
      updateAppSettings({ ...settings, previewOptions: options, optimizedAssetsByPath });
    },
    [project, settings, updateAppSettings],
  );

  const handleCancelOptimizing = useCallback(() => {
    if (project) {
      // kill the converting spawn; the pending runScene settles without opening the client
      void dispatch(editorActions.cancelPreview(project.path));
    }
  }, [project, dispatch]);

  const handleShowMobileQR = useCallback(async () => {
    if (!project) return;

    try {
      const data = await getMobileQR(settings.previewOptions);
      if (data) {
        setMobileQRData(data);
      }
    } catch (error: unknown) {
      dispatch(
        snackbarActions.pushSnackbar(
          createGenericNotification('error', t('snackbar.generic.mobile_qr_failed')),
        ),
      );
    }
  }, [project, getMobileQR, settings.previewOptions, dispatch]);

  const handleCloseMobileQR = useCallback(() => {
    setMobileQRData(null);
  }, []);

  const handleOpenPreview = useCallback(async () => {
    await handleActionWithWarningCheck(handleOpenPreviewWithErrorHandling);
  }, [handleActionWithWarningCheck, handleOpenPreviewWithErrorHandling]);

  // The thumbnail comes from a screenshot over the scene RPC — Babylon captures
  // its canvas, Bevy captures via its engine's `/screenshot` command. Both are
  // timeout-guarded and non-fatal, so this can never hang or wedge the flow.
  const saveThumbnailIfSupported = useCallback(() => {
    const rpc = iframeRef.current;
    if (rpc) saveAndGetThumbnail(rpc);
  }, [saveAndGetThumbnail]);

  const handlePublishScene = useCallback(async () => {
    saveThumbnailIfSupported();
    await handleOpenPublishModal();
  }, [saveThumbnailIfSupported, handleOpenPublishModal]);

  const handleDeployWorld = useCallback(async () => {
    if (!project) return;
    saveThumbnailIfSupported();
    try {
      await publishScene({ targetContent: config.get('WORLDS_CONTENT_SERVER_URL') });
      executeDeployment(project.path);
    } catch {
      openModal('publish', 'deploy');
    }
  }, [project, saveThumbnailIfSupported, publishScene, executeDeployment, openModal]);

  const handleDeployLand = useCallback(async () => {
    if (!project) return;
    saveThumbnailIfSupported();
    try {
      await publishScene({ target: config.get('PEER_URL') });
      executeDeployment(project.path);
    } catch {
      openModal('publish', 'deploy');
    }
  }, [project, saveThumbnailIfSupported, publishScene, executeDeployment, openModal]);

  const publishOptions = useMemo(
    () =>
      getPublishOptions({
        project,
        isDeploying,
        actions: {
          onPublishScene: handlePublishScene,
          onDeployWorld: handleDeployWorld,
          onDeployLand: handleDeployLand,
        },
      }),
    [project, isDeploying, handlePublishScene, handleDeployWorld, handleDeployLand],
  );

  // inspector url
  const htmlUrl = `http://localhost:${import.meta.env.VITE_INSPECTOR_PORT || inspectorPort}`;
  let binIndexJsUrl = `${htmlUrl}/bin/index.js`;

  // query params
  const params = new URLSearchParams();

  // Always tell the inspector which renderer to use, so IT doesn't offer an
  // independent (un-plumbed) choice via its own toolbar picker — the host owns
  // renderer selection and supplies each renderer's config. Without this, picking
  // Bevy inside the inspector mounts the engine with no realm and boots the wrong
  // (default) world.
  params.append('renderer', useBevy ? RENDERER.BEVY : RENDERER.BABYLON);

  params.append('uiEditorEnabled', String(settings.guiEditor));
  params.append('uiEditorSupported', String(supportsUiDesigner));

  // The parent-window scene-RPC control channel (host↔inspector feature flags,
  // notifications, file/dir open) is wired whenever this is set — for BOTH
  // renderers. Babylon also uses it as its data-layer transport; Bevy instead
  // uses the realm WS (set below, which takes precedence), but still needs this
  // channel or the host's feature flags never reach it (e.g. SceneMinimap).
  params.append('dataLayerRpcParentUrl', window.location.origin);

  if (useBevy && bevyRealm) {
    // Bevy editor: the inspector shares the realm's data-layer WS so entity ids
    // align with the engine (forward edits land on the right entities), and the
    // engine loads the scene from the realm. `dataLayerRpcWsUrl` takes precedence
    // over `dataLayerRpcParentUrl` in the inspector, so we set the WS instead of
    // the parent-window data-layer here.
    params.append('dataLayerRpcWsUrl', bevyRealm.wsUrl);
    params.append('bevyRealm', bevyRealm.url);
    if (project) {
      // The engine loads the scene at its real parcel; the base coord is bevyPosition.
      params.append('bevyPosition', project.scene.base);
    }
    // The super-user editor-agent portable experience (viewport pick + gizmo),
    // shipped as a static realm at public/bevy-agent and served same-origin by the
    // inspector http-server. The engine loads it as a realm (GETs
    // `<systemScene>/about`); the export nests `<realmName>/about`, hence the
    // doubled path segment. A dev server can override via VITE_BEVY_SYSTEM_SCENE.
    params.append(
      'bevySystemScene',
      import.meta.env.VITE_BEVY_SYSTEM_SCENE || `${htmlUrl}/bevy-agent/bevy-agent`,
    );
  }

  if (import.meta.env.VITE_ASSET_PACKS_CONTENT_URL) {
    // this is for local development of the asset-packs repo, or to use a different environment like .zone
    params.append('contentUrl', import.meta.env.VITE_ASSET_PACKS_CONTENT_URL);
  }

  if (import.meta.env.VITE_ASSET_PACKS_JS_PORT && import.meta.env.VITE_ASSET_PACKS_JS_PATH) {
    // this is for local development of the asset-packs repo
    const b64 = btoa(import.meta.env.VITE_ASSET_PACKS_JS_PATH);
    binIndexJsUrl = `http://localhost:${import.meta.env.VITE_ASSET_PACKS_JS_PORT}/content/contents/b64-${b64}`;
  }

  // this is the asset-packs javascript file
  params.append('binIndexJsUrl', binIndexJsUrl);

  // these are analytics related
  if (import.meta.env.VITE_SEGMENT_INSPECTOR_API_KEY) {
    params.append('segmentKey', import.meta.env.VITE_SEGMENT_INSPECTOR_API_KEY);
  }

  // analytics
  params.append('segmentAppId', 'creator-hub');
  if (userId) {
    params.append('segmentUserId', userId);
  }
  if (project) {
    params.append('projectId', project.id);
    params.append('uiDesignerOpen', String(project.info.uiDesignerOpen ?? false));
  }

  const iframeUrl = `${htmlUrl}?${params}`;

  // Drag the divider on the AI panel's left edge to resize it. A transparent overlay covers
  // the iframe while dragging so it doesn't swallow the mouse-move events.
  const startAiResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setAiResizing(true);
    const onMove = (ev: MouseEvent) =>
      setAiPanelWidth(clampAiPanelWidth(window.innerWidth - ev.clientX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setAiResizing(false);
      setAiPanelWidth(w => {
        try {
          localStorage.setItem(AI_PANEL_WIDTH_KEY, String(w));
        } catch {
          /* storage unavailable — non-fatal */
        }
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const renderLoading = () => {
    // Recoverable stuck-load state (#1380): the realm failed to start (broken code)
    // or the scene never finished loading. Offer Back + Open code + the error,
    // instead of an infinite spinner with no way out.
    const stuck = loadError !== null || loadTimedOut;
    if (stuck) {
      // An outdated-deps failure has a clear fix (Update dependencies), so show a
      // friendly message + an update action instead of the raw CLI dump (#1457).
      const outdatedDeps = loadError !== null && isOutdatedDepsError(loadError);
      return (
        <div className="loading loading-error">
          <img src={EditorPng} />
          <div className="loading-error-title">{t('editor.loading.failed.title')}</div>
          <div className="loading-error-message">
            {outdatedDeps
              ? t('editor.loading.failed.outdated_deps')
              : (loadError ?? t('editor.loading.failed.timeout'))}
          </div>
          <Row>
            <Button
              color="secondary"
              startIcon={<ArrowBackIosIcon />}
              onClick={handleBack}
            >
              {t('editor.loading.failed.back')}
            </Button>
            {outdatedDeps ? (
              <Button
                color="primary"
                startIcon={<RefreshIcon />}
                onClick={handleUpdateDependencies}
              >
                {t('editor.loading.failed.update_deps')}
              </Button>
            ) : (
              <Button
                color="secondary"
                startIcon={<CodeIcon />}
                onClick={openCode}
              >
                {t('editor.header.actions.code')}
              </Button>
            )}
          </Row>
        </div>
      );
    }
    return (
      <div className="loading">
        <img src={EditorPng} />
        <Row>
          <Loader />
          {/* Tell the user WHY the load is taking longer when we're installing a
              scene's dependencies (e.g. opening a scene whose node_modules was
              deleted, #1425) — otherwise a long npm install looks like a hang. */}
          {isInstallingProject ? t('editor.loading.installing') : t('editor.loading.title')}
        </Row>
      </div>
    );
  };

  const previewIcon = loadingPreview ? <Loader size={20} /> : <PlayCircleIcon />;

  return (
    <main className="Editor">
      {!isReady ? (
        renderLoading()
      ) : (
        <>
          <Header hideUserMenu>
            <>
              <div
                className="back"
                onClick={handleBack}
              >
                <ArrowBackIosIcon />
              </div>
              <div className="title">{project.title}</div>
              <Tooltip title={t('editor.header.actions.refresh')}>
                <div
                  className="refresh"
                  onClick={handleRefresh}
                  aria-label="refresh-inspector"
                >
                  <RefreshIcon />
                </div>
              </Tooltip>
            </>
            <div className="actions">
              {aiChatEnabled && (
                <Tooltip title={aiOpen ? t('editor.ai.close') : t('editor.ai.open')}>
                  <IconButton
                    className={`ai-toggle${aiOpen ? ' active' : ''}`}
                    aria-label={aiOpen ? t('editor.ai.close') : t('editor.ai.open')}
                    onClick={() => setAiOpen(open => !open)}
                  >
                    <AssistantIcon gradient={!aiOpen} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title={t('editor.header.actions.optimize')}>
                <Button
                  className="icon-only"
                  color="secondary"
                  aria-label={t('editor.header.actions.optimize')}
                  onClick={() => dispatch(optimizerActions.open())}
                >
                  <SpeedOutlinedIcon />
                </Button>
              </Tooltip>
              <Tooltip title={t('editor.header.actions.code')}>
                <Button
                  className="icon-only"
                  color="secondary"
                  aria-label={t('editor.header.actions.code')}
                  onClick={openCode}
                >
                  <CodeIcon />
                </Button>
              </Tooltip>
              <div className={isOptimizing ? 'preview-control optimizing' : 'preview-control'}>
                <ButtonGroup
                  className={isOptimizing ? undefined : 'icon-only'}
                  color="secondary"
                  aria-label={t('editor.header.actions.preview')}
                  tooltip={t('editor.header.actions.preview')}
                  extraTooltip={t('editor.header.actions.preview_options.title')}
                  // Not natively disabled while optimizing (that would kill the inline ✕ too):
                  // the group is greyed and made inert via CSS, and only the ✕ stays clickable.
                  // aria-disabled flags the CSS-inert state to assistive tech, which the visual
                  // greying and pointer-events:none don't convey on their own.
                  aria-disabled={isOptimizing || undefined}
                  disabled={
                    (loadingPreview && !isOptimizing) ||
                    isInstallingProject ||
                    isDetectingCustomCode ||
                    isOffline
                  }
                  onClick={isOptimizing ? undefined : handleOpenPreview}
                  // icon-only at rest (the icon IS the content); while optimizing the icon moves
                  // to startIcon so the progress label can sit beside it
                  startIcon={isOptimizing ? previewIcon : undefined}
                  extra={
                    <PreviewOptions
                      options={settings.previewOptions}
                      onChange={handleChangePreviewOptions}
                      onShowMobileQR={handleShowMobileQR}
                      supportsMultiInstance={supportsMultiInstance}
                      supportsMcp={supportsMcp}
                      projectPath={project.path}
                    />
                  }
                >
                  {isOptimizing ? (
                    <span className="optimizing-label">
                      {t('editor.header.actions.optimizing')}
                      {previewProgress?.total
                        ? ` ${Math.round(((previewProgress.done ?? 0) / previewProgress.total) * 100)}%`
                        : ''}
                      <Tooltip title={t('editor.header.actions.cancel_optimizing')}>
                        {/* a real button so the only live control in the CSS-inert group
                            stays reachable by keyboard and assistive tech */}
                        <IconButton
                          className="cancel-optimizing"
                          size="small"
                          aria-label={t('editor.header.actions.cancel_optimizing')}
                          // a cancel is already in flight (main is killing the spawn)
                          disabled={previewCancelled}
                          onClick={e => {
                            e.stopPropagation();
                            handleCancelOptimizing();
                          }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </span>
                  ) : (
                    previewIcon
                  )}
                </ButtonGroup>
              </div>
              {publishOptions.length > 0 ? (
                <ButtonGroup
                  color="primary"
                  extraTooltip={t('editor.header.actions.publish_options.title')}
                  disabled={
                    loadingPublish || isInstallingProject || isDetectingCustomCode || isOffline
                  }
                  onClick={() => {
                    if (deployment?.status === 'pending') {
                      openModal('publish', 'deploy');
                    } else {
                      handlePublishScene();
                    }
                  }}
                  startIcon={isDeploying ? <Loader size={20} /> : <PublicIcon />}
                  extra={<PublishOptions options={publishOptions} />}
                >
                  {publishButtonText}
                </ButtonGroup>
              ) : (
                <Button
                  color="primary"
                  disabled={
                    loadingPublish || isInstallingProject || isDetectingCustomCode || isOffline
                  }
                  onClick={handlePublishScene}
                  startIcon={isDeploying ? <Loader size={20} /> : <PublicIcon />}
                >
                  {publishButtonText}
                </Button>
              )}
              <ConnectionStatusIndicator />
            </div>
          </Header>
          <div className="EditorBody">
            <iframe
              className="inspector"
              src={iframeUrl}
              onLoad={handleIframeRef}
              // Grant cross-origin isolation to the inspector iframe so the Bevy
              // engine (nested one level deeper) can use SharedArrayBuffer. The
              // renderer document + inspector server carry COOP/COEP, but a
              // cross-origin child frame only becomes crossOriginIsolated when the
              // embedder explicitly delegates it via this Permissions-Policy. Inert
              // for the Babylon renderer.
              allow="cross-origin-isolated"
            ></iframe>
            {aiChatEnabled && aiOpen && (
              <>
                {aiResizing && <div className="ai-resize-overlay" />}
                <div
                  className="ai-resize-handle"
                  onMouseDown={startAiResize}
                  role="separator"
                  aria-orientation="vertical"
                />
                {aiDetached ? (
                  <DetachedPlaceholder
                    onDock={closeAiWindow}
                    width={aiPanelWidth}
                  />
                ) : (
                  <AiChatPanel
                    onClose={() => setAiOpen(false)}
                    onPopOut={openAiWindow}
                    onClearSelection={handleClearAiSelection}
                    width={aiPanelWidth}
                  />
                )}
              </>
            )}
          </div>
          <DeployModal
            type={modalState.type}
            project={project}
            onClose={handleCloseModal}
            initialStep={modalState.initialStep}
          />
          <OptimizeModal project={project} />
          {mobileQRData && (
            <MobileQRCode
              open={!!mobileQRData}
              onClose={handleCloseMobileQR}
              url={mobileQRData.url}
              qr={mobileQRData.qr}
            />
          )}
        </>
      )}
    </main>
  );
}
