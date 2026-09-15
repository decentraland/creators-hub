/**
 * Regenerates the optimizer toolchain lockfile from its pinned package.json:
 *   main/src/modules/optimizer/tools/optimizer-tools.package.json      (edit versions here)
 *   main/src/modules/optimizer/tools/optimizer-tools.package-lock.json (generated, commit it)
 *
 * The lockfile is what the app installs with `npm ci` on first use (see tools.ts), so every
 * package the optimizer downloads is pinned to an exact registry tarball + integrity hash.
 * Run after bumping a version: `npm run lock:optimizer-tools`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../main/src/modules/optimizer/tools',
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-tools-'));

try {
  fs.copyFileSync(
    path.join(toolsDir, 'optimizer-tools.package.json'),
    path.join(tmp, 'package.json'),
  );
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: tmp, stdio: 'inherit' },
  );
  fs.copyFileSync(
    path.join(tmp, 'package-lock.json'),
    path.join(toolsDir, 'optimizer-tools.package-lock.json'),
  );
  console.log('updated optimizer-tools.package-lock.json');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
