import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scan } from '../src/modules/optimizer/scan';
import {
  buildQuad,
  gradientPng,
  writeEmbeddedGlb,
  writeExternalGlb,
} from './helpers/optimizer-fixtures';

describe('optimizer scan', () => {
  let project: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-scan-'));
  });
  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  describe('when models mix embedded, shared external and dangling textures', () => {
    it('should weigh models plus each texture file once, and count both kinds', async () => {
      const shared = await gradientPng(2);
      const models = path.join(project, 'models');
      await writeEmbeddedGlb(
        buildQuad({ nodeName: 'A', baseColor: { name: 'A', png: await gradientPng(1) } }),
        path.join(models, 'a.glb'),
      );
      await writeExternalGlb(
        buildQuad({ nodeName: 'B', baseColor: { name: 'Shared', png: shared } }),
        path.join(models, 'b.glb'),
        [{ uri: 'shared.png', png: shared }],
      );
      await writeExternalGlb(
        buildQuad({ nodeName: 'C', baseColor: { name: 'Shared', png: shared } }),
        path.join(models, 'c.glb'),
        [{ uri: 'shared.png', png: shared }],
      );
      await writeExternalGlb(
        buildQuad({ nodeName: 'D', baseColor: { name: 'Gone', png: await gradientPng(3) } }),
        path.join(models, 'd.glb'),
        [{ uri: 'gone.png', png: shared }],
      );
      await fs.rm(path.join(models, 'gone.png'));
      // things the walk must ignore
      await fs.mkdir(path.join(project, 'node_modules/x'), { recursive: true });
      await fs.writeFile(path.join(project, 'node_modules/x/dep.glb'), 'not a scene model');

      const result = await scan(project);

      const glbBytes = (
        await Promise.all(
          ['a', 'b', 'c', 'd'].map(async n => (await fs.stat(path.join(models, `${n}.glb`))).size),
        )
      ).reduce((a, b) => a + b, 0);
      const sharedBytes = (await fs.stat(path.join(models, 'shared.png'))).size;

      expect(result.glbCount).toBe(4);
      expect(result.glbBytes).toBe(glbBytes);
      expect(result.textureBytes).toBe(sharedBytes);
      expect(result.totalBytes).toBe(glbBytes + sharedBytes);
      expect(result.embeddedTextureCount).toBe(1);
      expect(result.externalTextureCount).toBe(2);
      expect(result.hasBackup).toBe(false);
    });
  });

  describe('when the project has no models', () => {
    it('should report zeros', async () => {
      expect(await scan(project)).toEqual({
        glbCount: 0,
        totalBytes: 0,
        glbBytes: 0,
        textureBytes: 0,
        embeddedTextureCount: 0,
        externalTextureCount: 0,
        hasBackup: false,
        lastOptimizedAt: null,
      });
    });
  });
});
