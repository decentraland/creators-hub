import type { OpenDialogOptions } from 'electron';

import type { Outdated } from '/shared/types/npm';
import type { Events } from '/shared/types/analytics';
import type { DeployOptions } from '/shared/types/deploy';

import type { PreviewOptions, ReleaseNotes } from './settings';
import type { Config, EditorConfig } from './config';
import type { Env } from './env';
import type { OxcParseResult } from './oxc';
import type { MetricsRequest, MetricsResponse } from './metrics';
import type {
  AiMirrorState,
  AiProvider,
  AiProviderInfo,
  AiRemoteCommand,
  AiSendParams,
} from './ai';
import type {
  OptimizeOptions,
  OptimizeResult,
  OptimizeScanResult,
  OptimizeToolsInfo,
} from './optimizer';

export type IpcResult<T> = {
  success: true;
  value: T;
};
export type IpcError = {
  success: false;
  error: {
    message: string;
    name: string;
  };
};

// Asset-conversion progress pushed from main to the renderer while a preview spawn is
// converting. Shared here because preload subscribes to the channel and cannot import
// from main, so the event name and payload shape must have a single home.
export const PREVIEW_PROGRESS_EVENT = 'preview.progress';

export type PreviewProgress = { seconds: number; done?: number; total?: number };

// AI assistant turn events pushed from main to the renderer chat panel while a turn
// runs. Shared here for the same reason as PREVIEW_PROGRESS_EVENT: preload subscribes
// to the channel and cannot import from main, so the event name and payload shape
// need a single home.
export const AI_STREAM_EVENT = 'ai.stream';

// The `editor_screenshot` MCP tool lives in main, but only the renderer can capture the
// inspector iframe (via SceneRpcClient). Main pushes a request over this channel; the
// renderer answers by invoking `ai.screenshotResult`, correlated by `id`.
export const AI_SCREENSHOT_REQUEST = 'ai.screenshotRequest';

export type AiScreenshotRequest = { id: string; width: number; height: number };

// Scene build events from the Bevy realm's `sdk-commands start` (main → renderer → the
// inspector's Bevy renderer). The realm's bundler names every file that triggers a rebuild
// and reports when the bundle lands; the editor uses that to tell an IDE code edit (reload)
// from its own autosave (no reload). Shared for the same reason as the events above.
export const BEVY_REALM_BUILD_EVENT = 'bevyRealm.build';

export type SceneBuildEvent = { kind: 'rebuild'; file: string } | { kind: 'bundle-saved' };

export type BevyRealmBuildEvent = SceneBuildEvent & { path: string };

// Scene-graph mutation ops (AI assistant, Phase 2) run in the inspector iframe via its
// SceneRpc. Main pushes an op request over this channel; the renderer routes it to the
// SceneRpcClient and answers with `ai.sceneOpResult`, correlated by `id`. `op` is the
// SceneRpc mutation name (e.g. 'create_entity'); `params` its arguments.
export const AI_SCENE_OP_REQUEST = 'ai.sceneOpRequest';

export type AiSceneOpRequest = { id: string; op: string; params: Record<string, unknown> };

// Interactive user prompt (AI assistant): the `ask_user` MCP tool lives in main, but only the
// user can answer. Main pushes the question over this channel; the renderer renders an
// interactive prompt in the transcript and answers with `ai.askResult`, correlated by `id`.
// A null answer means the user dismissed it (or the turn was stopped before they chose).
export const AI_ASK_REQUEST = 'ai.askRequest';

export type AiAskOption = { label: string; description?: string };
export type AiAskRequest = {
  id: string;
  question: string;
  options: AiAskOption[]; // empty ⇒ free-text only
  multiSelect: boolean;
  allowOther: boolean; // offer a free-text answer alongside the options
};

// Detached AI window (#1504). The main window mirrors its `ai` slice to the detached
// window over AI_MIRROR_STATE; the detached window's actions come back over
// AI_REMOTE_COMMAND (main relays them to the main window). AI_WINDOW_STATE tells the
// main window whether the detached window is currently open, so it can show the inline
// panel or a "opened in a separate window" placeholder. All are relayed via main.
export const AI_MIRROR_STATE = 'ai.mirrorState';
export const AI_REMOTE_COMMAND = 'ai.remoteCommand';
export const AI_WINDOW_STATE = 'ai.windowState';

export type AiWindowState = { open: boolean };

// AI sign-in without a pre-installed CLI (#1531). Users with a Claude/ChatGPT subscription
// who never installed a CLI can sign in from the setup panel: main installs the official CLI
// into an app-managed dir (using the bundled Node) and drives its own subscription login
// (`claude setup-token` / `codex login`). `ai.signInCli` runs install-if-needed + login,
// streaming its steps — progress messages and the browser URL to open — over this channel.
export const AI_CLI_LOGIN_EVENTS = 'ai.cliLogin';

export type AiCliLoginEvent = { type: 'progress'; message: string } | { type: 'auth'; url: string };

// Per-provider setup state for the managed (app-installed) CLIs.
export type AiCliState = Record<AiProvider, { installed: boolean; signedIn: boolean }>;

export interface MobileDebugSessionInfo {
  id: number;
  sessionId: string | null;
  deviceName: string | null;
  connectedAt: string;
  disconnectedAt: string | null;
  status: 'active' | 'ended';
  messageCount: number;
}

export interface MobileDebugBroadcastResult {
  ok: boolean;
  results: { sessionId: number; ok: boolean; data: unknown }[];
}

export interface Ipc {
  'electron.getEnvOverride': () => Env | null;
  'electron.getUserDataPath': () => string;
  'electron.getAppVersion': () => Promise<string>;
  'updater.getDownloadedVersion': () => string | null;
  'updater.setupUpdaterEvents': () => void;
  'updater.checkForUpdates': (config?: { autoDownload?: boolean }) => Promise<{
    updateAvailable: boolean;
    error?: any;
    version: string | null;
  }>;
  'updater.downloadProgress': (progress: number) => void;
  'updater.quitAndInstall': (version: string) => Promise<void>;
  'updater.getInstalledVersion': () => Promise<string | undefined>;
  'updater.deleteVersionFile': () => Promise<void>;
  'updater.downloadUpdate': () => Promise<any>;
  'updater.getReleaseNotes': (version: string) => Promise<ReleaseNotes | undefined>;
  'electron.getWorkspaceConfigPath': (path: string) => Promise<string>;
  'electron.showOpenDialog': (opts: Partial<OpenDialogOptions>) => Promise<string[]>;
  'electron.openExternal': (url: string) => Promise<void>;
  'electron.copyToClipboard': (text: string) => Promise<void>;
  'oxc.parse': (filename: string, source: string) => Promise<OxcParseResult>;
  'optimizer.scan': (path: string) => Promise<OptimizeScanResult>;
  'optimizer.run': (path: string, options: OptimizeOptions) => Promise<OptimizeResult>;
  'optimizer.revert': (path: string) => Promise<{ restored: number }>;
  'optimizer.tools': () => Promise<OptimizeToolsInfo>;
  'optimizer.installTools': (path: string) => Promise<OptimizeToolsInfo>;
  'metrics.request': (request: MetricsRequest) => Promise<MetricsResponse>;
  'inspector.start': () => Promise<number>;
  'inspector.attachSceneDebugger': (path: string) => Promise<string>;
  'inspector.detachSceneDebugger': (path: string) => void;
  'bevyRealm.start': (path: string) => Promise<{ url: string; wsUrl: string }>;
  'bevyRealm.kill': (path: string) => Promise<void>;
  'config.getConfig': () => Promise<Config>;
  'config.writeConfig': (config: Config) => Promise<void>;
  'bin.install': () => Promise<void>;

  'code.open': (path: string) => Promise<void>;
  'code.getEditors': () => Promise<EditorConfig[]>;
  'code.addEditor': (path: string) => Promise<EditorConfig[]>;
  'code.setDefaultEditor': (path: string) => Promise<EditorConfig[]>;
  'code.removeEditor': (path: string) => Promise<EditorConfig[]>;

  'cli.init': (path: string, repo: string) => Promise<void>;
  'cli.start': (path: string, opts: PreviewOptions, mobile?: boolean) => Promise<string>;
  'cli.cancelPreview': (path: string) => Promise<void>;
  'cli.supportsAssetBundles': (path: string) => Promise<boolean>;
  'cli.deploy': (opts: DeployOptions) => Promise<number>;
  'cli.killPreview': (path: string) => Promise<void>;
  'cli.getMobilePreview': (path: string) => Promise<{ url: string; qr: string } | null>;
  'analytics.track': <T extends keyof Events>(event: T, data?: Events[T]) => void;
  'analytics.identify': (userId: string, traits?: Record<string, any>) => void;
  'analytics.getAnonymousId': () => Promise<string>;
  'analytics.getProjectId': (path: string) => Promise<string>;
  'npm.install': (path: string, packages?: string[]) => Promise<void>;
  'npm.getOutdatedDeps': (path: string, packages?: string[]) => Promise<Outdated>;
  'npm.getContextFiles': (path: string) => Promise<void>;

  // AI scene assistant. `ai.send` streams its result over AI_STREAM_EVENT (payload
  // AiEvent) to the calling WebContents; the returned turnId correlates the stream.
  'ai.detectProviders': () => Promise<AiProviderInfo[]>;
  'ai.send': (path: string, params: AiSendParams) => Promise<{ turnId: string }>;
  'ai.stop': () => Promise<void>;
  'ai.reset': (path?: string) => Promise<void>;
  // Drop one saved session's provider resume ids (deleting it from the scene's history).
  'ai.deleteSession': (path: string, sessionId: string) => Promise<void>;
  'ai.isBusy': () => Promise<boolean>;
  // Revert the scene-graph changes an AI turn made, by undoing `count` steps (the value
  // the `done` event reported as `mutations`).
  'ai.revertTurn': (count: number) => Promise<void>;
  'ai.getMcpServerInfo': () => Promise<{ url: string; token: string }>;
  // AI sign-in without a CLI (#1531). signInCli installs the official CLI (if needed) and
  // drives its subscription login, streaming steps over AI_CLI_LOGIN_EVENTS; signOutCli
  // clears the managed sign-in; getCliState reports install/sign-in status per provider.
  'ai.signInCli': (provider: AiProvider) => Promise<void>;
  'ai.cancelSignInCli': () => Promise<void>;
  'ai.signOutCli': (provider: AiProvider) => Promise<void>;
  'ai.getCliState': () => Promise<AiCliState>;
  // Renderer's answer to an AI_SCREENSHOT_REQUEST: the captured image as a data URL, or
  // null if the capture failed (e.g. the Bevy renderer, which has no screenshot RPC).
  'ai.screenshotResult': (id: string, dataUrl: string | null) => void;
  // Compositor capture of a window region as a PNG data URL, used as the editor-screenshot
  // fallback for renderers whose canvas can't be read via toDataURL (Bevy's wgpu). Rect is
  // in the renderer window's CSS px; returns null if the window is gone or the capture fails.
  'ai.captureViewport': (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  // Renderer's answer to an AI_SCENE_OP_REQUEST: ok + the op's result value, or the error
  // message when the mutation failed (or no scene is loaded).
  'ai.sceneOpResult': (id: string, ok: boolean, payload: unknown) => void;
  // User's answer to an AI_ASK_REQUEST (the `ask_user` tool): the chosen answer as text, or
  // null when dismissed / the turn ended. Unblocks the pending MCP tool call.
  'ai.askResult': (id: string, answer: string | null) => void;
  // Detached AI window (#1504). openWindow/closeWindow manage the separate OS window;
  // `locale` seeds its i18n. mirrorPush (main window → main → detached) and remoteCommand
  // (detached → main → main window) carry the mirrored state and the user's actions.
  'ai.openWindow': (locale?: string) => Promise<void>;
  'ai.closeWindow': () => Promise<void>;
  'ai.isWindowOpen': () => Promise<boolean>;
  'ai.mirrorPush': (state: AiMirrorState) => void;
  'ai.remoteCommand': (command: AiRemoteCommand) => void;
  'mobileDebug.getSessions': () => Promise<MobileDebugSessionInfo[]>;
  'mobileDebug.subscribeEntries': () => Promise<void>;
  'mobileDebug.unsubscribeEntries': () => Promise<void>;
  'mobileDebug.subscribeSessions': () => Promise<void>;
  'mobileDebug.unsubscribeSessions': () => Promise<void>;
  'mobileDebug.broadcastCommand': (
    cmd: string,
    args: Record<string, unknown>,
  ) => Promise<MobileDebugBroadcastResult>;
  'mobileDebug.startServer': () => Promise<{ port: number }>;
  'mobileDebug.stopServer': () => Promise<void>;
  'mobileDebug.getServerStatus': () => Promise<{
    running: boolean;
    port: number | null;
    sessions: number;
  }>;
  'mobileDebug.getStandaloneDeeplink': () => Promise<{
    url: string;
    qr: string;
    port: number;
  }>;
}
