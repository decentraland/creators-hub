import { ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  OPTIMIZE_PROGRESS_EVENT,
  type OptimizeOptions,
  type OptimizeProgress,
} from '/shared/types/optimizer';

import { invoke } from '../services/ipc';

export async function scan(path: string) {
  return invoke('optimizer.scan', path);
}

export async function run(path: string, options: OptimizeOptions) {
  return invoke('optimizer.run', path, options);
}

export async function revert(path: string) {
  return invoke('optimizer.revert', path);
}

export async function tools() {
  return invoke('optimizer.tools');
}

export async function installTools(path: string) {
  return invoke('optimizer.installTools', path);
}

export function subscribeProgress(
  path: string,
  cb: (progress: OptimizeProgress) => void,
): { cleanup: () => void } {
  const handler = (_: IpcRendererEvent, payload: OptimizeProgress) => {
    if (payload.path === path) cb(payload);
  };
  ipcRenderer.on(OPTIMIZE_PROGRESS_EVENT, handler);
  return { cleanup: () => ipcRenderer.off(OPTIMIZE_PROGRESS_EVENT, handler) };
}
