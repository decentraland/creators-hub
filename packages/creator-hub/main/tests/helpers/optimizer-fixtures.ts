import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

import { DEFAULT_OPTIMIZE_OPTIONS } from '/shared/types/optimizer';

import { patchGlbImageURIs, readGlbJson } from '../../src/modules/optimizer/glb';
import { compressImage } from '../../src/modules/optimizer/textures';

// Synthetic GLBs for the optimizer specs, built at test time instead of checked in: each is a
// textured quad whose triangle count, node names and pixels are known because the test wrote
// them, which is what makes the invariants (triangles unchanged, nodes kept, refs resolve)
// assertable without a golden file.

export type Rgba = [number, number, number, number];

// PNGs are written uncompressed on purpose: the optimizer's re-encode then always has a gain to
// make, which is what turns an already-external texture into a superseded one.
export async function solidPng(color: Rgba, size = 16): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: color[0], g: color[1], b: color[2], alpha: color[3] / 255 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

// Distinct per seed, so two textures only dedup when the test hands them the same buffer.
export async function gradientPng(seed: number, size = 16): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[i] = (x * 16 + seed * 31) & 255;
      raw[i + 1] = (y * 16 + seed * 7) & 255;
      raw[i + 2] = (x * y + seed * 13) & 255;
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

// A PNG the optimizer has already re-encoded, so a run finds nothing to gain and must leave it
// in place (the shape of most of Genesis Plaza's textures).
export async function optimalPng(seed: number, size = 16): Promise<Buffer> {
  const { data } = await compressImage(
    await gradientPng(seed, size),
    'baseColor',
    'image/png',
    DEFAULT_OPTIMIZE_OPTIONS.textures,
  );
  return data;
}

export type QuadSpec = {
  nodeName: string;
  baseColor: { name: string; png: Buffer };
  normal?: { name: string; png: Buffer };
  // An extra mesh-less leaf node, the shape of a marker a scene targets by name.
  emptyNode?: string;
};

// One textured quad: 4 vertices, 2 triangles, UVs, a PBR material. Image order in the written
// file follows texture creation order: base color first, then the normal map.
export function buildQuad(spec: QuadSpec): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor('POSITION')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor('TEXCOORD_0')
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor('indices')
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
    .setBuffer(buffer);

  const material = doc
    .createMaterial(`${spec.nodeName}_mat`)
    .setBaseColorTexture(
      doc
        .createTexture(spec.baseColor.name)
        .setImage(new Uint8Array(spec.baseColor.png))
        .setMimeType('image/png'),
    );
  if (spec.normal) {
    material.setNormalTexture(
      doc
        .createTexture(spec.normal.name)
        .setImage(new Uint8Array(spec.normal.png))
        .setMimeType('image/png'),
    );
  }

  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setIndices(indices)
    .setMaterial(material);
  const node = doc
    .createNode(spec.nodeName)
    .setMesh(doc.createMesh(spec.nodeName).addPrimitive(primitive));
  const scene = doc.createScene('scene').addChild(node);
  if (spec.emptyNode) scene.addChild(doc.createNode(spec.emptyNode));
  return doc;
}

const writerIO = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function writeEmbeddedGlb(doc: Document, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, await writerIO.writeBinary(doc));
}

// A GLB whose images live beside it as files, the shape Genesis Plaza's models had. `images`
// pairs each texture (in creation order) with the filename to reference; the PNG is written
// next to the GLB unless it is already there, so several models can share one file.
export async function writeExternalGlb(
  doc: Document,
  file: string,
  images: { uri: string; png: Buffer }[],
): Promise<void> {
  await writeEmbeddedGlb(doc, file);
  const dir = path.dirname(file);
  for (const image of images) {
    const target = path.join(dir, image.uri);
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, image.png);
    }
  }
  await patchGlbImageURIs(file, new Map(images.map((image, index) => [index, image.uri])));
}

// Reader able to open whatever the optimizer writes.
export async function createReaderIO(): Promise<NodeIO> {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

// Rendered triangles: every node instance's primitives, from the JSON chunk alone.
export async function countTriangles(file: string): Promise<number> {
  const json = readGlbJson(await fs.readFile(file));
  if (!json) throw new Error(`${file} is not a GLB`);
  let triangles = 0;
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    for (const primitive of json.meshes[node.mesh].primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessor =
        primitive.indices !== undefined
          ? json.accessors[primitive.indices]
          : json.accessors[primitive.attributes.POSITION];
      triangles += Math.floor(accessor.count / 3);
    }
  }
  return triangles;
}

export async function glbJson(file: string): Promise<any> {
  const json = readGlbJson(await fs.readFile(file));
  if (!json) throw new Error(`${file} is not a GLB`);
  return json;
}

export async function nodeNames(file: string): Promise<string[]> {
  const json = await glbJson(file);
  return (json.nodes ?? []).map((node: { name?: string }) => node.name ?? '');
}

// Image URIs of a GLB resolved to absolute paths, plus which of them are missing on disk.
export async function imageRefs(file: string): Promise<{ resolved: string[]; missing: string[] }> {
  const json = await glbJson(file);
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const image of json.images ?? []) {
    if (typeof image.uri !== 'string') continue;
    const abs = path.resolve(path.dirname(file), decodeURIComponent(image.uri));
    resolved.push(abs);
    try {
      await fs.access(abs);
    } catch {
      missing.push(abs);
    }
  }
  return { resolved, missing };
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}
