import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPTIMIZE_OPTIONS } from '/shared/types/optimizer';

import {
  createCompressPool,
  handleCompressRequest,
  type CompressReply,
  type CompressRequest,
  type PoolWorker,
} from '../src/modules/optimizer/compress-pool';
import { compressImage } from '../src/modules/optimizer/textures';
import { gradientPng } from './helpers/optimizer-fixtures';

// An in-process stand-in for a worker thread: same request/reply protocol, same handler the real
// thread runs, no thread. Lets the pool's queueing, ordering and failure paths be exercised
// without spawning the bundle.
type FakeWorker = PoolWorker & {
  inflight: number;
  peak: number;
  terminated: boolean;
  // Fire the thread's 'error' event, the way worker_threads does when a thread dies.
  fail: (error: Error) => void;
};

function fakeWorker(
  respond: (request: CompressRequest) => Promise<CompressReply> = handleCompressRequest,
): FakeWorker {
  const listeners: { message: ((reply: CompressReply) => void)[]; error: ((e: Error) => void)[] } =
    { message: [], error: [] };
  const worker: FakeWorker = {
    inflight: 0,
    peak: 0,
    terminated: false,
    postMessage(request) {
      worker.inflight++;
      worker.peak = Math.max(worker.peak, worker.inflight);
      void respond(request).then(reply => {
        worker.inflight--;
        for (const listener of listeners.message) listener(reply);
      });
    },
    on(event: 'message' | 'error', listener: any) {
      listeners[event].push(listener);
    },
    terminate() {
      worker.terminated = true;
    },
    fail(error: Error) {
      for (const listener of listeners.error) listener(error);
    },
  };
  return worker;
}

function poolOf(size: number, respond?: (request: CompressRequest) => Promise<CompressReply>) {
  const workers: FakeWorker[] = [];
  const pool = createCompressPool({
    size,
    spawn: () => {
      const worker = fakeWorker(respond);
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

const options = DEFAULT_OPTIMIZE_OPTIONS.textures;

describe('compress pool', () => {
  describe('with several workers', () => {
    it('should return what the inline compressor returns, one texture per worker at a time', async () => {
      const workers: FakeWorker[] = [];
      const pool = createCompressPool({
        size: 3,
        spawn: () => {
          const worker = fakeWorker();
          workers.push(worker);
          return worker;
        },
      });
      const inputs = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(seed => gradientPng(seed)));

      const results = await Promise.all(
        inputs.map(input => pool.compress(input, 'baseColor', 'image/png', options)),
      );

      expect(workers).toHaveLength(3);
      for (let i = 0; i < inputs.length; i++) {
        const expected = await compressImage(inputs[i], 'baseColor', 'image/png', options);
        expect(results[i].ext).toBe('.png');
        expect(Buffer.compare(results[i].data, expected.data)).toBe(0);
      }
      expect(workers.every(worker => worker.peak === 1)).toBe(true);
      expect(workers.reduce((sum, worker) => sum + worker.peak, 0)).toBe(3);

      await pool.close();
      expect(workers.every(worker => worker.terminated)).toBe(true);
    });

    it('should reject only the texture whose worker reported an error', async () => {
      let calls = 0;
      const failing = createCompressPool({
        size: 2,
        spawn: () =>
          fakeWorker(async request => {
            calls++;
            return calls === 1 ? { id: request.id, error: 'boom' } : handleCompressRequest(request);
          }),
      });

      // Both inputs first: an `await` between the two compress calls would let the first
      // rejection land before allSettled attaches its handler, as an unhandled rejection.
      const [one, two] = await Promise.all([gradientPng(1), gradientPng(2)]);
      const [first, second] = await Promise.allSettled([
        failing.compress(one, 'baseColor', 'image/png', options),
        failing.compress(two, 'baseColor', 'image/png', options),
      ]);

      expect(first.status).toBe('rejected');
      expect((first as PromiseRejectedResult).reason.message).toBe('boom');
      expect(second.status).toBe('fulfilled');
      await failing.close();
    });

    it('should keep compressing after a thread dies before it was ever given work', async () => {
      const { pool, workers } = poolOf(2);

      // A thread that fails at module load (a half-installed sharp, say) reports 'error' while
      // idle: it holds no task, so nothing rejects — and left in the idle list it swallows every
      // task handed to it afterwards. Nothing below the pool times out, so the run would hang.
      workers[0].fail(new Error('Cannot find module sharp'));

      const result = await pool.compress(await gradientPng(1), 'baseColor', 'image/png', options);

      expect(result.ext).toBe('.png');
      expect(workers[0].peak).toBe(0);
      expect(workers[1].peak).toBe(1);
      await pool.close();
    });

    it('should reject work still queued when the last thread dies', async () => {
      // Threads that never reply, so both hold a texture and the third request has to queue.
      const { pool, workers } = poolOf(2, () => new Promise<CompressReply>(() => {}));
      const png = await gradientPng(1);
      const settled = Promise.allSettled([
        pool.compress(png, 'baseColor', 'image/png', options),
        pool.compress(png, 'baseColor', 'image/png', options),
        pool.compress(png, 'baseColor', 'image/png', options),
      ]);

      for (const worker of workers) worker.fail(new Error('thread died'));

      const results = await settled;
      expect(results.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
      await pool.close();
    });

    it('should reject new work once every thread has died', async () => {
      const { pool, workers } = poolOf(2);
      for (const worker of workers) worker.fail(new Error('thread died'));

      await expect(
        pool.compress(await gradientPng(1), 'baseColor', 'image/png', options),
      ).rejects.toThrow(/no live workers/);
      await pool.close();
    });

    it('should reject new work once closed', async () => {
      const pool = createCompressPool({ size: 2, spawn: () => fakeWorker() });
      await pool.close();
      await expect(
        pool.compress(await gradientPng(1), 'baseColor', 'image/png', options),
      ).rejects.toThrow(/closed/);
    });
  });

  describe('with a size of one', () => {
    it('should compress inline without spawning anything', async () => {
      const spawn = vi.fn();
      const pool = createCompressPool({ size: 1, spawn });
      const input = await gradientPng(3);

      const result = await pool.compress(input, 'normal', 'image/png', options);

      expect(spawn).not.toHaveBeenCalled();
      expect(result.data.length).toBeLessThan(input.length);
    });
  });

  describe('handleCompressRequest', () => {
    it('should reply with the untouched bytes for input the compressor cannot decode', async () => {
      const reply = await handleCompressRequest({
        id: 7,
        input: new TextEncoder().encode('not an image').buffer,
        category: 'other',
        mime: 'image/png',
        options,
      });
      // Undecodable input passes through untouched, so this is a data reply of the same bytes.
      expect(reply.id).toBe(7);
      expect('data' in reply).toBe(true);
    });
  });
});
