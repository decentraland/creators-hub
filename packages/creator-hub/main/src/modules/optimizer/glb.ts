import fs from 'node:fs/promises';

// Low-level GLB (binary glTF 2.0) helpers, ported from decentraland/SceneOptimizer.
// gltf-transform's high-level writer always embeds images inside the binary chunk, so
// externalizing textures from a .glb requires patching the JSON chunk in place afterwards.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a; // 'JSON'

// Some exporters violate the spec's 4-byte JSON-chunk alignment; gltf-transform refuses to
// read those. Re-pad the JSON chunk to a 4-byte boundary before handing the buffer off.
export function fixGlbAlignment(buf: Buffer): Buffer {
  if (buf.length < 20) return buf;
  if (buf.readUInt32LE(0) !== GLB_MAGIC) return buf;

  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonEnd = 20 + jsonChunkLength;
  if (jsonEnd % 4 === 0) return buf;

  const padNeeded = 4 - (jsonEnd % 4);
  const jsonData = buf.subarray(20, jsonEnd);
  const padding = Buffer.alloc(padNeeded, 0x20);
  const newJsonLength = jsonChunkLength + padNeeded;

  const binaryChunk = jsonEnd + 8 <= buf.length ? buf.subarray(jsonEnd) : Buffer.alloc(0);
  const totalLength = 12 + 8 + newJsonLength + binaryChunk.length;

  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(newJsonLength, 12);
  out.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  jsonData.copy(out, 20);
  padding.copy(out, 20 + jsonChunkLength);
  if (binaryChunk.length > 0) binaryChunk.copy(out, 20 + newJsonLength);

  return out;
}

export function readGlbJson(buf: Buffer): any | null {
  if (buf.length < 20) return null;
  if (buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf
    .subarray(20, 20 + jsonChunkLength)
    .toString('utf8')
    .trimEnd();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// The JSON chunk alone, without pulling the binary chunk (all of the geometry and any embedded
// textures — the bulk of a 50 MB model) into memory just to list its images.
export async function readGlbJsonFromFile(glbPath: string): Promise<any | null> {
  const handle = await fs.open(glbPath, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead < 20 || header.readUInt32LE(0) !== GLB_MAGIC) return null;
    const jsonChunkLength = header.readUInt32LE(12);
    const chunk = Buffer.alloc(20 + jsonChunkLength);
    header.copy(chunk);
    await handle.read(chunk, 20, jsonChunkLength, 20);
    return readGlbJson(chunk);
  } finally {
    await handle.close();
  }
}

function serializeGlb(json: unknown, binaryChunk: Buffer): Buffer {
  let newJsonStr = JSON.stringify(json);
  while (Buffer.byteLength(newJsonStr, 'utf8') % 4 !== 0) newJsonStr += ' ';
  const newJsonBuf = Buffer.from(newJsonStr, 'utf8');

  const jsonSectionLength = 8 + newJsonBuf.length;
  let padding = Buffer.alloc(0);
  if (binaryChunk.length > 0 && (12 + jsonSectionLength) % 4 !== 0) {
    padding = Buffer.alloc(4 - ((12 + jsonSectionLength) % 4), 0x20);
  }

  const totalLength = 12 + jsonSectionLength + padding.length + binaryChunk.length;
  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(newJsonBuf.length + padding.length, 12);
  out.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  newJsonBuf.copy(out, 20);
  if (padding.length > 0) padding.copy(out, 20 + newJsonBuf.length);
  if (binaryChunk.length > 0) binaryChunk.copy(out, 20 + newJsonBuf.length + padding.length);
  return out;
}

// Rewrite the `uri` of the given image indices (and drop their `bufferView`) so the GLB
// references external texture files instead of embedded binary. `imageURIs` maps the
// image index (matching gltf-transform's texture order) to its new relative URI.
export async function patchGlbImageURIs(
  glbPath: string,
  imageURIs: Map<number, string>,
): Promise<void> {
  if (imageURIs.size === 0) return;

  const buf = await fs.readFile(glbPath);
  if (buf.length < 20) return;

  const jsonChunkLength = buf.readUInt32LE(12);
  const json = readGlbJson(buf);
  if (!json) return;

  if (json.images) {
    for (const [idx, filename] of imageURIs) {
      if (json.images[idx]) {
        json.images[idx].uri = filename;
        delete json.images[idx].bufferView;
      }
    }
  }

  const binaryChunkStart = 20 + jsonChunkLength;
  const binaryChunk =
    binaryChunkStart + 8 <= buf.length ? buf.subarray(binaryChunkStart) : Buffer.alloc(0);

  await fs.writeFile(glbPath, serializeGlb(json, binaryChunk));
}
