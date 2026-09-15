import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPTIMIZE_DIR,
  TEXTURES_DIR,
  backupFile,
  createManifest,
  ensureDclignoreBlock,
  hasBackup,
  readManifest,
  resolveInside,
  revertFromManifest,
  stashFile,
  stripDclignoreBlock,
  writeManifest,
} from '../src/modules/optimizer/backup';

async function write(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe('optimizer backup', () => {
  let project: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-backup-'));
  });
  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  describe('.dclignore block', () => {
    it('should create the file with the block when there is none', async () => {
      await ensureDclignoreBlock(project);

      const text = await fs.readFile(path.join(project, '.dclignore'), 'utf8');
      expect(text).toContain('# --- creator-hub optimize backup');
      expect(text).toContain(`\n${OPTIMIZE_DIR}\n${OPTIMIZE_DIR}/**\n`);
    });

    it('should append once to an existing file, even one without a trailing newline', async () => {
      await write(path.join(project, '.dclignore'), 'node_modules\n*.ts');

      await ensureDclignoreBlock(project);
      await ensureDclignoreBlock(project);

      const text = await fs.readFile(path.join(project, '.dclignore'), 'utf8');
      expect(text.startsWith('node_modules\n*.ts\n# ---')).toBe(true);
      expect(text.match(/creator-hub optimize backup/g)).toHaveLength(1);
    });

    it('should strip only its own block and keep the creator’s entries', async () => {
      await write(path.join(project, '.dclignore'), 'node_modules\n**/sakura*\n');
      await ensureDclignoreBlock(project);

      await stripDclignoreBlock(project);

      expect(await fs.readFile(path.join(project, '.dclignore'), 'utf8')).toBe(
        'node_modules\n**/sakura*\n',
      );
    });

    it('should delete the file when the block was all it held', async () => {
      await ensureDclignoreBlock(project);
      await stripDclignoreBlock(project);
      expect(await exists(path.join(project, '.dclignore'))).toBe(false);
    });

    it('should strip a block written before the end marker existed', async () => {
      await write(
        path.join(project, '.dclignore'),
        `node_modules\n# --- creator-hub optimize backup (auto-generated, do not edit) ---\n${OPTIMIZE_DIR}\n${OPTIMIZE_DIR}/**\n**/sakura*\n`,
      );

      await stripDclignoreBlock(project);

      expect(await fs.readFile(path.join(project, '.dclignore'), 'utf8')).toBe(
        'node_modules\n**/sakura*\n',
      );
    });

    it('should strip everything up to the end marker, however long the block grows', async () => {
      await write(path.join(project, '.dclignore'), 'node_modules\n');
      await ensureDclignoreBlock(project);
      const withExtraEntry = (await fs.readFile(path.join(project, '.dclignore'), 'utf8')).replace(
        `${OPTIMIZE_DIR}/**\n`,
        `${OPTIMIZE_DIR}/**\n${OPTIMIZE_DIR}-cache\n`,
      );
      await write(path.join(project, '.dclignore'), withExtraEntry);

      await stripDclignoreBlock(project);

      expect(await fs.readFile(path.join(project, '.dclignore'), 'utf8')).toBe('node_modules\n');
    });
  });

  describe('backupFile', () => {
    it('should keep the first copy across repeated calls', async () => {
      await write(path.join(project, 'assets/a.glb'), 'pristine');
      await backupFile(project, 'assets/a.glb');

      await write(path.join(project, 'assets/a.glb'), 'optimized once');
      await backupFile(project, 'assets/a.glb');

      const backup = path.join(project, OPTIMIZE_DIR, 'backup/assets/a.glb');
      expect(await fs.readFile(backup, 'utf8')).toBe('pristine');
    });
  });

  describe('stashFile', () => {
    it('should move the file into the backup and off the project', async () => {
      await write(path.join(project, 'assets/tex.png'), 'pixels');

      await stashFile(project, 'assets/tex.png');

      expect(await exists(path.join(project, 'assets/tex.png'))).toBe(false);
      expect(
        await fs.readFile(path.join(project, OPTIMIZE_DIR, 'backup/assets/tex.png'), 'utf8'),
      ).toBe('pixels');
    });
  });

  describe('manifest', () => {
    it('should round-trip and report a backup once written', async () => {
      expect(await hasBackup(project)).toBe(false);
      const manifest = createManifest();
      manifest.modifiedGlbs.push('a.glb');
      manifest.createdFiles.push('optimized-textures/t.png');
      manifest.removedFiles.push('assets/old.png');

      const written = await writeManifest(project, manifest);

      expect(await hasBackup(project)).toBe(true);
      expect(await readManifest(project)).toEqual(written);
      expect(written).toEqual({ ...manifest, updatedAt: written.updatedAt });
    });

    it('should stamp the write time on the copy it writes, not on the input', async () => {
      const manifest = { ...createManifest(), updatedAt: 1 };

      const written = await writeManifest(project, manifest);

      expect(manifest.updatedAt).toBe(1);
      expect(written.updatedAt).toBeGreaterThan(1);
    });

    it('should default removedFiles for a manifest written before the field existed', async () => {
      await write(
        path.join(project, OPTIMIZE_DIR, 'manifest.json'),
        JSON.stringify({ version: 1, createdAt: 1, modifiedGlbs: ['a.glb'], createdFiles: [] }),
      );

      const manifest = await readManifest(project);

      expect(manifest?.removedFiles).toEqual([]);
      expect(manifest?.outputs).toEqual({});
      expect(manifest?.updatedAt).toBe(1);
      // Those runs wrote sidecars to the project root; the scene keeps that folder.
      expect(manifest?.texturesDir).toBe('optimized-textures');
      expect(manifest?.modifiedGlbs).toEqual(['a.glb']);
    });

    it('should return null when there is no manifest', async () => {
      expect(await readManifest(project)).toBeNull();
    });
  });

  describe('revertFromManifest', () => {
    it('should restore modified and removed files, delete created ones, and clean up', async () => {
      await write(path.join(project, 'models/a.glb'), 'original a');
      await write(path.join(project, 'models/b.glb'), 'original b');
      await write(path.join(project, 'models/shared.png'), 'original png');
      await write(path.join(project, 'src/ui.ts'), 'untouched');
      await ensureDclignoreBlock(project);

      await backupFile(project, 'models/a.glb');
      await backupFile(project, 'models/b.glb');
      await write(path.join(project, 'models/a.glb'), 'optimized a');
      await write(path.join(project, 'models/b.glb'), 'optimized b');
      await write(path.join(project, TEXTURES_DIR, 'shared.png'), 'sidecar');
      await stashFile(project, 'models/shared.png');

      const manifest = createManifest();
      manifest.modifiedGlbs.push('models/a.glb', 'models/b.glb');
      manifest.createdFiles.push(`${TEXTURES_DIR}/shared.png`);
      manifest.removedFiles.push('models/shared.png');
      await writeManifest(project, manifest);

      const restored = await revertFromManifest(project, manifest);

      expect(restored).toBe(2);
      expect(await fs.readFile(path.join(project, 'models/a.glb'), 'utf8')).toBe('original a');
      expect(await fs.readFile(path.join(project, 'models/b.glb'), 'utf8')).toBe('original b');
      expect(await fs.readFile(path.join(project, 'models/shared.png'), 'utf8')).toBe(
        'original png',
      );
      expect(await exists(path.join(project, TEXTURES_DIR))).toBe(false);
      expect(await fs.readFile(path.join(project, 'src/ui.ts'), 'utf8')).toBe('untouched');
      expect(await exists(path.join(project, OPTIMIZE_DIR))).toBe(false);
      expect(await exists(path.join(project, '.dclignore'))).toBe(false);
    });

    it('should skip entries whose backup is missing instead of failing', async () => {
      await write(path.join(project, 'models/a.glb'), 'still optimized');
      const manifest = createManifest();
      manifest.modifiedGlbs.push('models/a.glb');
      manifest.removedFiles.push('models/gone.png');

      const restored = await revertFromManifest(project, manifest);

      expect(restored).toBe(0);
      expect(await fs.readFile(path.join(project, 'models/a.glb'), 'utf8')).toBe('still optimized');
    });

    it('should refuse a manifest entry that resolves outside the project, before touching anything', async () => {
      // The manifest is a plain JSON file inside the scene: an entry that climbs out of the
      // project must not turn revert into a write or delete anywhere else on disk.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-outside-'));
      try {
        await write(path.join(outside, 'precious.txt'), 'keep me');
        await write(path.join(project, 'models/a.glb'), 'optimized a');
        await backupFile(project, 'models/a.glb');
        const escape = path.relative(project, path.join(outside, 'precious.txt'));

        const deleting = createManifest();
        deleting.modifiedGlbs.push('models/a.glb');
        deleting.createdFiles.push(escape);
        await expect(revertFromManifest(project, deleting)).rejects.toThrow(/outside the project/);

        const writing = createManifest();
        writing.modifiedGlbs.push(escape);
        await expect(revertFromManifest(project, writing)).rejects.toThrow(/outside the project/);

        const absolute = createManifest();
        absolute.removedFiles.push(path.join(outside, 'precious.txt'));
        await expect(revertFromManifest(project, absolute)).rejects.toThrow(/outside the project/);

        expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
        // Nothing was restored either: the whole manifest is vetted first.
        expect(await fs.readFile(path.join(project, 'models/a.glb'), 'utf8')).toBe('optimized a');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('resolveInside', () => {
    it('should resolve a project-relative path and reject anything that escapes', () => {
      expect(resolveInside(project, 'models/a.glb')).toBe(path.join(project, 'models/a.glb'));
      expect(resolveInside(project, 'models/../models/a.glb')).toBe(
        path.join(project, 'models/a.glb'),
      );
      expect(() => resolveInside(project, '../sibling.glb')).toThrow(/outside the project/);
      expect(() => resolveInside(project, '')).toThrow(/outside the project/);
      expect(() => resolveInside(project, path.join(os.tmpdir(), 'x.glb'))).toThrow(
        /outside the project/,
      );
    });
  });
});
