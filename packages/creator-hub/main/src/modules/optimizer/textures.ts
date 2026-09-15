import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

import {
  DEFAULT_OPTIMIZE_OPTIONS,
  type DenoiseLevel,
  type TextureCategory,
  type TextureFormat,
  type TextureOptions,
} from '/shared/types/optimizer';

// Texture classification + compression, adapted from decentraland/SceneOptimizer
// (utils.js + compress.js). Everything goes through sharp: resizing, denoising, the
// 16-bit → 8-bit depth reduction, the lossless PNG re-encode, and the JPEG/WebP quality slider.

export const CATEGORY_PRIORITY: Record<TextureCategory, number> = {
  baseColor: 5,
  normal: 4,
  orm: 3,
  emissive: 2,
  other: 1,
};

const SLOT_MAP: Record<string, TextureCategory> = {
  baseColorTexture: 'baseColor',
  metallicRoughnessTexture: 'orm',
  normalTexture: 'normal',
  occlusionTexture: 'orm',
  emissiveTexture: 'emissive',
};

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const FORMAT_TO_EXT: Record<TextureFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
};

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const FORMAT_TO_MIME: Record<TextureFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// Lossless, and where the PNG gain actually is. sharp's defaults (compressionLevel 6, adaptive
// filtering off) are roughly what an exporter writes, so leaving them alone means re-encoding for
// nothing. Measured over real 1024²/1920² scene textures: 11.70 MB → 6.85 MB (41% off) at these
// settings, against 8.72 MB (25%) for the `@wasm-codecs/oxipng` pass they replaced, in under half
// the time. NOTE: do NOT add `effort` here — sharp turns that into `palette: true`, which
// quantises to 256 colours and is lossy.
const PNG_ENCODE = { compressionLevel: 9, adaptiveFiltering: true } as const;

const DENOISE_SETTINGS: Record<
  DenoiseLevel,
  { median: number; sharpen?: { sigma: number } } | null
> = {
  off: null,
  light: { median: 3, sharpen: { sigma: 0.5 } },
  medium: { median: 3, sharpen: { sigma: 0.8 } },
  strong: { median: 5, sharpen: { sigma: 1.0 } },
};

export function classifyTextureSlot(slotName: string): TextureCategory {
  return SLOT_MAP[slotName] ?? 'other';
}

export function mimeToExtension(mimeType: string | null): string {
  return (mimeType && MIME_TO_EXT[mimeType]) || '.png';
}

export function extensionForFormat(format: TextureFormat): string {
  return FORMAT_TO_EXT[format];
}

// The glTF writer copies `images[].mimeType` straight through, so a texture pointed at a sidecar
// must carry that file's type: a loader trusting mimeType over the extension would otherwise
// decode a `.webp` as the PNG the source claimed to be. Null when the extension says nothing —
// keep whatever the texture already had.
export function mimeForPath(filePath: string): string | null {
  return EXT_TO_MIME[path.extname(filePath).toLowerCase()] ?? null;
}

// A sidecar name ends up verbatim in a glTF URI, which loaders treat as a URL: besides the
// filesystem-hostile set, drop the URL-reserved characters (`#` fragment, `%` escape, `&`, `+`,
// `;`, `=`) rather than percent-encode them, since not every explorer decodes consistently.
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- control chars are intentionally stripped from filenames
  return name.replace(/[<>:"/\\|?*#%&+;=\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

// SHA-256 of the decoded (raw) pixels, so two textures with identical content but different
// encodings/names still dedup. Returns null when sharp can't decode (e.g. KTX2/Basis).
export async function pixelHash(input: Buffer): Promise<string | null> {
  try {
    const raw = await sharp(input).raw().toBuffer();
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return null;
  }
}

export type CompressResult = { data: Buffer; ext: string; mime: string };

type SharpPipeline = ReturnType<typeof sharp>;

// Resize/re-encode a single texture. When `options.compress` is false the bytes are passed
// through unchanged (keeping their original extension) — callers still use this to get a
// consistent { data, ext, mime } shape.
export async function compressImage(
  input: Buffer,
  category: TextureCategory,
  sourceMime: string | null,
  options: TextureOptions,
): Promise<CompressResult> {
  if (!options.compress) {
    return { data: input, ext: mimeToExtension(sourceMime), mime: sourceMime || 'image/png' };
  }

  const format = options.format;
  // A size of 0 (or a negative one) reaches sharp as `resize(null, 0)`, which throws for EVERY
  // texture — one empty field in the UI would fail an entire run. Floor it here too, so no
  // caller can turn a bad number into a scene-wide failure. A missing size (an options object
  // from an older app) would make that floor NaN, so it falls back to the default instead.
  const maxHeight = Math.max(
    1,
    options.sizes?.[category] ??
      options.sizes?.other ??
      DEFAULT_OPTIMIZE_OPTIONS.textures.sizes.other,
  );
  const denoise = DENOISE_SETTINGS[options.denoise];

  let metadata: Awaited<ReturnType<SharpPipeline['metadata']>>;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    // Undecodable by sharp — leave it untouched.
    return { data: input, ext: mimeToExtension(sourceMime), mime: sourceMime || 'image/png' };
  }

  const needsResize = (metadata.height ?? 0) > maxHeight;
  // 16-bit PNGs are dead weight for a GPU texture (every DCL runtime uploads 8-bit): on Genesis
  // Plaza 19 such files held 36 MB that the sharp re-encode below (which writes 8-bit) cuts to
  // ~8 MB. Counted as a transform so the re-encode is always kept for them.
  const needsDepthReduction = metadata.depth === 'ushort';
  const needsTransform = needsResize || !!denoise || needsDepthReduction;

  const applyTransforms = (pipeline: SharpPipeline): SharpPipeline => {
    let p = pipeline;
    if (needsResize) p = p.resize(null, maxHeight, { withoutEnlargement: true });
    if (denoise) {
      p = p.median(denoise.median);
      if (denoise.sharpen) p = p.sharpen(denoise.sharpen);
    }
    return p;
  };

  if (format === 'png') {
    // Re-encoded even when there is nothing to resize: PNG_ENCODE is the whole optimization for
    // a texture that is already the right size.
    const encoded = await applyTransforms(sharp(input)).png(PNG_ENCODE).toBuffer();
    // Handing back a re-encode that gained nothing is strictly worse than the bytes we were
    // given, and `recompressEmbedded` writes back whatever it receives. Only safe to keep the
    // original when it IS a PNG already and nothing had to be applied to it.
    const worthIt = needsTransform || metadata.format !== 'png' || encoded.length < input.length;
    return { data: worthIt ? encoded : input, ext: '.png', mime: 'image/png' };
  }

  let pipeline = applyTransforms(sharp(input));
  if (format === 'jpeg') {
    if (metadata.channels === 4) {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }
    pipeline = pipeline.jpeg({ quality: options.quality });
  } else {
    pipeline = pipeline.webp({ quality: options.quality });
  }

  const data = await pipeline.toBuffer();
  return { data, ext: FORMAT_TO_EXT[format], mime: FORMAT_TO_MIME[format] };
}
