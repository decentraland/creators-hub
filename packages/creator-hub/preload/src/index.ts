import { getServices } from './services';

import * as fsService from './services/fs';
import { initializeWorkspace } from './modules/workspace';

const services = getServices();

export const workspace = initializeWorkspace(services);

/**
 * The filesystem functions the renderer can call.
 *
 * `unplugin-auto-expose` puts every export of this module on `window.__electron_preload__*`,
 * so re-exporting the whole service module would also expose the ones only preload itself
 * uses: `cp`, `isWritable`, `rename`, and `openPath`. The `#preload` virtual module is
 * generated from this list, so renderer imports are unaffected.
 *
 * Note this list is a surface, not a boundary — the entries below still take absolute paths.
 * `resolveWithin` is the boundary, and the RPC layer routes Inspector-supplied paths through
 * it.
 */
export const fs = {
  exists: fsService.exists,
  isDirectory: fsService.isDirectory,
  mkdir: fsService.mkdir,
  readFile: fsService.readFile,
  readdir: fsService.readdir,
  resolve: fsService.resolve,
  resolveWithin: fsService.resolveWithin,
  rm: fsService.rm,
  rmdir: fsService.rmdir,
  showItemInFolder: fsService.showItemInFolder,
  stat: fsService.stat,
  writeFile: fsService.writeFile,
};

export * as ai from './modules/ai';
export * as auth from './modules/auth';
export * as editor from './modules/editor';
export * as metrics from './modules/metrics';
export * as misc from './modules/misc';
export * as env from './modules/env';
export * as analytics from './modules/analytics';
export * as npm from './services/npm';
export * as pkg from './services/pkg';
export * as settings from './modules/settings';
export * as scene from './modules/scene';
export * as custom from './modules/custom';
export * as oxc from './modules/oxc';
export * as optimizer from './modules/optimizer';
