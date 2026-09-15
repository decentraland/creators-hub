import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import { NodeIO, type Document, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import {
  type OptimizeFileResult,
  type OptimizeOptions,
  type OptimizePhase,
  type OptimizeProgress,
  type OptimizeResult,
  type TextureCategory,
} from '/shared/types/optimizer';

import { fixGlbAlignment, patchGlbImageURIs, readGlbJson, readGlbJsonFromFile } from './glb';
import { SKIP_DIRS, measureFootprint, resolveImageUri, walkGlbs } from './scan';
import { DEFAULT_DCLIGNORE, createIgnoreMatcher, parseDclignore } from './dclignore';
import { runMeshPass } from './mesh';
import {
  CATEGORY_PRIORITY,
  classifyTextureSlot,
  mimeForPath,
  mimeToExtension,
  pixelHash,
  sanitizeFilename,
  type CompressResult,
} from './textures';
import { createInlinePool, type CompressPool } from './compress-pool';
import { TextureCache } from './texture-cache';
import {
  backupFile,
  createManifest,
  ensureDclignoreBlock,
  readManifest,
  stashFile,
  toPosix,
  writeManifest,
  type OptimizeManifest,
} from './backup';

// Files whose text is searched for texture names before a superseded texture is removed: a
// scene loads UI/material images directly by path, and those never show up in any GLB.
// Source and composites anywhere; JSON only at the project root (scene.json) and under src/.
// JSON beside the assets is inventory, not code — Genesis Plaza ships a manifest.json per
// model folder naming every texture, which protected 273 superseded files (86 MB) for nothing.
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.composite']);
const CODE_JSON_DIRS = new Set(['', 'src']);
// A `.gltf` references its textures as plain URIs in JSON, and `walkGlbs` collects only `.glb` —
// so a texture shared between a GLB and a glTF looks superseded once the GLB gets its sidecar,
// and stashing it leaves the glTF untextured. Their text is read wherever they live, unlike the
// inventory JSON above.
const MODEL_TEXT_EXTENSIONS = new Set(['.gltf']);

// This module runs in the optimizer WORKER (a child process on the bundled Node with the
// downloaded toolchain on its module path), never in the Electron main process: main ships
// none of sharp / gltf-transform / meshoptimizer. Progress goes back to the
// host through the sink `runPipeline` receives, which the worker turns into stdout JSON lines.
export type ProgressSink = (progress: Omit<OptimizeProgress, 'path'>) => void;

function emitProgress(
  emit: ProgressSink,
  phase: OptimizePhase,
  current: number,
  total: number,
  message: string,
  file?: string,
): void {
  emit({ phase, current, total, message, file });
}

// GLBs are read from their PATH (`io.read`), not from memory (`io.readBinary`): only the path
// form resolves sidecar textures, and a GLB that already references external images throws
// otherwise — which is what silently skipped 281 of central-plaza's 466 models. Reading from
// disk loses the chance to repair misaligned bytes first, so the repair moves into the reader.
class AlignedNodeIO extends NodeIO {
  protected override readURI(uri: string, type: 'view'): Promise<Uint8Array>;
  protected override readURI(uri: string, type: 'text'): Promise<string>;
  protected override async readURI(
    uri: string,
    type: 'view' | 'text',
  ): Promise<Uint8Array | string> {
    if (type === 'text') return super.readURI(uri, 'text');
    const view = await super.readURI(uri, 'view');
    const fixed = fixGlbAlignment(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    return new Uint8Array(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  }
}

function createIO(): NodeIO {
  return new AlignedNodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

function hasExternalImages(glbJson: any): boolean {
  return (
    Array.isArray(glbJson?.images) && glbJson.images.some((img: any) => typeof img.uri === 'string')
  );
}

// Whether the sidecars already on disk are this run's own output. `io.read` resolves each GLB's
// sidecar back into its texture, so those pixels hash to what the previous run wrote: seeding
// the dedup index from them short-circuits every texture to the file already there. That is
// right when the encoding matches and silently wrong when it does not — switching baseColor
// 1024 → 512 (or png → webp) would reprocess and report every model as `optimized` while
// leaving every pixel at the old setting.
function sidecarsAreReusable(state: RunState): boolean {
  if (state.manifest.optionsKey !== null) return state.manifest.optionsKey === state.optionsKey;
  // Manifests written before `optionsKey` existed carry the same fact per GLB: if every recorded
  // output was produced with this run's options, so were the sidecars those outputs point at.
  const records = Object.values(state.manifest.outputs);
  return records.length > 0 && records.every(record => record.options === state.optionsKey);
}

// Sidecars written by earlier runs must stay unique (a re-run reusing `foo.png` would overwrite
// a texture some untouched GLB still points at), and stay deduplicable when they are still this
// run's own output, so seed the name set from disk unconditionally and the dedup index only when
// `sidecarsAreReusable` says so.
async function seedFromExistingSidecars(state: RunState): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(state.texturesDirAbs);
  } catch {
    return;
  }
  const reusable = sidecarsAreReusable(state);
  for (const name of entries) {
    state.usedNames.add(name);
    if (!reusable || !state.options.textures.dedup) continue;
    const abs = path.join(state.texturesDirAbs, name);
    const hash = await pixelHash(await fs.readFile(abs));
    if (hash && !state.dedupIndex.has(hash)) state.dedupIndex.set(hash, abs);
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function buildCategoryMap(document: Document): Map<Texture, TextureCategory> {
  const map = new Map<Texture, TextureCategory>();
  for (const material of document.getRoot().listMaterials()) {
    const slots: [string, Texture | null][] = [
      ['baseColorTexture', material.getBaseColorTexture()],
      ['normalTexture', material.getNormalTexture()],
      ['metallicRoughnessTexture', material.getMetallicRoughnessTexture()],
      ['occlusionTexture', material.getOcclusionTexture()],
      ['emissiveTexture', material.getEmissiveTexture()],
    ];
    for (const [slot, texture] of slots) {
      if (!texture) continue;
      const category = classifyTextureSlot(slot);
      const current = map.get(texture);
      if (!current || CATEGORY_PRIORITY[category] > CATEGORY_PRIORITY[current]) {
        map.set(texture, category);
      }
    }
  }
  return map;
}

function uniqueName(base: string, ext: string, used: Set<string>): string {
  let name = base + ext;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}_${counter}${ext}`;
    counter++;
  }
  used.add(name);
  return name;
}

// Shared run-scoped state for cross-GLB texture dedup and unique filenames.
type RunState = {
  io: NodeIO;
  emit: ProgressSink;
  options: OptimizeOptions;
  projectPath: string;
  texturesDirAbs: string;
  usedNames: Set<string>;
  dedupIndex: Map<string, string>; // pixelHash -> absolute path of the canonical texture file
  // Every external texture file a processed GLB pointed at BEFORE it was rewritten. At the end
  // of the run, once every GLB is written, the ones nothing points at anymore are removed —
  // whether a sidecar replaced them or a transform dropped the texture (prune replaces a
  // solid-colour map with a material factor, leaving the file orphaned).
  externalBefore: Set<string>;
  manifest: OptimizeManifest;
  result: OptimizeResult;
  pool: CompressPool;
  cache: TextureCache;
  optionsKey: string; // identifies the options this run uses, for the manifest's output records
  // Position in the GLB loop, for texture-level progress lines.
  progress: { index: number; total: number };
};

type TextureJob = {
  index: number;
  texture: Texture;
  buffer: Buffer;
  category: TextureCategory;
  // Set when the texture was already a sidecar file of this GLB (not embedded).
  originalAbs: string | null;
  hash: string | null;
  cacheKey: string | null;
  canonicalAbs: string | null;
  compressed: Promise<CompressResult> | null;
  onPool: boolean;
};

// Pull embedded textures out to sidecar files (deduping identical pixels across all GLBs),
// returning the index->relative-URI map to patch into the written GLB.
//
// Two passes, both in texture order. Pass 1 hashes each texture and settles what needs no
// compression — a dedup hit, a duplicate earlier in this same GLB, a texture the cache says
// cannot shrink — and hands everything else to the pool at once (a 63-texture model took 55 s
// serially). Pass 2 does the bookkeeping as results land, so the dedup index fills in the same
// order a serial loop would have and duplicates resolve to the first occurrence.
async function externalizeTextures(
  document: Document,
  glbAbsPath: string,
  relPath: string,
  state: RunState,
): Promise<Map<number, string>> {
  const { options, pool, cache } = state;
  const glbDir = path.dirname(glbAbsPath);
  const categoryMap = buildCategoryMap(document);
  const textures = document.getRoot().listTextures();
  const uriMap = new Map<number, string>();

  await fs.mkdir(state.texturesDirAbs, { recursive: true });

  const jobs: TextureJob[] = [];
  const scheduledByHash = new Set<string>();
  for (let i = 0; i < textures.length; i++) {
    const texture = textures[i];
    const image = texture.getImage();
    if (!image) continue;

    const buffer = Buffer.from(image);
    const mime = texture.getMimeType();
    const job: TextureJob = {
      index: i,
      texture,
      buffer,
      category: categoryMap.get(texture) ?? 'other',
      originalAbs: texture.getURI() ? resolveImageUri(glbAbsPath, texture.getURI()) : null,
      hash: options.textures.dedup || options.textures.compress ? await pixelHash(buffer) : null,
      cacheKey: null,
      canonicalAbs: null,
      compressed: null,
      onPool: false,
    };
    jobs.push(job);

    if (job.hash && options.textures.dedup) {
      const known = state.dedupIndex.get(job.hash);
      if (known) {
        job.canonicalAbs = known;
        continue;
      }
      if (scheduledByHash.has(job.hash)) continue;
      scheduledByHash.add(job.hash);
    }

    const cacheable =
      job.hash &&
      options.textures.compress &&
      mime === 'image/png' &&
      options.textures.format === 'png';
    if (cacheable) {
      job.cacheKey = TextureCache.key(job.hash!, job.category, options.textures);
      if (cache.hasNoGain(job.cacheKey, buffer.length)) {
        job.compressed = Promise.resolve({ data: buffer, ext: mimeToExtension(mime), mime });
        continue;
      }
    }
    job.compressed = pool.compress(buffer, job.category, mime, options.textures);
    job.onPool = true;
    // Pass 2 awaits this later; a rejection that lands while pass 1 is still hashing the next
    // texture would otherwise be an unhandled rejection and take the worker process down.
    job.compressed.catch(() => {});
  }

  const onPool = jobs.filter(job => job.onPool);
  if (onPool.length > 1) {
    let done = 0;
    for (const job of onPool) {
      job.compressed!.then(
        () => {
          done++;
          emitProgress(
            state.emit,
            'textures',
            state.progress.index,
            state.progress.total,
            `Optimizing ${relPath} · texture ${done}/${onPool.length}`,
            relPath,
          );
        },
        () => {},
      );
    }
  }

  for (const job of jobs) {
    const { hash, originalAbs, buffer } = job;
    let canonicalAbs = job.canonicalAbs;
    if (!canonicalAbs && !job.compressed && hash) canonicalAbs = state.dedupIndex.get(hash) ?? null;

    if (canonicalAbs) {
      if (canonicalAbs !== originalAbs) state.result.texturesDeduped++;
    } else {
      const { data, ext } = await job.compressed!;
      const noGain = data.length >= buffer.length;
      if (job.cacheKey && noGain) cache.rememberNoGain(job.cacheKey, buffer.length);
      if (originalAbs && noGain) {
        // Re-encoding an existing sidecar gained nothing: keep pointing at the original rather
        // than writing a same-size copy that would only supersede it.
        canonicalAbs = originalAbs;
      } else {
        const base = sanitizeFilename(
          path.parse(job.texture.getURI()).name ||
            job.texture.getName() ||
            `texture_${job.category}`,
        );
        const finalName = uniqueName(base, ext, state.usedNames);
        canonicalAbs = path.join(state.texturesDirAbs, finalName);
        await fs.writeFile(canonicalAbs, data);
        pushUnique(
          state.manifest.createdFiles,
          toPosix(path.relative(state.projectPath, canonicalAbs)),
        );
        state.result.texturesExtracted++;
        state.result.sidecarBytes += data.length;
      }
      if (hash && options.textures.dedup) state.dedupIndex.set(hash, canonicalAbs);
    }

    uriMap.set(job.index, toPosix(path.relative(glbDir, canonicalAbs)));
    job.texture.setImage(null);
    // Any branch above can land on a file whose format differs from the texture's source mime —
    // a re-encode to webp/jpeg, or a dedup hit on a sidecar written in another format — and the
    // writer emits the texture's mimeType verbatim beside the new uri.
    const sidecarMime = mimeForPath(canonicalAbs);
    if (sidecarMime) job.texture.setMimeType(sidecarMime);
  }

  return uriMap;
}

function isInsideTexturesDir(state: RunState, abs: string): boolean {
  const rel = path.relative(state.texturesDirAbs, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Every image file any GLB in the project still points at, as absolute paths.
async function collectReferencedImages(projectPath: string, glbs: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const rel of glbs) {
    const abs = path.join(projectPath, rel);
    let json: any;
    try {
      json = await readGlbJsonFromFile(abs);
    } catch {
      continue;
    }
    for (const img of json?.images ?? []) {
      if (typeof img.uri === 'string') referenced.add(resolveImageUri(abs, img.uri));
    }
  }
  return referenced;
}

// Which of `names` the scene's source, composites and JSON mention, so a texture the scene loads
// directly (UI images, material textures set in code) can be recognised. One file in memory at a
// time, and the walk stops as soon as every name has been seen.
async function findNamesInCode(projectPath: string, names: Set<string>): Promise<Set<string>> {
  const found = new Set<string>();
  const pending = new Set(names);
  async function walk(dir: string): Promise<void> {
    if (pending.size === 0) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (pending.size === 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name === 'bin' || entry.name.startsWith('.')) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const relDir = toPosix(path.relative(projectPath, dir)).split('/')[0];
        if (
          CODE_EXTENSIONS.has(ext) ||
          MODEL_TEXT_EXTENSIONS.has(ext) ||
          (ext === '.json' && CODE_JSON_DIRS.has(relDir))
        ) {
          const text = await fs.readFile(full, 'utf8');
          for (const name of pending) {
            if (text.includes(name)) {
              found.add(name);
              pending.delete(name);
            }
          }
        }
      }
    }
  }
  await walk(projectPath);
  return found;
}

// Move superseded original textures into the backup. Runs after every GLB is written, so the
// "still referenced" check sees the final state: a texture shared with a GLB that kept it, or
// one the scene code loads by name, stays where it is.
async function removeSupersededTextures(state: RunState, glbs: string[]): Promise<void> {
  if (state.externalBefore.size === 0) return;
  const { projectPath } = state;
  const referenced = await collectReferencedImages(projectPath, glbs);
  const candidates = [...state.externalBefore].filter(abs => !referenced.has(abs));
  const mentioned = await findNamesInCode(
    projectPath,
    new Set(candidates.map(abs => path.basename(abs))),
  );

  for (const abs of candidates) {
    if (mentioned.has(path.basename(abs))) continue;
    const rel = toPosix(path.relative(projectPath, abs));
    if (rel.startsWith('..')) continue;
    let bytes: number;
    try {
      bytes = (await fs.stat(abs)).size;
    } catch {
      continue;
    }

    if (isInsideTexturesDir(state, abs)) {
      // One of OUR sidecars that nothing points at anymore: an earlier run's output, superseded
      // now that this run's options wrote `foo_2.png` beside it. It has to go, or every re-run
      // adds another unreferenced file to the deployed scene. Stashing it is the wrong move —
      // it is tracked in createdFiles, which revert deletes, so revert would restore and delete
      // the same path. Drop the file and stop tracking it instead. A file the creator put in the
      // sidecar folder themselves is not in createdFiles, and is left alone.
      const tracked = state.manifest.createdFiles.indexOf(rel);
      if (tracked === -1) continue;
      await fs.rm(abs, { force: true });
      state.manifest.createdFiles.splice(tracked, 1);
    } else {
      await stashFile(projectPath, rel);
      pushUnique(state.manifest.removedFiles, rel);
    }
    state.result.texturesRemoved++;
    state.result.removedBytes += bytes;
  }
}

// Recompress (and optionally dedup) textures while keeping them embedded in the GLB.
async function recompressEmbedded(document: Document, state: RunState): Promise<void> {
  const { options } = state;
  const categoryMap = buildCategoryMap(document);

  if (options.textures.compress) {
    const textures = document
      .getRoot()
      .listTextures()
      .filter(texture => texture.getImage());
    const results = await Promise.all(
      textures.map(texture =>
        state.pool.compress(
          Buffer.from(texture.getImage()!),
          categoryMap.get(texture) ?? 'other',
          texture.getMimeType(),
          options.textures,
        ),
      ),
    );
    textures.forEach((texture, i) => {
      texture.setImage(new Uint8Array(results[i].data));
      texture.setMimeType(results[i].mime);
    });
  }

  if (options.textures.dedup) {
    await document.transform(dedup());
  }
}

async function processGlb(relPath: string, state: RunState): Promise<void> {
  const { projectPath, io, options } = state;
  const glbAbsPath = path.join(projectPath, relPath);

  const stat = await fs.stat(glbAbsPath);
  const fileResult: OptimizeFileResult = {
    file: relPath,
    status: 'unchanged',
    bytesBefore: stat.size,
    bytesAfter: stat.size,
    texturesExtracted: 0,
    texturesDeduped: 0,
  };

  const recorded = state.manifest.outputs[relPath];
  if (
    recorded &&
    recorded.options === state.optionsKey &&
    recorded.size === stat.size &&
    recorded.mtimeMs === stat.mtimeMs
  ) {
    fileResult.status = 'up_to_date';
    state.result.files.push(fileResult);
    return;
  }

  const rawBuf = await fs.readFile(glbAbsPath);

  // Snapshot the global texture counters so we can attribute this file's share.
  const extractedBefore = state.result.texturesExtracted;
  const dedupedBefore = state.result.texturesDeduped;

  const anyWork =
    options.mesh.enabled ||
    options.textures.externalize ||
    options.textures.compress ||
    options.textures.dedup;
  if (!anyWork) {
    state.result.files.push(fileResult);
    return;
  }

  let document: Document;
  try {
    document = await io.read(glbAbsPath);
  } catch {
    fileResult.status = 'skipped';
    state.result.files.push(fileResult);
    return;
  }

  const glbJson = readGlbJson(rawBuf);
  for (const img of glbJson?.images ?? []) {
    if (typeof img.uri === 'string') state.externalBefore.add(resolveImageUri(glbAbsPath, img.uri));
  }

  const doMesh = options.mesh.enabled;
  // gltf-transform embeds every image when it writes a .glb, so a model whose textures already
  // live in sidecar files must be re-externalized (into the sidecar folder, through the same
  // compress/dedup options) even when the user left externalize off — otherwise a mesh-only run
  // would pull its textures back inside and grow the file. The original sidecars stay on disk,
  // untouched, so revert restores a consistent model.
  const doExternalize = options.textures.externalize || hasExternalImages(glbJson);
  const doEmbedded = !doExternalize && (options.textures.compress || options.textures.dedup);

  if (doMesh) await runMeshPass(document, options.mesh);

  let uriMap: Map<number, string> | null = null;
  if (doExternalize) {
    uriMap = await externalizeTextures(document, glbAbsPath, relPath, state);
  } else if (doEmbedded) {
    await recompressEmbedded(document, state);
  }

  fileResult.texturesExtracted = state.result.texturesExtracted - extractedBefore;
  fileResult.texturesDeduped = state.result.texturesDeduped - dedupedBefore;

  await backupFile(projectPath, relPath);
  pushUnique(state.manifest.modifiedGlbs, relPath);
  // The manifest has to name this backup BEFORE the original is overwritten: a crash between
  // the two would otherwise leave a pristine copy that no revert knows about.
  await writeManifest(projectPath, state.manifest);

  await io.write(glbAbsPath, document);
  if (uriMap && uriMap.size > 0) await patchGlbImageURIs(glbAbsPath, uriMap);

  const written = await fs.stat(glbAbsPath);
  state.manifest.outputs[relPath] = {
    size: written.size,
    mtimeMs: written.mtimeMs,
    options: state.optionsKey,
  };
  state.result.glbsChanged++;
  fileResult.status = 'optimized';
  fileResult.bytesAfter = written.size;
  state.result.files.push(fileResult);
}

export async function runPipeline(
  projectPath: string,
  options: OptimizeOptions,
  emit: ProgressSink,
  deps: { pool?: CompressPool } = {},
): Promise<OptimizeResult> {
  // First run is a cold start: the native/WASM tools (sharp, meshoptimizer) load and
  // compile here, which takes a moment before any file is touched. Tell the user so it doesn't
  // look frozen — the message is shown on the modal's progress bar.
  emitProgress(emit, 'prepare', 0, 0, 'Preparing optimizer (loading tools)…');
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const glbs = await walkGlbs(projectPath);
  const total = glbs.length;
  const before = await measureFootprint(projectPath, glbs);

  // Re-runs merge into the previous manifest: revert must undo EVERY run since the last revert,
  // and `backupFile` already keeps the first (pristine) copy of a GLB across runs.
  const manifest = (await readManifest(projectPath)) ?? createManifest();

  const state: RunState = {
    io: createIO(),
    emit,
    options,
    projectPath,
    texturesDirAbs: path.join(projectPath, manifest.texturesDir),
    usedNames: new Set<string>(),
    dedupIndex: new Map<string, string>(),
    externalBefore: new Set<string>(),
    manifest,
    pool: deps.pool ?? createInlinePool(),
    cache: await TextureCache.read(projectPath),
    optionsKey: crypto.createHash('sha1').update(JSON.stringify(options)).digest('hex'),
    progress: { index: 0, total },
    result: {
      glbsProcessed: 0,
      glbsChanged: 0,
      texturesExtracted: 0,
      texturesDeduped: 0,
      texturesRemoved: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      sidecarBytes: 0,
      removedBytes: 0,
      ignoredFiles: [],
      files: [],
    },
  };

  emitProgress(emit, 'backup', 0, total, 'Preparing backup…');
  await ensureDclignoreBlock(projectPath);
  await seedFromExistingSidecars(state);
  // Until the run completes, the sidecars on disk are a mix of the previous run's and this one's
  // — so the manifest on disk must not vouch for them with either options key. The per-output
  // records still let a run that resumes after a crash tell them apart.
  state.manifest.optionsKey = null;
  await writeManifest(projectPath, state.manifest);

  for (let i = 0; i < glbs.length; i++) {
    const rel = glbs[i];
    state.progress.index = i;
    emitProgress(emit, 'textures', i, total, `Optimizing ${rel}`, rel);
    try {
      await processGlb(rel, state);
    } catch (error: any) {
      emitProgress(emit, 'error', i, total, `Failed on ${rel}: ${error.message}`, rel);
      // Without a record here, a run where every single model threw still resolves and reports
      // "succeeded" with an empty file list — indistinguishable from "nothing needed doing".
      const bytes = await fs.stat(path.join(projectPath, rel)).then(
        stat => stat.size,
        () => 0,
      );
      state.result.files.push({
        file: rel,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        bytesBefore: bytes,
        bytesAfter: bytes,
        texturesExtracted: 0,
        texturesDeduped: 0,
      });
    }
    state.result.glbsProcessed++;
    // Checkpoint, so a kill mid-run leaves a manifest that maps every backup and sidecar so far.
    await writeManifest(projectPath, state.manifest);
  }

  emitProgress(emit, 'write', total, total, 'Removing superseded textures…');
  await removeSupersededTextures(state, glbs);
  // Same definition as the scan line (GLBs + every texture they reference), so the modal's
  // "before → after" and its post-run scan total agree instead of differing by the originals
  // the run left in place because they were already optimal.
  const after = await measureFootprint(projectPath, glbs);
  state.result.bytesBefore = before.glbBytes + before.textureBytes;
  state.result.bytesAfter = after.glbBytes + after.textureBytes;

  emitProgress(emit, 'write', total, total, 'Writing manifest…');
  state.manifest.optionsKey = state.optionsKey;
  await writeManifest(projectPath, state.manifest);
  await state.cache.write(projectPath);
  state.result.ignoredFiles = await findIgnoredSidecars(projectPath, state.manifest.createdFiles);

  emitProgress(emit, 'done', total, total, 'Optimization complete');
  return state.result;
}

// Sidecars the deploy would silently drop. A creator's own `.dclignore` glob (`**/Pride*` to keep
// a work-in-progress folder out) can match a sidecar named after its texture, and nothing else in
// the flow would ever say so — the scene just loads with missing textures.
async function findIgnoredSidecars(projectPath: string, createdFiles: string[]): Promise<string[]> {
  if (createdFiles.length === 0) return [];
  let text = '';
  try {
    text = await fs.readFile(path.join(projectPath, '.dclignore'), 'utf8');
  } catch {
    return [];
  }
  const ignored = createIgnoreMatcher([...parseDclignore(text), ...DEFAULT_DCLIGNORE]);
  return createdFiles.filter(ignored);
}
