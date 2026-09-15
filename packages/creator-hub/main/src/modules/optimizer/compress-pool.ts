import os from 'node:os';
import { Worker, parentPort } from 'node:worker_threads';

import type { TextureCategory, TextureOptions } from '/shared/types/optimizer';

import { compressImage, type CompressResult } from './textures';

// A lossless PNG re-encode costs roughly 1.5 s per 1024² texture (sharp at compressionLevel 9
// with adaptive filtering). Run serially that was the whole optimizer run — Genesis Plaza took
// 12.7 min, 69% of it in 50 texture-heavy models — so compression fans out over worker threads.
// The threads run this same bundle with `workerData.role` set; the entry (optimizer-worker.ts)
// dispatches on it.

export const COMPRESS_POOL_ROLE = 'compress-pool-worker';

export type CompressRequest = {
  id: number;
  input: ArrayBuffer;
  category: TextureCategory;
  mime: string | null;
  options: TextureOptions;
};

export type CompressReply =
  | { id: number; data: ArrayBuffer; ext: string; mime: string }
  | { id: number; error: string };

// The subset of worker_threads.Worker the pool uses, so tests can hand it an in-process stand-in.
export type PoolWorker = {
  postMessage(message: CompressRequest, transfer: ArrayBuffer[]): void;
  on(event: 'message', listener: (reply: CompressReply) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  terminate(): Promise<unknown> | void;
};

export type CompressPool = {
  readonly size: number;
  compress(
    input: Buffer,
    category: TextureCategory,
    mime: string | null,
    options: TextureOptions,
  ): Promise<CompressResult>;
  close(): Promise<void>;
};

// Leave one core for the main worker (GLB read/write, mesh pass, hashing) and cap the fan-out:
// beyond ~8 threads the per-texture work is too coarse to fill them and memory doubles per copy.
export function defaultPoolSize(): number {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(8, cores - 1));
}

// Buffers handed to a thread are copied out of their (possibly shared) backing store, so the
// transfer neither detaches memory the caller still uses nor drags an 8 MB pool slab along.
function toTransferable(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export async function handleCompressRequest(request: CompressRequest): Promise<CompressReply> {
  try {
    const { data, ext, mime } = await compressImage(
      Buffer.from(request.input),
      request.category,
      request.mime,
      request.options,
    );
    return { id: request.id, data: toTransferable(data), ext, mime };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

// Body of a pool thread.
export function runCompressPoolWorker(): void {
  if (!parentPort) throw new Error('runCompressPoolWorker must run inside a worker thread');
  const port = parentPort;
  port.on('message', async (request: CompressRequest) => {
    const reply = await handleCompressRequest(request);
    port.postMessage(reply, 'data' in reply ? [reply.data] : []);
  });
}

// Everything runs on the calling thread — for tests and single-core machines.
export function createInlinePool(): CompressPool {
  return {
    size: 1,
    compress: (input, category, mime, options) => compressImage(input, category, mime, options),
    close: async () => {},
  };
}

type Task = {
  request: CompressRequest;
  resolve: (result: CompressResult) => void;
  reject: (error: Error) => void;
};

export function createCompressPool(config: {
  size?: number;
  spawn?: () => PoolWorker;
  entry?: URL | string;
}): CompressPool {
  const size = config.size ?? defaultPoolSize();
  if (size <= 1) return createInlinePool();

  const spawn =
    config.spawn ??
    (() => {
      if (!config.entry) throw new Error('createCompressPool needs an entry or a spawn function');
      return new Worker(config.entry, { workerData: { role: COMPRESS_POOL_ROLE } });
    });

  const queue: Task[] = [];
  const idle: PoolWorker[] = [];
  const inflight = new Map<PoolWorker, Task>();
  const workers: PoolWorker[] = [];
  let nextId = 1;
  let closed = false;

  const pump = (): void => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()!;
      const task = queue.shift()!;
      inflight.set(worker, task);
      worker.postMessage(task.request, [task.request.input]);
    }
  };

  // A thread that reported 'error' is gone: take it out of rotation before anything is handed
  // to it again.
  const drop = (worker: PoolWorker): void => {
    const idleIndex = idle.indexOf(worker);
    if (idleIndex !== -1) idle.splice(idleIndex, 1);
    const workerIndex = workers.indexOf(worker);
    if (workerIndex !== -1) workers.splice(workerIndex, 1);
  };

  const settle = (worker: PoolWorker, reply: CompressReply): void => {
    const task = inflight.get(worker);
    inflight.delete(worker);
    if (task && task.request.id === reply.id) {
      if ('error' in reply) task.reject(new Error(reply.error));
      else task.resolve({ data: Buffer.from(reply.data), ext: reply.ext, mime: reply.mime });
    }
    if (!closed && workers.includes(worker)) idle.push(worker);
    pump();
  };

  for (let i = 0; i < size; i++) {
    const worker = spawn();
    worker.on('message', reply => settle(worker, reply));
    worker.on('error', error => {
      // A crashed thread fails only the texture it was holding; the rest of the run continues
      // on the remaining threads. Dropping it is what makes that true: a thread that died before
      // it was ever dispatched anything — a module-load failure (a half-installed sharp), or a
      // failed spawn — holds no task to reject, and left in `idle` it would swallow every task
      // pump() hands it afterwards, with nothing left to settle those promises. There is no
      // timeout anywhere below this, so that hangs the whole run.
      const task = inflight.get(worker);
      inflight.delete(worker);
      drop(worker);
      task?.reject(error);
      if (workers.length === 0) {
        const message = `compress pool lost every worker: ${error.message}`;
        for (const queued of queue.splice(0)) queued.reject(new Error(message));
        return;
      }
      pump();
    });
    workers.push(worker);
    idle.push(worker);
  }

  return {
    size,
    compress(input, category, mime, options) {
      if (closed) return Promise.reject(new Error('compress pool is closed'));
      if (workers.length === 0) {
        return Promise.reject(new Error('compress pool has no live workers'));
      }
      return new Promise<CompressResult>((resolve, reject) => {
        queue.push({
          request: { id: nextId++, input: toTransferable(input), category, mime, options },
          resolve,
          reject,
        });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.reject(new Error('compress pool is closed'));
      await Promise.all(workers.map(worker => worker.terminate()));
    },
  };
}
