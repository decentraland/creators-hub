import { AI_STREAM_EVENT } from '/shared/types/ipc';
import { handle, handleSync } from './handle';
import * as electron from './electron';
import * as updater from './updater';
import * as inspector from './inspector';
import * as bevyRealm from './bevy-realm';
import * as cli from './cli';
import * as bin from './bin';
import * as code from './code';
import * as analytics from './analytics';
import * as npm from './npm';
import * as config from './config';
import * as mobileDebug from './mobile-debug-server';
import * as oxc from './oxc';
import * as metrics from './metrics';
import * as ai from './ai';
import * as aiCli from './ai-cli';
import * as aiWindow from './ai-window';
import {
  captureViewport,
  ensureSceneMcpServer,
  resolveEditorScreenshot,
  resolveSceneOp,
  resolveUserPrompt,
  revertTurn,
} from './scene-mcp';
import * as optimizer from './optimizer';

interface InitIpcOptions {
  beforeQuitCleanup: () => Promise<void>;
}

export function initIpc({ beforeQuitCleanup }: InitIpcOptions) {
  // electron
  handleSync('electron.getEnvOverride', () => electron.getEnvOverride());
  handle('electron.getAppVersion', () => electron.getAppVersion());
  handle('electron.getUserDataPath', () => electron.getUserDataPath());
  handle('electron.getWorkspaceConfigPath', (_event, path) =>
    electron.getWorkspaceConfigPath(path),
  );
  handle('electron.showOpenDialog', (_event, opts) => electron.showOpenDialog(opts));
  handle('electron.openExternal', (_event, url) => electron.openExternal(url));
  handle('electron.copyToClipboard', (_event, text) => electron.copyToClipboard(text));

  // analytics API (fetched here because the renderer's `Origin: null` fails CORS)
  handle('metrics.request', (_event, request) => metrics.request(request));

  // updater
  handle('updater.checkForUpdates', (_event, config) => updater.checkForUpdates(config));
  handle('updater.quitAndInstall', (_event, version) =>
    updater.quitAndInstall(version, beforeQuitCleanup),
  );
  handle('updater.downloadUpdate', () => updater.downloadUpdate());
  handle('updater.setupUpdaterEvents', event => updater.setupUpdaterEvents(event));
  handle('updater.getInstalledVersion', () => updater.getInstalledVersion());
  handle('updater.deleteVersionFile', () => updater.deleteVersionFile());
  handle('updater.getReleaseNotes', (_event, version) => updater.getReleaseNotes(version));

  // inspector
  handle('inspector.start', () => inspector.start());
  handle('inspector.attachSceneDebugger', (_event, path) => inspector.attachSceneDebugger(path));
  handle('inspector.detachSceneDebugger', (_event, path) => inspector.detachSceneDebugger(path));

  // bevy realm (headless sdk-commands server feeding the embedded Bevy editor engine)
  handle('bevyRealm.start', (_event, path) => bevyRealm.start(path));
  handle('bevyRealm.kill', (_event, path) => bevyRealm.kill(path));

  // cli
  handle('cli.init', (_event, path, repo) => cli.init(path, repo));
  handle('cli.start', (_event, path, opts, mobile) => cli.start(path, { ...opts, mobile }));
  handle('cli.deploy', (_event, opts) => cli.deploy(opts));
  handle('cli.killPreview', (_event, path) => cli.killPreview(path));
  handle('cli.cancelPreview', (_event, path) => cli.cancelPreview(path));
  handle('cli.supportsAssetBundles', (_event, path) => cli.supportsAssetBundles(path));
  handle('cli.getMobilePreview', (_event, path) => cli.getMobilePreview(path));

  // mobile debug session
  handle('mobileDebug.getSessions', async () => mobileDebug.getMobileDebugSessionInfos());
  handle('mobileDebug.subscribeEntries', async event => {
    mobileDebug.subscribeEntries(event.sender);
  });
  handle('mobileDebug.unsubscribeEntries', async event => {
    mobileDebug.unsubscribeEntries(event.sender);
  });
  handle('mobileDebug.subscribeSessions', async event => {
    mobileDebug.subscribeSessions(event.sender);
  });
  handle('mobileDebug.unsubscribeSessions', async event => {
    mobileDebug.unsubscribeSessions(event.sender);
  });
  handle(
    'mobileDebug.broadcastCommand',
    async (_event, cmd: string, args: Record<string, unknown>) =>
      mobileDebug.broadcastCommand(cmd, args),
  );
  handle('mobileDebug.startServer', async () => {
    const serverPort = await mobileDebug.startMobileDebugServer();
    return { port: serverPort };
  });
  handle('mobileDebug.stopServer', async () => mobileDebug.stopMobileDebugServer());
  handle('mobileDebug.getServerStatus', async () => mobileDebug.getMobileDebugServerStatus());
  handle('mobileDebug.getStandaloneDeeplink', async () => mobileDebug.getStandaloneDeeplink());

  // config
  handle('config.getConfig', () => config.getConfig());
  handle('config.writeConfig', (_event, _config) => config.writeConfig(_config));

  // bin
  handle('bin.install', () => bin.install());

  // code settings
  handle('code.open', (_event, path) => code.open(path));
  handle('code.getEditors', () => code.getEditors());
  handle('code.addEditor', (_event, path) => code.addEditor(path));
  handle('code.setDefaultEditor', (_event, path) => code.setDefaultEditor(path));
  handle('code.removeEditor', (_event, path) => code.removeEditor(path));

  // analytics
  handle('analytics.track', (_event, eventName, data) => analytics.track(eventName, data!));
  handle('analytics.identify', (_event, userId, traits) => analytics.identify(userId, traits));
  handle('analytics.getAnonymousId', () => analytics.getAnonymousId());
  handle('analytics.getProjectId', (_event, path) => analytics.getProjectId(path));

  // npm
  handle('npm.install', (_event, path, packages) => npm.install(path, packages));
  handle('npm.getOutdatedDeps', (_event, path, packages) => npm.getOutdatedDeps(path, packages));
  handle('npm.getContextFiles', (_event, path) => npm.getContextFiles(path));

  handle('oxc.parse', (_event, filename, source) => oxc.parse(filename, source));

  // ai assistant — `ai.send` streams AiEvents back to the calling WebContents over
  // AI_STREAM_EVENT; the returned turnId lets the renderer correlate the stream.
  handle('ai.detectProviders', () => ai.detectProviders());
  handle('ai.send', async (event, path, params) => {
    const sender = event.sender;
    return ai.aiSend(params, path, e => {
      if (!sender.isDestroyed()) sender.send(AI_STREAM_EVENT, e);
    });
  });
  handle('ai.stop', async () => ai.aiStop());
  handle('ai.reset', async (_event, path) => ai.aiReset(path));
  handle('ai.deleteSession', async (_event, path, sessionId) =>
    ai.aiDeleteSession(path, sessionId),
  );
  handle('ai.isBusy', async () => ai.aiBusy());
  // AI sign-in without a CLI (#1531): install the official CLI on demand + drive its
  // subscription login; steps stream over AI_CLI_LOGIN_EVENTS.
  handle('ai.signInCli', (_event, provider) => aiCli.signInCli(provider));
  handle('ai.cancelSignInCli', () => aiCli.cancelSignInCli());
  handle('ai.signOutCli', (_event, provider) => aiCli.signOutCli(provider));
  handle('ai.getCliState', async () => aiCli.getCliState());
  handle('ai.screenshotResult', (_event, id, dataUrl) => resolveEditorScreenshot(id, dataUrl));
  handle('ai.captureViewport', (_event, rect) => captureViewport(rect));
  handle('ai.sceneOpResult', (_event, id, ok, payload) => resolveSceneOp(id, ok, payload));
  handle('ai.askResult', (_event, id, answer) => resolveUserPrompt(id, answer));
  handle('ai.revertTurn', (_event, count) => revertTurn(count));
  // Reveal the CH MCP server's URL + token so an external agent can register it (gated in
  // the UI behind the exposeMcpServer setting). Starts the server if it isn't up yet.
  handle('ai.getMcpServerInfo', async () => {
    const { url, token } = await ensureSceneMcpServer();
    return { url, token };
  });
  // Detached AI window (#1504): lifecycle + the mirror/command relay between the two
  // renderer windows (see ai-window.ts).
  handle('ai.openWindow', (_event, locale) => aiWindow.openAiWindow(locale));
  handle('ai.closeWindow', async () => aiWindow.closeAiWindow());
  handle('ai.isWindowOpen', async () => aiWindow.isAiWindowOpen());
  handle('ai.mirrorPush', (_event, state) => aiWindow.pushMirrorState(state));
  handle('ai.remoteCommand', (_event, command) => aiWindow.forwardRemoteCommand(command));
  // optimizer (model/texture optimization)
  handle('optimizer.scan', (_event, path) => optimizer.scan(path));
  handle('optimizer.run', (_event, path, options) => optimizer.run(path, options));
  handle('optimizer.revert', (_event, path) => optimizer.revert(path));
  handle('optimizer.tools', () => optimizer.tools());
  handle('optimizer.installTools', (_event, path) => optimizer.installTools(path));
}
