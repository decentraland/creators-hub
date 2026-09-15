import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';

import type { OptimizeToolInfo, OptimizeToolsInfo } from '/shared/types/optimizer';

import { run } from '../bin';
import toolsLockfile from './tools/optimizer-tools.package-lock.json?raw';
import toolsPackageJson from './tools/optimizer-tools.package.json?raw';

// The optimizer's toolchain (sharp, glTF-Transform, meshoptimizer) is NOT shipped with the app.
// It is downloaded on first use, after the consent screen, into userData, by the bundled npm —
// the same path the AI CLI (ai-cli.ts) and scene dependencies already take.
//
// Pinned to releases: optimizer-tools.package.json holds exact versions and its committed
// lockfile carries the registry URL + integrity hash of every package, so `npm ci` installs
// byte-for-byte what was reviewed. Bump a version there, then `npm run lock:optimizer-tools`.
//
// Why not bundle: ~20 MB per architecture (15 MB of it libvips) and a cross-arch provisioning
// step for the Intel dmg. Downloading keeps the installer lean and lets the worker run on the
// bundled real Node instead.

const DOWNLOAD_SIZE_MB = 20;
const INSTALLED_MARKER = 'installed.json';
// A registry stall would otherwise leave the modal on "Downloading…" forever, with nothing to
// cancel it. Generous, since the download is ~20 MB on a slow link.
const INSTALL_TIMEOUT_MS = 5 * 60_000;

type ToolMeta = {
  pkg: string;
  name: string;
  purposeKey: OptimizeToolInfo['purposeKey'];
  release: (version: string) => string;
};

// One row per tool as the creator sees it; the three @gltf-transform packages share a version
// and a release, so only core is listed.
const TOOL_META: ToolMeta[] = [
  {
    pkg: 'sharp',
    name: 'sharp',
    purposeKey: 'sharp',
    release: v => `https://github.com/lovell/sharp/releases/tag/v${v}`,
  },
  {
    pkg: '@gltf-transform/core',
    name: 'glTF-Transform',
    purposeKey: 'gltf',
    release: v => `https://github.com/donmccurdy/glTF-Transform/releases/tag/v${v}`,
  },
  {
    pkg: 'meshoptimizer',
    name: 'meshoptimizer',
    purposeKey: 'meshopt',
    // the npm package is versioned 0.NN.0 against the upstream tag v0.NN
    release: v => `https://github.com/zeux/meshoptimizer/releases/tag/v${v.replace(/\.0$/, '')}`,
  },
];

const pinnedVersions: Record<string, string> = JSON.parse(toolsPackageJson).dependencies;

export const OPTIMIZER_TOOLS: OptimizeToolInfo[] = TOOL_META.map(meta => {
  const version = pinnedVersions[meta.pkg];
  return {
    pkg: meta.pkg,
    name: meta.name,
    version,
    purposeKey: meta.purposeKey,
    npm: `https://www.npmjs.com/package/${meta.pkg}/v/${version}`,
    source: meta.release(version),
  };
});

// Changes whenever a pinned version (or the lockfile behind it) changes, so an install made by
// an older app is treated as missing and re-done.
const TOOLS_KEY = crypto
  .createHash('sha256')
  .update(toolsPackageJson)
  .update(toolsLockfile)
  .digest('hex')
  .slice(0, 16);

export function getToolsDir(): string {
  return path.join(app.getPath('userData'), 'optimizer-tools');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isInstalled(): Promise<boolean> {
  const dir = getToolsDir();
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, INSTALLED_MARKER), 'utf8'));
    if (marker.key !== TOOLS_KEY) return false;
  } catch {
    return false;
  }
  for (const pkg of Object.keys(pinnedVersions)) {
    if (!(await exists(path.join(dir, 'node_modules', pkg, 'package.json')))) return false;
  }
  return true;
}

export async function getToolsInfo(): Promise<OptimizeToolsInfo> {
  return {
    status: (await isInstalled()) ? 'ready' : 'missing',
    tools: OPTIMIZER_TOOLS,
    downloadSizeMb: DOWNLOAD_SIZE_MB,
  };
}

export async function installTools(onProgress: (message: string) => void): Promise<void> {
  const dir = getToolsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, INSTALLED_MARKER), { force: true });
  await fs.writeFile(path.join(dir, 'package.json'), toolsPackageJson);
  await fs.writeFile(path.join(dir, 'package-lock.json'), toolsLockfile);

  onProgress(`Downloading optimizer tools (about ${DOWNLOAD_SIZE_MB} MB)…`);
  log.info(`[Optimizer] installing toolchain ${TOOLS_KEY} into ${dir}`);
  // `npm ci` installs exactly the lockfile or fails; --ignore-scripts because nothing here
  // needs a build step (sharp ships prebuilt bindings as platform optionalDependencies) and a
  // downloaded package must not get to run code on install.
  const install = run('npm', 'npm', {
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error'],
    cwd: dir,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      await install.kill();
      reject(new Error('Downloading the optimizer tools took too long. Check your connection.'));
    }, INSTALL_TIMEOUT_MS);
  });
  try {
    await Promise.race([install.wait(), timeout]);
  } finally {
    clearTimeout(timer);
  }

  for (const pkg of Object.keys(pinnedVersions)) {
    if (!(await exists(path.join(dir, 'node_modules', pkg, 'package.json')))) {
      throw new Error(`The optimizer tools install did not produce ${pkg}`);
    }
  }
  // sharp's native binding is a platform optionalDependency; if npm skipped it the worker would
  // throw on its first texture, so fail here where the message can say what happened.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const binding = `@img/sharp-${process.platform}-${process.arch}`;
    if (!(await exists(path.join(dir, 'node_modules', binding, 'package.json')))) {
      throw new Error(`The optimizer tools install did not include ${binding}`);
    }
  }

  await fs.writeFile(
    path.join(dir, INSTALLED_MARKER),
    JSON.stringify({ key: TOOLS_KEY, installedAt: Date.now(), app: app.getVersion() }, null, 2),
  );
  onProgress('Optimizer tools ready.');
  log.info(`[Optimizer] toolchain ${TOOLS_KEY} ready`);
}
