import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import type { OptimizeScanResult } from '/shared/types/optimizer';

import { LEGACY_TEXTURES_DIR, OPTIMIZE_DIR, TEXTURES_DIR, readManifest, toPosix } from './backup';
import { readGlbJsonFromFile } from './glb';

export { TEXTURES_DIR };

// Everything here is plain fs work shared by the Electron main process (scan, revert) and the
// optimizer worker (pipeline). It must stay free of the downloaded toolchain: main never has
// sharp / gltf-transform on its module path.

// Dir NAMES never walked: VCS/deps and our own backup. The sidecar folders are skipped by
// project-relative path below, since the current one is nested.
export const SKIP_DIRS = new Set(['node_modules', '.git', OPTIMIZE_DIR]);
const SKIP_PATHS = new Set([TEXTURES_DIR, LEGACY_TEXTURES_DIR]);

export function resolveImageUri(glbAbsPath: string, uri: string): string {
  return path.resolve(path.dirname(glbAbsPath), decodeURIComponent(uri));
}

// Recursively collect GLB files under the project, as project-relative posix paths.
export async function walkGlbs(projectPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (SKIP_PATHS.has(toPosix(path.relative(projectPath, full)))) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) {
        results.push(toPosix(path.relative(projectPath, full)));
      }
    }
  }
  await walk(projectPath);
  results.sort();
  return results;
}

export type Footprint = Pick<
  OptimizeScanResult,
  'glbBytes' | 'textureBytes' | 'embeddedTextureCount' | 'externalTextureCount'
>;

// The scene's model+texture weight: every GLB plus each external texture file they reference,
// counted once. Both the scan line and a run's before/after use this, so the two agree.
export async function measureFootprint(projectPath: string, glbs: string[]): Promise<Footprint> {
  let glbBytes = 0;
  let embeddedTextureCount = 0;
  const externalTextures = new Set<string>();

  for (const rel of glbs) {
    const abs = path.join(projectPath, rel);
    try {
      glbBytes += (await fs.stat(abs)).size;
      const json = await readGlbJsonFromFile(abs);
      for (const img of json?.images ?? []) {
        if (typeof img.uri === 'string') externalTextures.add(resolveImageUri(abs, img.uri));
        else if (img.bufferView !== undefined) embeddedTextureCount++;
      }
    } catch {
      // ignore unreadable files in the summary
    }
  }

  let textureBytes = 0;
  for (const abs of externalTextures) {
    try {
      textureBytes += (await fs.stat(abs)).size;
    } catch {
      // a dangling reference weighs nothing
    }
  }

  return {
    glbBytes,
    textureBytes,
    embeddedTextureCount,
    externalTextureCount: externalTextures.size,
  };
}

export async function scan(projectPath: string): Promise<OptimizeScanResult> {
  const glbs = await walkGlbs(projectPath);
  const footprint = await measureFootprint(projectPath, glbs);
  const manifest = await readManifest(projectPath);
  return {
    glbCount: glbs.length,
    totalBytes: footprint.glbBytes + footprint.textureBytes,
    ...footprint,
    hasBackup: manifest !== null,
    lastOptimizedAt: manifest?.updatedAt ?? null,
  };
}
