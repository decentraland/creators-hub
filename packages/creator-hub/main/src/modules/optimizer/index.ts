import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';

import {
  OPTIMIZE_PROGRESS_EVENT,
  type OptimizeOptions,
  type OptimizeProgress,
  type OptimizeResult,
  type OptimizeToolsInfo,
  type OptimizeWorkerJob,
} from '/shared/types/optimizer';

import { MAIN_WINDOW_ID } from '../../mainWindow';
import { StreamError, run as runBin } from '../bin';
import { resolveNodeRuntime } from '../node-runtime';
import { getWindow } from '../window';
import { readManifest, revertFromManifest } from './backup';
import { createWorkerOutputReader } from './protocol';
import { scan } from './scan';
import { getToolsDir, getToolsInfo, installTools as installToolchain } from './tools';

export { scan };

// Host side of the optimizer. The heavy pipeline (pipeline.ts) runs in a worker child process on
// the bundled real Node, with the downloaded toolchain on its module path; this module only
// installs that toolchain, spawns the worker, relays its progress to the renderer, and handles
// the fs-only operations (scan, revert) itself.

const WORKER_PKG = '@dcl-creator-hub/optimizer-worker';
const WORKER_BIN = 'optimizer-worker';

// One run at a time, app-wide. The modal disables its buttons while a run is in flight, but the
// IPC handlers are open to any renderer call; two runs (or a run and a revert) on the same scene
// would race on the backup, the manifest and the GLB writes.
let running: Promise<unknown> | null = null;

async function exclusive<T>(what: string, task: () => Promise<T>): Promise<T> {
  if (running) throw new Error(`Cannot ${what}: an optimization is already in progress.`);
  const promise = task();
  running = promise;
  try {
    return await promise;
  } finally {
    if (running === promise) running = null;
  }
}

function emitProgress(projectPath: string, progress: Omit<OptimizeProgress, 'path'>): void {
  const window = getWindow(MAIN_WINDOW_ID);
  if (window && !window.isDestroyed()) {
    const payload: OptimizeProgress = { path: projectPath, ...progress };
    window.webContents.send(OPTIMIZE_PROGRESS_EVENT, payload);
  }
}

export async function tools(): Promise<OptimizeToolsInfo> {
  return getToolsInfo();
}

export async function installTools(projectPath: string): Promise<OptimizeToolsInfo> {
  await installToolchain(message =>
    emitProgress(projectPath, { phase: 'install', current: 0, total: 0, message }),
  );
  return getToolsInfo();
}

// The worker bundle is copied out of the app on every run into a package under the tools dir:
// real Node cannot execute a file inside the asar, and Node resolves `sharp` & co. by walking
// up from the script's own directory, so living under <tools>/node_modules is what puts the
// downloaded toolchain in scope. `npm ci` wipes node_modules, hence the copy is per run.
async function ensureWorkerPackage(): Promise<void> {
  const source = path.join(app.getAppPath(), 'main', 'dist', 'optimizer-worker.js');
  const pkgDir = path.join(getToolsDir(), 'node_modules', ...WORKER_PKG.split('/'));
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.copyFile(source, path.join(pkgDir, 'index.js'));
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: WORKER_PKG,
        version: app.getVersion(),
        private: true,
        type: 'module',
        bin: { [WORKER_BIN]: 'index.js' },
      },
      null,
      2,
    ),
  );
}

export function run(projectPath: string, options: OptimizeOptions): Promise<OptimizeResult> {
  return exclusive('start a run', () => runWorker(projectPath, options));
}

async function runWorker(projectPath: string, options: OptimizeOptions): Promise<OptimizeResult> {
  const info = await getToolsInfo();
  if (info.status !== 'ready') throw new Error('The optimizer tools are not installed yet.');
  await ensureWorkerPackage();

  // The toolchain is built for real Node's ABI. `resolveNodeRuntime` falls back to running the
  // script on Electron when no Node binary is found, and sharp has no prebuilt binary for that
  // ABI — the run would die deep inside the worker on a native load error that says nothing
  // about the cause.
  if (resolveNodeRuntime().source === 'electron') {
    throw new Error('Could not find the Node runtime the optimizer needs to run.');
  }

  const job: OptimizeWorkerJob = { command: 'run', projectPath, options };
  const toolsDir = getToolsDir();
  const child = runBin(WORKER_PKG, WORKER_BIN, {
    workspace: toolsDir,
    cwd: toolsDir,
    env: { OPTIMIZER_JOB: JSON.stringify(job) },
  });

  // Progress has to reach the renderer while the run is still going, so it is read off the live
  // stream. The OUTCOME is not: `bin`'s own 'exit' handler calls cleanup(), which does
  // `stdout.removeAllListeners('data')` — and Node documents that 'exit' can fire before the
  // child's stdio has drained. Any chunk still in the pipe is then dropped, which turns a run
  // that finished fine into "exited without a result". So the result/error line is parsed from
  // the COMPLETE buffer instead: wait() resolves with it, and StreamError carries it on failure.
  const live = createWorkerOutputReader({
    onLog: line => log.info(`[Optimizer] ${line}`),
    onMessage: message => {
      if (message.type === 'progress') emitProgress(projectPath, message.progress);
    },
  });
  child.process.stdout?.on('data', (chunk: Buffer) => live.push(chunk));

  let stdout: Buffer;
  let exitError: Error | null = null;
  try {
    stdout = await child.wait();
  } catch (error) {
    stdout = error instanceof StreamError ? error.stdout : Buffer.alloc(0);
    exitError = error instanceof Error ? error : new Error(String(error));
  }

  let result: OptimizeResult | null = null;
  let failure: string | null = null;
  const outcome = createWorkerOutputReader({
    onMessage: message => {
      if (message.type === 'result') result = message.result;
      else if (message.type === 'error') failure = message.message;
    },
  });
  outcome.push(stdout);
  outcome.flush();

  // The worker's own error line says more than "exited with code 1", so it wins.
  if (failure) throw new Error(failure);
  if (exitError) throw exitError;
  if (!result) throw new Error('The optimizer worker exited without a result.');
  return result;
}

export function revert(projectPath: string): Promise<{ restored: number }> {
  return exclusive('revert', async () => {
    const manifest = await readManifest(projectPath);
    if (!manifest) return { restored: 0 };
    const restored = await revertFromManifest(projectPath, manifest);
    return { restored };
  });
}
