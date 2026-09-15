import { describe, expect, it, vi } from 'vitest';

import type { OptimizeWorkerMessage } from '/shared/types/optimizer';

import { createWorkerOutputReader } from '../src/modules/optimizer/protocol';

describe('optimizer worker output reader', () => {
  const progress = (message: string): OptimizeWorkerMessage => ({
    type: 'progress',
    progress: { phase: 'textures', current: 1, total: 2, message },
  });

  describe('when a message line is split across two chunks', () => {
    it('should deliver it once, after the newline arrives', () => {
      const onMessage = vi.fn();
      const reader = createWorkerOutputReader({ onMessage });
      const line = JSON.stringify(progress('Optimizing a.glb'));

      reader.push(line.slice(0, 10));
      expect(onMessage).not.toHaveBeenCalled();
      reader.push(`${line.slice(10)}\n`);

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(progress('Optimizing a.glb'));
    });
  });

  describe('when several lines arrive in one chunk', () => {
    it('should deliver every message in order and route plain text to the log', () => {
      const onMessage = vi.fn();
      const onLog = vi.fn();
      const reader = createWorkerOutputReader({ onMessage, onLog });
      const error: OptimizeWorkerMessage = { type: 'error', message: 'boom' };

      reader.push(
        `${JSON.stringify(progress('one'))}\nsharp: libvips warning\n${JSON.stringify(error)}\n`,
      );

      expect(onMessage.mock.calls.map(call => call[0])).toEqual([progress('one'), error]);
      expect(onLog).toHaveBeenCalledWith('sharp: libvips warning');
    });
  });

  describe('when the stream ends without a trailing newline', () => {
    it('should deliver the last line on flush, and only then', () => {
      const onMessage = vi.fn();
      const reader = createWorkerOutputReader({ onMessage });
      const result: OptimizeWorkerMessage = {
        type: 'result',
        result: {
          glbsProcessed: 1,
          glbsChanged: 1,
          texturesExtracted: 0,
          texturesDeduped: 0,
          texturesRemoved: 0,
          bytesBefore: 10,
          bytesAfter: 5,
          sidecarBytes: 0,
          removedBytes: 0,
          ignoredFiles: [],
          files: [],
        },
      };

      reader.push(JSON.stringify(result));
      expect(onMessage).not.toHaveBeenCalled();
      reader.flush();
      expect(onMessage).toHaveBeenCalledWith(result);

      reader.flush();
      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('when a line looks like JSON but is not', () => {
    it('should log it instead of throwing', () => {
      const onMessage = vi.fn();
      const onLog = vi.fn();
      const reader = createWorkerOutputReader({ onMessage, onLog });

      expect(() => reader.push('{not json\n')).not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
      expect(onLog).toHaveBeenCalledWith('{not json');
    });
  });
});
