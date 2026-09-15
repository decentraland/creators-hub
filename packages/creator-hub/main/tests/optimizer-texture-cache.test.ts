import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_OPTIMIZE_OPTIONS } from '/shared/types/optimizer';

import { OPTIMIZE_DIR } from '../src/modules/optimizer/backup';
import { TextureCache } from '../src/modules/optimizer/texture-cache';

const options = DEFAULT_OPTIMIZE_OPTIONS.textures;

describe('texture cache', () => {
  let project: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-cache-'));
  });
  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  describe('key', () => {
    it('should change with every option the compressor outcome depends on', () => {
      const base = TextureCache.key('abc', 'baseColor', options);
      expect(TextureCache.key('abc', 'baseColor', options)).toBe(base);
      expect(TextureCache.key('abd', 'baseColor', options)).not.toBe(base);
      expect(TextureCache.key('abc', 'orm', options)).not.toBe(base);
      expect(TextureCache.key('abc', 'baseColor', { ...options, format: 'webp' })).not.toBe(base);
      expect(TextureCache.key('abc', 'baseColor', { ...options, denoise: 'light' })).not.toBe(base);
      expect(
        TextureCache.key('abc', 'baseColor', {
          ...options,
          sizes: { ...options.sizes, baseColor: 512 },
        }),
      ).not.toBe(base);
      // PNG is lossless, so the quality slider does not affect it.
      expect(TextureCache.key('abc', 'baseColor', { ...options, quality: 10 })).toBe(base);
    });
  });

  describe('hasNoGain', () => {
    it('should only vouch for inputs no larger than the one that had no gain', () => {
      const cache = new TextureCache();
      cache.rememberNoGain('k', 1000);

      expect(cache.hasNoGain('k', 1000)).toBe(true);
      expect(cache.hasNoGain('k', 900)).toBe(true);
      expect(cache.hasNoGain('k', 1001)).toBe(false);
      expect(cache.hasNoGain('other', 10)).toBe(false);
    });

    it('should keep the largest size seen without gain', () => {
      const cache = new TextureCache();
      cache.rememberNoGain('k', 1000);
      cache.rememberNoGain('k', 800);
      cache.rememberNoGain('k', 1200);
      expect(cache.hasNoGain('k', 1200)).toBe(true);
    });
  });

  describe('persistence', () => {
    it('should round-trip through .optimize and write nothing when nothing was learned', async () => {
      const empty = await TextureCache.read(project);
      await empty.write(project);
      await expect(fs.access(path.join(project, OPTIMIZE_DIR))).rejects.toThrow();

      empty.rememberNoGain('k', 1000);
      await empty.write(project);

      const reloaded = await TextureCache.read(project);
      expect(reloaded.size).toBe(1);
      expect(reloaded.hasNoGain('k', 1000)).toBe(true);
    });

    it('should start empty on a corrupt or older cache file', async () => {
      await fs.mkdir(path.join(project, OPTIMIZE_DIR), { recursive: true });
      const file = path.join(project, OPTIMIZE_DIR, 'texture-cache.json');
      await fs.writeFile(file, '{ not json');
      expect((await TextureCache.read(project)).size).toBe(0);

      await fs.writeFile(file, JSON.stringify({ version: 0, noGain: { k: 1 } }));
      expect((await TextureCache.read(project)).size).toBe(0);
    });
  });
});
