import type { OptimizeWorkerMessage } from '/shared/types/optimizer';

// Turns the worker's stdout stream back into messages. One JSON object per line is the contract,
// but a pipe delivers arbitrary chunks: a line can arrive split across two chunks or several
// lines in one, and anything a library prints to stdout shows up as a non-JSON line.
export type WorkerOutputHandlers = {
  onMessage: (message: OptimizeWorkerMessage) => void;
  onLog?: (line: string) => void;
};

export type WorkerOutputReader = {
  push: (chunk: Buffer | string) => void;
  // Call once the stream has ended: a final line without a trailing newline is only known to be
  // complete then.
  flush: () => void;
};

export function createWorkerOutputReader(handlers: WorkerOutputHandlers): WorkerOutputReader {
  let pending = '';

  const handleLine = (line: string) => {
    if (!line.startsWith('{')) {
      if (line.trim()) handlers.onLog?.(line);
      return;
    }
    let message: OptimizeWorkerMessage;
    try {
      message = JSON.parse(line);
    } catch {
      handlers.onLog?.(line);
      return;
    }
    handlers.onMessage(message);
  };

  return {
    push: chunk => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(handleLine);
    },
    flush: () => {
      if (!pending) return;
      const line = pending;
      pending = '';
      handleLine(line);
    },
  };
}
