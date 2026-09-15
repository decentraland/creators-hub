import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The toolchain installer writes under app.getPath('userData') and runs the bundled npm through
// bin.run; point the first at a temp dir and replace the second with a fake npm that lays down
// what a real `npm ci` would, so the tests exercise the real fs logic without a network.
const mocks = vi.hoisted(() => ({
  userData: '',
  run: vi.fn(),
  installBinding: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, getVersion: () => '0.0.0-test' },
}));
vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/modules/bin', () => ({ run: mocks.run }));

import {
  OPTIMIZER_TOOLS,
  getToolsDir,
  getToolsInfo,
  installTools,
} from '../src/modules/optimizer/tools';

const PINNED_PACKAGE_JSON = new URL(
  '../src/modules/optimizer/tools/optimizer-tools.package.json',
  import.meta.url,
);

async function fakeNpmCi(cwd: string): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  const packages = Object.keys(manifest.dependencies);
  if (mocks.installBinding) packages.push(`@img/sharp-${process.platform}-${process.arch}`);
  for (const pkg of packages) {
    const dir = path.join(cwd, 'node_modules', pkg);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }));
  }
}

describe('optimizer tools', () => {
  beforeEach(async () => {
    mocks.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-tools-'));
    mocks.installBinding = true;
    mocks.run.mockReset();
    mocks.run.mockImplementation((_pkg: string, _bin: string, options: { cwd: string }) => ({
      wait: async () => {
        await fakeNpmCi(options.cwd);
        return Buffer.alloc(0);
      },
    }));
  });
  afterEach(async () => {
    await fs.rm(mocks.userData, { recursive: true, force: true });
  });

  describe('the pinned tool list', () => {
    it('should carry the exact versions of the pinned package.json, with release links', async () => {
      const pinned = JSON.parse(await fs.readFile(PINNED_PACKAGE_JSON, 'utf8')).dependencies;

      expect(OPTIMIZER_TOOLS.map(tool => tool.pkg)).toEqual([
        'sharp',
        '@gltf-transform/core',
        'meshoptimizer',
      ]);
      for (const tool of OPTIMIZER_TOOLS) {
        expect(tool.version).toBe(pinned[tool.pkg]);
        expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(tool.npm).toBe(`https://www.npmjs.com/package/${tool.pkg}/v/${tool.version}`);
        expect(tool.source).toMatch(/^https:\/\/github\.com\//);
      }
      expect(OPTIMIZER_TOOLS.find(t => t.pkg === 'sharp')?.source).toMatch(
        /releases\/tag\/v\d+\.\d+\.\d+$/,
      );
    });
  });

  describe('when nothing has been installed', () => {
    it('should report the tools as missing', async () => {
      const info = await getToolsInfo();
      expect(info.status).toBe('missing');
      expect(info.tools).toBe(OPTIMIZER_TOOLS);
      expect(info.downloadSizeMb).toBeGreaterThan(0);
    });
  });

  describe('installTools', () => {
    it('should install from the pinned lockfile with npm ci and ignore-scripts, then report ready', async () => {
      const messages: string[] = [];

      await installTools(message => messages.push(message));

      expect(mocks.run).toHaveBeenCalledTimes(1);
      const [pkg, bin, options] = mocks.run.mock.calls[0];
      expect(pkg).toBe('npm');
      expect(bin).toBe('npm');
      expect(options.cwd).toBe(getToolsDir());
      expect(options.args.slice(0, 2)).toEqual(['ci', '--ignore-scripts']);

      const dir = getToolsDir();
      const lock = JSON.parse(await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8'));
      expect(lock.lockfileVersion).toBe(3);
      expect(lock.packages['node_modules/sharp'].integrity).toMatch(/^sha512-/);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      expect(manifest.dependencies.sharp).toBe(
        OPTIMIZER_TOOLS.find(t => t.pkg === 'sharp')?.version,
      );

      expect(messages[0]).toMatch(/Downloading optimizer tools/);
      expect((await getToolsInfo()).status).toBe('ready');
    });

    it('should give up on an install that never finishes, and kill it', async () => {
      // A registry stall left the modal on "Downloading…" with nothing to cancel it.
      vi.useFakeTimers();
      try {
        const kill = vi.fn(async () => {});
        mocks.run.mockImplementation(() => ({ wait: () => new Promise(() => {}), kill }));

        const attempt = installTools(() => {});
        const outcome = expect(attempt).rejects.toThrow(/took too long/);
        await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        await outcome;
        expect(kill).toHaveBeenCalledTimes(1);
        expect((await getToolsInfo()).status).toBe('missing');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should fail when the install did not produce a pinned package', async () => {
      mocks.run.mockImplementation((_pkg: string, _bin: string, options: { cwd: string }) => ({
        wait: async () => {
          await fakeNpmCi(options.cwd);
          await fs.rm(path.join(options.cwd, 'node_modules/meshoptimizer'), {
            recursive: true,
            force: true,
          });
          return Buffer.alloc(0);
        },
      }));

      await expect(installTools(() => {})).rejects.toThrow(/did not produce meshoptimizer/);
      expect((await getToolsInfo()).status).toBe('missing');
    });

    it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
      "should fail when sharp's native binding for this platform is missing",
      async () => {
        mocks.installBinding = false;

        await expect(installTools(() => {})).rejects.toThrow(/did not include @img\/sharp-/);
        expect((await getToolsInfo()).status).toBe('missing');
      },
    );
  });

  describe('when an install exists', () => {
    beforeEach(async () => {
      await installTools(() => {});
    });

    it('should report missing again when a package disappears', async () => {
      await fs.rm(path.join(getToolsDir(), 'node_modules/sharp'), {
        recursive: true,
        force: true,
      });
      expect((await getToolsInfo()).status).toBe('missing');
    });

    it('should report missing when the install was made for different pinned versions', async () => {
      const marker = path.join(getToolsDir(), 'installed.json');
      const installed = JSON.parse(await fs.readFile(marker, 'utf8'));
      await fs.writeFile(marker, JSON.stringify({ ...installed, key: 'stale-key' }));

      expect((await getToolsInfo()).status).toBe('missing');
    });
  });
});
