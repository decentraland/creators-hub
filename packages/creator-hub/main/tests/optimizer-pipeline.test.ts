import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_OPTIMIZE_OPTIONS,
  type OptimizeOptions,
  type TextureCategory,
} from '/shared/types/optimizer';

import {
  OPTIMIZE_DIR,
  readManifest,
  revertFromManifest,
  type OptimizeManifest,
} from '../src/modules/optimizer/backup';
import { createInlinePool, type CompressPool } from '../src/modules/optimizer/compress-pool';
import { runPipeline } from '../src/modules/optimizer/pipeline';
import { TEXTURES_DIR } from '../src/modules/optimizer/scan';
import { TextureCache } from '../src/modules/optimizer/texture-cache';
import {
  buildQuad,
  countTriangles,
  createReaderIO,
  glbJson,
  gradientPng,
  imageRefs,
  listFiles,
  nodeNames,
  optimalPng,
  solidPng,
  writeEmbeddedGlb,
  writeExternalGlb,
} from './helpers/optimizer-fixtures';

// End-to-end over the real toolchain (devDependencies), on a synthetic scene that carries every
// case the Genesis Plaza run taught us: embedded textures, a texture already external and shared
// by two models, a flat normal map, an empty marker node, a texture the scene code names, an
// external texture that is already optimal, and a second run over the first run's output.
// Slow-ish (WASM init + a lossless re-encode per texture), so generous timeouts.

const GLBS = ['embedded', 'shared-a', 'shared-b', 'flat', 'marker', 'logo', 'kept'].map(
  n => `models/${n}.glb`,
);
const EXTERNAL_PNGS = [
  'models/shared.png',
  'models/flat_base.png',
  'models/flat_normal.png',
  'models/ui_logo.png',
  'models/kept.png',
];
const MARKER_NODE = 'bellMOVE';

async function makeScene(dir: string): Promise<void> {
  const models = path.join(dir, 'models');
  const shared = await gradientPng(2);
  await writeEmbeddedGlb(
    buildQuad({ nodeName: 'Embedded', baseColor: { name: 'Embedded', png: await gradientPng(1) } }),
    path.join(models, 'embedded.glb'),
  );
  await writeExternalGlb(
    buildQuad({ nodeName: 'SharedA', baseColor: { name: 'Shared', png: shared } }),
    path.join(models, 'shared-a.glb'),
    [{ uri: 'shared.png', png: shared }],
  );
  await writeExternalGlb(
    buildQuad({ nodeName: 'SharedB', baseColor: { name: 'Shared', png: shared } }),
    path.join(models, 'shared-b.glb'),
    [{ uri: 'shared.png', png: shared }],
  );
  const flatBase = await gradientPng(3);
  const flatNormal = await solidPng([128, 128, 255, 255]);
  await writeExternalGlb(
    buildQuad({
      nodeName: 'Flat',
      baseColor: { name: 'FlatBase', png: flatBase },
      normal: { name: 'FlatNormal', png: flatNormal },
    }),
    path.join(models, 'flat.glb'),
    [
      { uri: 'flat_base.png', png: flatBase },
      { uri: 'flat_normal.png', png: flatNormal },
    ],
  );
  await writeEmbeddedGlb(
    buildQuad({
      nodeName: 'Marker',
      baseColor: { name: 'Marker', png: await gradientPng(4) },
      emptyNode: MARKER_NODE,
    }),
    path.join(models, 'marker.glb'),
  );
  const logo = await gradientPng(5);
  await writeExternalGlb(
    buildQuad({ nodeName: 'Logo', baseColor: { name: 'Logo', png: logo } }),
    path.join(models, 'logo.glb'),
    [{ uri: 'ui_logo.png', png: logo }],
  );
  const kept = await optimalPng(6);
  await writeExternalGlb(
    buildQuad({ nodeName: 'Kept', baseColor: { name: 'Kept', png: kept } }),
    path.join(models, 'kept.glb'),
    [{ uri: 'kept.png', png: kept }],
  );
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/ui.ts'), "export const LOGO = 'models/ui_logo.png';\n");
}

async function snapshot(dir: string, files: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const rel of files) out.set(rel, await fs.readFile(path.join(dir, rel)));
  return out;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function defaults(): OptimizeOptions {
  return structuredClone(DEFAULT_OPTIMIZE_OPTIONS);
}

// Every fixture texture is 16px tall, so this is the smallest change that forces a real resize.
function sizedTo(pixels: number): OptimizeOptions {
  const options = defaults();
  for (const category of Object.keys(options.textures.sizes) as TextureCategory[]) {
    options.textures.sizes[category] = pixels;
  }
  return options;
}

async function heightOf(file: string): Promise<number | undefined> {
  return (await sharp(await fs.readFile(file)).metadata()).height;
}

describe('optimizer pipeline', () => {
  let scene: string;
  let originals: Map<string, Buffer>;

  beforeEach(async () => {
    scene = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-pipeline-'));
    await makeScene(scene);
    originals = await snapshot(scene, [...GLBS, ...EXTERNAL_PNGS]);
  });
  afterEach(async () => {
    await fs.rm(scene, { recursive: true, force: true });
  });

  describe('when run with the default options', () => {
    it('should shrink every model without changing what renders, and clean up reversibly', async () => {
      const phases: string[] = [];
      const result = await runPipeline(scene, defaults(), p => phases.push(p.phase));

      expect(result.glbsProcessed).toBe(7);
      expect(result.glbsChanged).toBe(7);
      expect(result.files.map(f => f.status)).toEqual(Array(7).fill('optimized'));
      expect(phases[0]).toBe('prepare');
      expect(phases.at(-1)).toBe('done');

      const io = await createReaderIO();
      for (const rel of GLBS) {
        const file = path.join(scene, rel);
        await expect(io.read(file)).resolves.toBeDefined();
        expect(await countTriangles(file)).toBe(2);
        const refs = await imageRefs(file);
        expect(refs.missing).toEqual([]);
        if (rel !== 'models/kept.glb') {
          expect(
            refs.resolved.every(abs => abs.startsWith(path.join(scene, TEXTURES_DIR) + path.sep)),
          ).toBe(true);
        }
      }

      // An already-optimal external texture stays where it is, still referenced, and the run
      // remembers that it cannot shrink so the next run does not try again.
      expect((await imageRefs(path.join(scene, 'models/kept.glb'))).resolved).toEqual([
        path.join(scene, 'models/kept.png'),
      ]);
      expect(
        Buffer.compare(
          await fs.readFile(path.join(scene, 'models/kept.png')),
          originals.get('models/kept.png')!,
        ),
      ).toBe(0);
      const cache = await TextureCache.read(scene);
      expect(cache.size).toBe(1);
      expect(Object.values(cache.toJSON().noGain)).toEqual([
        originals.get('models/kept.png')!.length,
      ]);

      // The marker node survives prune; the flat normal map does not (replaced by its factor).
      expect(await nodeNames(path.join(scene, 'models/marker.glb'))).toContain(MARKER_NODE);
      const flat = await glbJson(path.join(scene, 'models/flat.glb'));
      expect(flat.materials[0].normalTexture).toBeUndefined();

      // One sidecar per distinct texture: the two shared models collapse onto one file.
      expect(result.texturesDeduped).toBe(1);
      expect(await listFiles(path.join(scene, TEXTURES_DIR))).toHaveLength(5);
      expect(result.texturesExtracted).toBe(5);

      // Superseded originals leave, unless the scene's code names them.
      const manifest = (await readManifest(scene)) as OptimizeManifest;
      expect([...manifest.removedFiles].sort()).toEqual([
        'models/flat_base.png',
        'models/flat_normal.png',
        'models/shared.png',
      ]);
      expect(result.texturesRemoved).toBe(3);
      expect(await exists(path.join(scene, 'models/shared.png'))).toBe(false);
      expect(await exists(path.join(scene, 'models/ui_logo.png'))).toBe(true);
      for (const rel of manifest.removedFiles) {
        expect(
          Buffer.compare(
            await fs.readFile(path.join(scene, OPTIMIZE_DIR, 'backup', rel)),
            originals.get(rel)!,
          ),
        ).toBe(0);
      }

      // Accounting follows the scan's definition: GLBs plus every texture they reference. The
      // protected ui_logo.png stays on disk but no model points at it any more, so it leaves
      // the footprint; the removed originals were referenced before, so they were in it.
      const removedBytes = manifest.removedFiles.reduce(
        (sum, rel) => sum + originals.get(rel)!.length,
        0,
      );
      expect(result.removedBytes).toBe(removedBytes);
      expect(result.bytesBefore).toBe(
        [...originals.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      );
      const sizeOf = async (files: string[]) =>
        (await Promise.all(files.map(async f => (await fs.stat(f)).size))).reduce(
          (a, b) => a + b,
          0,
        );
      const sidecars = (await listFiles(path.join(scene, TEXTURES_DIR))).map(f =>
        path.join(scene, TEXTURES_DIR, f),
      );
      expect(result.bytesAfter).toBe(
        (await sizeOf(GLBS.map(rel => path.join(scene, rel)))) +
          (await sizeOf(sidecars)) +
          originals.get('models/kept.png')!.length,
      );
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      expect(result.sidecarBytes).toBeGreaterThan(0);

      expect([...manifest.modifiedGlbs].sort()).toEqual([...GLBS].sort());
      expect(await fs.readFile(path.join(scene, '.dclignore'), 'utf8')).toContain(OPTIMIZE_DIR);
    });
  });

  describe('when run a second time over its own output', () => {
    it('should leave every model alone, merge into the manifest and write nothing new', async () => {
      await runPipeline(scene, defaults(), () => {});
      const first = (await readManifest(scene)) as OptimizeManifest;
      const sidecarsAfterFirst = await listFiles(path.join(scene, TEXTURES_DIR));
      const outputsAfterFirst = await snapshot(scene, GLBS);

      const second = await runPipeline(scene, defaults(), () => {});
      const merged = (await readManifest(scene)) as OptimizeManifest;

      // Re-serializing an already-optimized GLB shifts its size by a fraction of a percent and
      // costs a full pass; a model that is still this optimizer's output is recognized instead.
      expect(second.files.map(f => f.status)).toEqual(Array(7).fill('up_to_date'));
      expect(second.glbsChanged).toBe(0);
      for (const [rel, bytes] of outputsAfterFirst) {
        expect(Buffer.compare(await fs.readFile(path.join(scene, rel)), bytes)).toBe(0);
      }
      expect(second.texturesRemoved).toBe(0);
      expect(second.texturesExtracted).toBe(0);
      expect([...merged.modifiedGlbs].sort()).toEqual([...first.modifiedGlbs].sort());
      expect([...merged.createdFiles].sort()).toEqual([...first.createdFiles].sort());
      expect([...merged.removedFiles].sort()).toEqual([...first.removedFiles].sort());
      expect(await listFiles(path.join(scene, TEXTURES_DIR))).toEqual(sidecarsAfterFirst);

      // The backup still holds the pristine originals, not the first run's output.
      for (const rel of GLBS) {
        expect(
          Buffer.compare(
            await fs.readFile(path.join(scene, OPTIMIZE_DIR, 'backup', rel)),
            originals.get(rel)!,
          ),
        ).toBe(0);
      }
    });

    it('should re-process a model the creator re-exported, and everything when options change', async () => {
      await runPipeline(scene, defaults(), () => {});
      // "Re-export": the pristine file comes back, with a new mtime.
      await fs.writeFile(
        path.join(scene, 'models/embedded.glb'),
        originals.get('models/embedded.glb')!,
      );

      const touched = await runPipeline(scene, defaults(), () => {});
      const byFile = new Map(touched.files.map(f => [f.file, f.status]));
      expect(byFile.get('models/embedded.glb')).toBe('optimized');
      expect([...byFile.entries()].filter(([, s]) => s === 'up_to_date')).toHaveLength(6);

      const options = defaults();
      options.textures.sizes.baseColor = 512;
      const changed = await runPipeline(scene, options, () => {});
      expect(changed.files.map(f => f.status)).toEqual(Array(7).fill('optimized'));
    });

    it('should re-encode the sidecars when the options change, not point back at the old ones', async () => {
      await runPipeline(scene, defaults(), () => {});
      const firstSidecars = await listFiles(path.join(scene, TEXTURES_DIR));
      expect(firstSidecars.length).toBeGreaterThan(0);

      // Reading a GLB resolves its sidecar back into the texture, so the pixels hash to exactly
      // what the previous run wrote. Seeding the dedup index from those files would short-circuit
      // every texture to the file already on disk: the run reports each model as `optimized`
      // while leaving every pixel at the OLD size.
      const changed = await runPipeline(scene, sizedTo(8), () => {});
      expect(changed.files.map(f => f.status)).toEqual(Array(7).fill('optimized'));

      for (const rel of GLBS) {
        for (const abs of (await imageRefs(path.join(scene, rel))).resolved) {
          expect(await heightOf(abs)).toBe(8);
        }
      }

      // The first run's sidecars are superseded and nothing points at them any more. Leaving
      // them behind would grow the deployed scene on every re-run.
      const after = await listFiles(path.join(scene, TEXTURES_DIR));
      expect(after.filter(name => firstSidecars.includes(name))).toEqual([]);
      const manifest = (await readManifest(scene)) as OptimizeManifest;
      const stale = manifest.createdFiles.filter(rel => firstSidecars.includes(path.basename(rel)));
      expect(stale).toEqual([]);
      expect([...manifest.createdFiles].sort()).toEqual(
        after.map(name => `${TEXTURES_DIR}/${name}`).sort(),
      );
    });
  });

  describe('when the output format is not the source format', () => {
    it("should declare the sidecar's own type in the GLB, not the source's", async () => {
      const webp = defaults();
      webp.textures.format = 'webp';
      await runPipeline(scene, webp, () => {});

      for (const rel of GLBS) {
        const json = await glbJson(path.join(scene, rel));
        for (const image of json.images ?? []) {
          if (typeof image.uri !== 'string') continue;
          // The writer emits images[].mimeType verbatim; a loader that trusts it over the
          // extension would decode a .webp sidecar as the PNG the source claimed to be.
          const expected = image.uri.endsWith('.webp') ? 'image/webp' : 'image/png';
          expect(image.mimeType).toBe(expected);
        }
      }
    });
  });

  describe('when a sidecar name matches a .dclignore pattern', () => {
    it('should report the files the deploy would drop', async () => {
      // A creator ignoring a work-in-progress folder with a loose glob: the deploy applies it to
      // the sidecar named after the model's texture too, and the model loads without it.
      await fs.writeFile(path.join(scene, '.dclignore'), 'node_modules\n**/Embedded*\n');

      const result = await runPipeline(scene, defaults(), () => {});

      expect(result.ignoredFiles).toEqual([`${TEXTURES_DIR}/Embedded.png`]);
    });

    it('should report nothing when the sidecars are clear', async () => {
      const result = await runPipeline(scene, defaults(), () => {});
      expect(result.ignoredFiles).toEqual([]);
    });
  });

  describe('when a texture is shared with a .gltf model', () => {
    it('should leave that texture in place', async () => {
      // walkGlbs collects only `.glb`, so nothing else in the run knows this model exists — its
      // texture looks superseded the moment shared-a/shared-b get their sidecars, and stashing
      // it leaves the .gltf rendering untextured until the creator reverts.
      await fs.writeFile(
        path.join(scene, 'models/legacy.gltf'),
        JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'shared.png' }] }),
      );

      const result = await runPipeline(scene, defaults(), () => {});

      expect(await exists(path.join(scene, 'models/shared.png'))).toBe(true);
      const manifest = (await readManifest(scene)) as OptimizeManifest;
      expect([...manifest.removedFiles].sort()).toEqual([
        'models/flat_base.png',
        'models/flat_normal.png',
      ]);
      expect(result.texturesRemoved).toBe(2);
    });
  });

  describe('when a model throws', () => {
    it('should record it as failed instead of leaving it out of the results', async () => {
      const pool: CompressPool = {
        size: 1,
        compress: () => Promise.reject(new Error('compressor died')),
        close: async () => {},
      };

      const result = await runPipeline(scene, defaults(), () => {}, { pool });

      // Every model fails and the run still RESOLVES. With no record per file this is
      // indistinguishable from a scene where nothing needed doing: the modal would show
      // "0 B saved · 0 models changed" and no error at all.
      expect(result.files.map(f => f.status)).toEqual(Array(7).fill('failed'));
      expect(result.files.every(f => f.error === 'compressor died')).toBe(true);
      expect(result.glbsChanged).toBe(0);
      // The size column still shows the real file, not 0 B.
      for (const f of result.files) {
        expect(f.bytesBefore).toBe(originals.get(f.file)!.length);
      }
    });
  });

  describe('when the run is interrupted', () => {
    it('should have already written a manifest that maps every backup made so far', async () => {
      // A pool that dies on the second model: the first was backed up and overwritten, then the
      // run stops — the manifest written before that overwrite is what makes a revert possible.
      let calls = 0;
      const pool: CompressPool = {
        size: 1,
        compress: (...args) => {
          if (++calls > 1) return new Promise(() => {});
          return createInlinePool().compress(...args);
        },
        close: async () => {},
      };
      // The pipeline walks the models in sorted order; GLBS is in authoring order.
      const [first, second] = [...GLBS].sort();
      const interrupted = new Promise<void>(resolve => {
        void runPipeline(
          scene,
          defaults(),
          p => {
            if (p.phase === 'textures' && p.file === second) resolve();
          },
          { pool },
        );
      });
      await interrupted;

      const manifest = (await readManifest(scene)) as OptimizeManifest;
      expect(manifest.modifiedGlbs).toEqual([first]);
      expect(manifest.optionsKey).toBeNull();
      expect(
        Buffer.compare(
          await fs.readFile(path.join(scene, OPTIMIZE_DIR, 'backup', first)),
          originals.get(first)!,
        ),
      ).toBe(0);
    });
  });

  describe('when the scene was optimized before the sidecar folder moved under assets/', () => {
    it('should keep writing to the folder the manifest names', async () => {
      // A manifest from before `texturesDir` existed: those runs wrote to the project root.
      await fs.mkdir(path.join(scene, OPTIMIZE_DIR), { recursive: true });
      await fs.writeFile(
        path.join(scene, OPTIMIZE_DIR, 'manifest.json'),
        JSON.stringify({ version: 1, createdAt: 1, modifiedGlbs: [], createdFiles: [] }),
      );

      await runPipeline(scene, defaults(), () => {});

      expect(await listFiles(path.join(scene, 'optimized-textures'))).toHaveLength(5);
      expect(await exists(path.join(scene, TEXTURES_DIR))).toBe(false);
      expect(((await readManifest(scene)) as OptimizeManifest).texturesDir).toBe(
        'optimized-textures',
      );
    });
  });

  describe('when reverted', () => {
    it('should restore every file byte for byte and leave no trace', async () => {
      await runPipeline(scene, defaults(), () => {});
      await runPipeline(scene, defaults(), () => {});

      const manifest = (await readManifest(scene)) as OptimizeManifest;
      const restored = await revertFromManifest(scene, manifest);

      expect(restored).toBe(7);
      for (const [rel, bytes] of originals) {
        expect(Buffer.compare(await fs.readFile(path.join(scene, rel)), bytes)).toBe(0);
      }
      expect(await exists(path.join(scene, TEXTURES_DIR))).toBe(false);
      expect(await exists(path.join(scene, OPTIMIZE_DIR))).toBe(false);
      expect(await exists(path.join(scene, '.dclignore'))).toBe(false);
    });
  });

  describe('when every option is off', () => {
    it('should touch nothing and report every model unchanged', async () => {
      const options = defaults();
      options.mesh.enabled = false;
      options.textures = { ...options.textures, compress: false, dedup: false, externalize: false };

      const result = await runPipeline(scene, options, () => {});

      expect(result.files.map(f => f.status)).toEqual(Array(7).fill('unchanged'));
      for (const [rel, bytes] of originals) {
        expect(Buffer.compare(await fs.readFile(path.join(scene, rel)), bytes)).toBe(0);
      }
      expect(await exists(path.join(scene, TEXTURES_DIR))).toBe(false);
    });
  });
}, 120_000);
