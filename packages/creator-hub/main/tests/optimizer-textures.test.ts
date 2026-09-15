import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { DEFAULT_OPTIMIZE_OPTIONS, type TextureOptions } from '/shared/types/optimizer';

import { compressImage } from '../src/modules/optimizer/textures';

function options(overrides: Partial<TextureOptions> = {}): TextureOptions {
  return { ...structuredClone(DEFAULT_OPTIMIZE_OPTIONS.textures), ...overrides };
}

function noisyRaw(size: number): Buffer {
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) & 255;
  return raw;
}

async function png16(size = 32): Promise<Buffer> {
  return sharp(noisyRaw(size), { raw: { width: size, height: size, channels: 4 } })
    .toColourspace('rgb16')
    .png({ compressionLevel: 0 })
    .toBuffer();
}

async function png8(size = 32): Promise<Buffer> {
  return sharp(noisyRaw(size), { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// 8-bit RGBA of the decoded image, so a lossless colour-TYPE change (RGBA -> RGB on a fully
// opaque image) does not read as pixel loss.
async function pixels(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).ensureAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer();
}

describe('compressImage', () => {
  describe('the PNG re-encode', () => {
    it('should shrink the file without touching a pixel', async () => {
      const input = await sharp(noisyRaw(64), { raw: { width: 64, height: 64, channels: 4 } })
        .png({ compressionLevel: 0 })
        .toBuffer();

      const { data } = await compressImage(input, 'baseColor', 'image/png', options());

      expect(data.length).toBeLessThan(input.length);
      // Guards the one-word mistake: adding `effort` to sharp's png() options silently turns on
      // `palette: true`, which quantises to 256 colours. It reads as a ~40% extra win on the
      // scales and changes every pixel of a texture.
      expect(Buffer.compare(await pixels(data), await pixels(input))).toBe(0);
    });
  });

  describe('when the source is a 16-bit PNG', () => {
    it('should re-encode it as 8-bit, smaller, even when it needs no resize', async () => {
      const input = await png16();
      expect((await sharp(input).metadata()).depth).toBe('ushort');

      const { data, ext } = await compressImage(input, 'baseColor', 'image/png', options());

      const meta = await sharp(data).metadata();
      expect(ext).toBe('.png');
      expect(meta.depth).toBe('uchar');
      expect(meta.width).toBe(32);
      expect(data.length).toBeLessThan(input.length);
    });
  });

  describe('when the source is an 8-bit PNG the re-encode cannot improve', () => {
    it('should return the original bytes so the caller can keep the file in place', async () => {
      const input = await png8();
      const alreadyOptimal = (await compressImage(input, 'baseColor', 'image/png', options())).data;

      const { data } = await compressImage(alreadyOptimal, 'baseColor', 'image/png', options());

      // Identity, not just the same length: re-encoding its own output gains nothing, so the
      // bytes handed in must come straight back for `noGain` to keep the file in place.
      expect(Buffer.compare(data, alreadyOptimal)).toBe(0);
      expect((await sharp(data).metadata()).depth).toBe('uchar');
    });
  });

  describe('when the source is taller than its category cap', () => {
    it('should resize to the cap and keep the aspect ratio', async () => {
      const input = await sharp(noisyRaw(64), { raw: { width: 64, height: 64, channels: 4 } })
        .png()
        .toBuffer();

      const { data } = await compressImage(
        input,
        'orm',
        'image/png',
        options({ sizes: { ...DEFAULT_OPTIMIZE_OPTIONS.textures.sizes, orm: 16 } }),
      );

      const meta = await sharp(data).metadata();
      expect(meta.height).toBe(16);
      expect(meta.width).toBe(16);
    });
  });

  describe('when compression is off', () => {
    it('should pass the bytes through with their original extension', async () => {
      const input = await png16();

      const result = await compressImage(
        input,
        'other',
        'image/jpeg',
        options({ compress: false }),
      );

      expect(result.data).toBe(input);
      expect(result.ext).toBe('.jpg');
    });
  });
});
