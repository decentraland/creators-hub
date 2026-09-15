import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixGlbAlignment, patchGlbImageURIs, readGlbJson } from '../src/modules/optimizer/glb';
import { buildQuad, gradientPng, writeEmbeddedGlb } from './helpers/optimizer-fixtures';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

// A GLB assembled by hand, with the JSON chunk left exactly as long as its text — which is
// what a spec-violating exporter produces when the text length is not a multiple of 4.
function rawGlb(json: object, bin: Buffer): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonBuf.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length);
  out.writeUInt32LE(BIN_CHUNK, 24 + jsonBuf.length);
  bin.copy(out, 28 + jsonBuf.length);
  return out;
}

function binChunk(glb: Buffer): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const start = 20 + jsonLength;
  const length = glb.readUInt32LE(start);
  return glb.subarray(start + 8, start + 8 + length);
}

describe('GLB helpers', () => {
  describe('fixGlbAlignment', () => {
    it('should pad a misaligned JSON chunk to 4 bytes and keep the JSON readable', () => {
      const json = { asset: { version: '2.0' }, extras: { note: 'x' } };
      expect(Buffer.byteLength(JSON.stringify(json)) % 4).not.toBe(0);
      const bin = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

      const fixed = fixGlbAlignment(rawGlb(json, bin));

      expect(fixed.readUInt32LE(12) % 4).toBe(0);
      expect(fixed.readUInt32LE(8)).toBe(fixed.length);
      expect(readGlbJson(fixed)).toEqual(json);
      expect(Buffer.compare(binChunk(fixed), bin)).toBe(0);
    });

    it('should return an already aligned buffer untouched', () => {
      // rawGlb writes no padding, so alignment depends on the text length: this one is 52 bytes
      const json = { asset: { version: '2.0' }, extras: { pad: 'abcde' } };
      const glb = rawGlb(json, Buffer.alloc(4));
      expect(glb.readUInt32LE(12) % 4).toBe(0);

      expect(fixGlbAlignment(glb)).toBe(glb);
    });

    it('should leave non-GLB data alone', () => {
      const notGlb = Buffer.from('definitely not a glb file at all');
      expect(fixGlbAlignment(notGlb)).toBe(notGlb);
      expect(readGlbJson(notGlb)).toBeNull();
    });
  });

  describe('patchGlbImageURIs', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-glb-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('should point the image at a file, drop its bufferView and keep the binary chunk', async () => {
      const file = path.join(dir, 'quad.glb');
      const doc = buildQuad({
        nodeName: 'Quad',
        baseColor: { name: 'Base', png: await gradientPng(1) },
      });
      await writeEmbeddedGlb(doc, file);
      const before = await fs.readFile(file);
      expect(readGlbJson(before).images[0].bufferView).toBeDefined();

      await patchGlbImageURIs(file, new Map([[0, 'textures/base.png']]));

      const after = await fs.readFile(file);
      const json = readGlbJson(after);
      expect(json.images[0].uri).toBe('textures/base.png');
      expect(json.images[0].bufferView).toBeUndefined();
      expect(after.readUInt32LE(8)).toBe(after.length);
      expect(after.readUInt32LE(12) % 4).toBe(0);
      expect(Buffer.compare(binChunk(after), binChunk(before))).toBe(0);
    });

    it('should be a no-op for an empty map', async () => {
      const file = path.join(dir, 'quad.glb');
      await writeEmbeddedGlb(
        buildQuad({ nodeName: 'Quad', baseColor: { name: 'Base', png: await gradientPng(2) } }),
        file,
      );
      const before = await fs.readFile(file);

      await patchGlbImageURIs(file, new Map());

      expect(Buffer.compare(await fs.readFile(file), before)).toBe(0);
    });
  });
});
