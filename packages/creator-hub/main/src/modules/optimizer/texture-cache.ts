import fs from 'node:fs/promises';
import path from 'node:path';

import type { TextureCategory, TextureOptions } from '/shared/types/optimizer';

import { optimizeDir } from './backup';

// Textures the re-encode could not shrink, remembered across runs. On Genesis Plaza 266 originals
// were already optimal, and finding that out costs a full re-encode each — a third of every run,
// for nothing. The key is the pixel hash (already computed for dedup) plus every compress option
// the outcome depends on; the value is the byte size that had no gain, so a re-encoded, larger
// file with the same pixels is still tried. Lives in `.optimize/`, so a revert clears it with
// the backup.

const CACHE_FILE = 'texture-cache.json';
const CACHE_VERSION = 1;

type CacheFile = { version: number; noGain: Record<string, number> };

export class TextureCache {
  private readonly noGain: Map<string, number>;
  private dirty = false;

  constructor(entries: Record<string, number> = {}) {
    this.noGain = new Map(Object.entries(entries));
  }

  get size(): number {
    return this.noGain.size;
  }

  static key(pixelHash: string, category: TextureCategory, options: TextureOptions): string {
    return [
      pixelHash,
      options.format,
      options.sizes[category] ?? options.sizes.other,
      options.denoise,
      options.format === 'png' ? '' : options.quality,
    ].join('|');
  }

  // True when compressing pixels `pixelHash` of `bytes` bytes (or fewer) is known to gain nothing.
  hasNoGain(key: string, bytes: number): boolean {
    const known = this.noGain.get(key);
    return known !== undefined && bytes <= known;
  }

  rememberNoGain(key: string, bytes: number): void {
    const known = this.noGain.get(key);
    if (known !== undefined && known >= bytes) return;
    this.noGain.set(key, bytes);
    this.dirty = true;
  }

  toJSON(): CacheFile {
    return { version: CACHE_VERSION, noGain: Object.fromEntries(this.noGain) };
  }

  static async read(projectPath: string): Promise<TextureCache> {
    try {
      const raw = await fs.readFile(path.join(optimizeDir(projectPath), CACHE_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version !== CACHE_VERSION || typeof parsed.noGain !== 'object') {
        return new TextureCache();
      }
      return new TextureCache(parsed.noGain ?? {});
    } catch {
      return new TextureCache();
    }
  }

  async write(projectPath: string): Promise<void> {
    if (!this.dirty) return;
    const dir = optimizeDir(projectPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, CACHE_FILE), JSON.stringify(this.toJSON(), null, 2));
    this.dirty = false;
  }
}
