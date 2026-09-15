import fs from 'node:fs/promises';
import path from 'node:path';

// Reversibility layer, borrowing Genesis-Plaza dedup.cjs's pattern: pristine originals are
// mirrored into a single `.optimize/backup/` dir tracked by a manifest, and that dir is
// excluded from the deploy bundle via a marker-delimited `.dclignore` block that revert can
// strip exactly. The newly created sidecar textures are NOT ignored — they must deploy.

export const OPTIMIZE_DIR = '.optimize';
// Where externalized textures go, under the inspector-managed `assets/` folder so they show in
// Local Assets. Not dot-prefixed: these files must deploy, unlike the backup. Scenes optimized
// before the move keep their folder — the manifest records which one a scene uses.
// GLBs reach it through `../` URIs; the Bevy explorer resolves those only from
// decentraland/bevy-explorer commit 7546497 on (older builds render such models with just their
// emissive map). That is a client bug, fixed there — don't work around it by relocating textures.
export const TEXTURES_DIR = 'assets/optimized-textures';
export const LEGACY_TEXTURES_DIR = 'optimized-textures';
const BACKUP_SUBDIR = 'backup';
const MANIFEST_NAME = 'manifest.json';
const DCLIGNORE = '.dclignore';
const DCLIGNORE_MARKER = '# --- creator-hub optimize backup (auto-generated, do not edit) ---';
const DCLIGNORE_END_MARKER = '# --- end creator-hub optimize backup ---';
// Entry count of the block as written before the end marker existed, so those can still be
// stripped exactly.
const LEGACY_BLOCK_LINES = 3;
const MANIFEST_VERSION = 1;

// What a run left on disk for one GLB, so the next run can tell "still my output, same options"
// from a file the creator re-exported. Re-processing an already-optimized GLB rewrites it with a
// fraction-of-a-percent size change (re-serialization, not rounding) and costs a full pass.
export type OutputRecord = {
  size: number;
  mtimeMs: number;
  options: string; // hash of the OptimizeOptions the output was produced with
};

export type OptimizeManifest = {
  version: number;
  createdAt: number;
  updatedAt: number; // last run that wrote this manifest
  texturesDir: string; // project-relative posix dir the sidecars live in (see TEXTURES_DIR)
  // Options hash the sidecars currently on disk were produced with, so the next run can tell its
  // own reusable output from a previous run's, which was encoded to different sizes/format.
  // Null in manifests written before this field existed — treated as "not reusable".
  optionsKey: string | null;
  modifiedGlbs: string[]; // project-relative posix paths of GLBs overwritten in place
  createdFiles: string[]; // project-relative posix paths of sidecar textures written
  // project-relative posix paths of original textures moved into the backup because a
  // sidecar superseded them (absent in manifests written before this field existed)
  removedFiles: string[];
  outputs: Record<string, OutputRecord>; // keyed by the GLB's project-relative posix path
};

const toPosix = (value: string) => value.split(path.sep).join('/');

// Every path the manifest names is joined onto the project (or its backup mirror) and then
// copied to or deleted. The manifest is a plain JSON file inside the scene, so an entry like
// `../../.zshrc` must not turn a revert into a write outside the project.
export function resolveInside(root: string, relPath: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relPath);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch "${relPath}": it resolves outside the project`);
  }
  return abs;
}

export function optimizeDir(projectPath: string): string {
  return path.join(projectPath, OPTIMIZE_DIR);
}

function backupDir(projectPath: string): string {
  return path.join(optimizeDir(projectPath), BACKUP_SUBDIR);
}

function manifestPath(projectPath: string): string {
  return path.join(optimizeDir(projectPath), MANIFEST_NAME);
}

export async function readManifest(projectPath: string): Promise<OptimizeManifest | null> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(manifestPath(projectPath), 'utf8'),
    ) as Partial<OptimizeManifest> & Pick<OptimizeManifest, 'version' | 'createdAt'>;
    // Fields added after the first manifests shipped default to what those runs did.
    return {
      modifiedGlbs: [],
      createdFiles: [],
      ...manifest,
      updatedAt: manifest.updatedAt ?? manifest.createdAt,
      texturesDir: manifest.texturesDir ?? LEGACY_TEXTURES_DIR,
      removedFiles: manifest.removedFiles ?? [],
      optionsKey: manifest.optionsKey ?? null,
      outputs: manifest.outputs ?? {},
    };
  } catch {
    return null;
  }
}

// Returns the manifest as written (with this write's `updatedAt`); the input is left untouched.
export async function writeManifest(
  projectPath: string,
  manifest: OptimizeManifest,
): Promise<OptimizeManifest> {
  const written = { ...manifest, updatedAt: Date.now() };
  await fs.mkdir(optimizeDir(projectPath), { recursive: true });
  await fs.writeFile(manifestPath(projectPath), JSON.stringify(written, null, 2), 'utf8');
  return written;
}

export function createManifest(): OptimizeManifest {
  return {
    version: MANIFEST_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    texturesDir: TEXTURES_DIR,
    modifiedGlbs: [],
    createdFiles: [],
    removedFiles: [],
    optionsKey: null,
    outputs: {},
  };
}

export async function hasBackup(projectPath: string): Promise<boolean> {
  return (await readManifest(projectPath)) !== null;
}

// Mirror an original file into the backup dir, once. `relPath` is project-relative posix.
export async function backupFile(projectPath: string, relPath: string): Promise<void> {
  const source = resolveInside(projectPath, relPath);
  const dest = resolveInside(backupDir(projectPath), relPath);
  try {
    await fs.access(dest);
    return; // already backed up (idempotent across re-runs before a revert)
  } catch {
    // not yet backed up
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
}

// Move a project file into the backup (same relative path), so revert can put it back.
export async function stashFile(projectPath: string, relPath: string): Promise<void> {
  await backupFile(projectPath, relPath);
  await fs.rm(resolveInside(projectPath, relPath), { force: true });
}

export async function ensureDclignoreBlock(projectPath: string): Promise<void> {
  const file = path.join(projectPath, DCLIGNORE);
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    // no .dclignore yet — create one
  }
  if (existing.includes(DCLIGNORE_MARKER)) return;

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const block = [DCLIGNORE_MARKER, OPTIMIZE_DIR, `${OPTIMIZE_DIR}/**`, DCLIGNORE_END_MARKER].join(
    '\n',
  );
  await fs.writeFile(file, `${existing}${prefix}${block}\n`, 'utf8');
}

export async function stripDclignoreBlock(projectPath: string): Promise<void> {
  const file = path.join(projectPath, DCLIGNORE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  const markerIdx = text.indexOf(DCLIGNORE_MARKER);
  if (markerIdx === -1) return;

  // Everything from the marker through the end marker goes; a block written before the end
  // marker existed is exactly LEGACY_BLOCK_LINES long. A preceding newline goes with it.
  let start = markerIdx;
  if (start > 0 && text[start - 1] === '\n') start -= 1;
  const lines = text.slice(markerIdx).split('\n');
  const endIdx = lines.indexOf(DCLIGNORE_END_MARKER);
  const removed = lines.slice(0, endIdx === -1 ? LEGACY_BLOCK_LINES : endIdx + 1).join('\n');
  const rest = text.slice(markerIdx + removed.length);
  const cleaned = text.slice(0, start) + rest;

  if (cleaned.trim().length === 0) {
    await fs.rm(file, { force: true });
  } else {
    await fs.writeFile(file, cleaned, 'utf8');
  }
}

// Restore originals from backup, delete created sidecars, strip the .dclignore block, and
// remove the .optimize dir. Returns the count of restored GLBs.
export async function revertFromManifest(
  projectPath: string,
  manifest: OptimizeManifest,
): Promise<number> {
  // Every entry is checked before the first byte moves, so a tampered manifest fails the whole
  // revert instead of restoring half the scene and then throwing.
  const modified = manifest.modifiedGlbs.map(rel => resolvePair(projectPath, rel));
  const created = manifest.createdFiles.map(rel => resolveInside(projectPath, rel));
  const removed = (manifest.removedFiles ?? []).map(rel => resolvePair(projectPath, rel));
  const texturesDir = resolveInside(projectPath, manifest.texturesDir);

  let restored = 0;
  for (const { backup, target } of modified) {
    if (await restoreFile(backup, target)) restored++;
  }

  for (const abs of created) {
    await fs.rm(abs, { force: true });
  }

  for (const { backup, target } of removed) {
    await restoreFile(backup, target);
  }

  await stripDclignoreBlock(projectPath);
  await fs.rm(optimizeDir(projectPath), { recursive: true, force: true });
  // rmdir only succeeds on an empty dir, so a folder the creator also put files in is preserved.
  await fs.rmdir(texturesDir).catch(() => {});
  return restored;
}

function resolvePair(projectPath: string, rel: string): { backup: string; target: string } {
  return {
    backup: resolveInside(backupDir(projectPath), rel),
    target: resolveInside(projectPath, rel),
  };
}

// False when there is nothing in the backup for this entry (skipped, not an error).
async function restoreFile(backup: string, target: string): Promise<boolean> {
  try {
    await fs.access(backup);
  } catch {
    return false;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(backup, target);
  return true;
}

export { toPosix };
