import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  debounce,
  debounceByKey,
  formatBytes,
  isValidFolderName,
  getBaseName,
  retry,
} from '../utils';

describe('formatBytes', () => {
  it('should pick the unit from the magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 ** 2)).toBe('3.0 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
  });

  it('should keep the sign of a negative size instead of printing NaN', () => {
    // A run that grew the scene: before - after is negative.
    expect(formatBytes(-1536)).toBe('-1.5 KB');
    expect(formatBytes(-1)).toBe('-1 B');
  });

  it('should read NaN and non-finite input as nothing', () => {
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
    expect(formatBytes(undefined as unknown as number)).toBe('0 B');
  });
});

describe('isValidFolderName', () => {
  it('should accept a normal name', () => {
    expect(isValidFolderName('My Scene')).toBe(true);
  });

  it('should reject an empty name', () => {
    expect(isValidFolderName('')).toBe(false);
  });

  it('should reject a whitespace-only name', () => {
    expect(isValidFolderName('   ')).toBe(false);
  });

  it('should reject "." and ".."', () => {
    expect(isValidFolderName('.')).toBe(false);
    expect(isValidFolderName('..')).toBe(false);
  });

  it('should reject names with illegal filesystem characters', () => {
    expect(isValidFolderName('My/Scene')).toBe(false);
    expect(isValidFolderName('My\\Scene')).toBe(false);
    expect(isValidFolderName('My:Scene')).toBe(false);
    expect(isValidFolderName('My*Scene')).toBe(false);
    expect(isValidFolderName('My?Scene')).toBe(false);
    expect(isValidFolderName('My"Scene')).toBe(false);
    expect(isValidFolderName('My<Scene>')).toBe(false);
    expect(isValidFolderName('My|Scene')).toBe(false);
  });

  it('should reject reserved Windows device names', () => {
    expect(isValidFolderName('CON')).toBe(false);
    expect(isValidFolderName('con')).toBe(false);
    expect(isValidFolderName('COM1')).toBe(false);
    expect(isValidFolderName('LPT9')).toBe(false);
    expect(isValidFolderName('NUL')).toBe(false);
  });

  it('should reject names ending with a dot', () => {
    expect(isValidFolderName('My Scene.')).toBe(false);
    expect(isValidFolderName('My Scene...')).toBe(false);
    expect(isValidFolderName('My Scene. ')).toBe(false);
  });

  it('should reject names longer than 255 characters', () => {
    expect(isValidFolderName('a'.repeat(256))).toBe(false);
    expect(isValidFolderName('a'.repeat(255))).toBe(true);
  });

  it('should trim surrounding whitespace before validating', () => {
    expect(isValidFolderName('  My Scene  ')).toBe(true);
  });
});

describe('getBaseName', () => {
  it('should return the last segment of a POSIX path', () => {
    expect(getBaseName('/home/user/scenes/My Scene')).toBe('My Scene');
  });

  it('should return the last segment of a Windows path', () => {
    expect(getBaseName('C:\\Users\\user\\scenes\\My Scene')).toBe('My Scene');
  });

  it('should ignore a trailing slash', () => {
    expect(getBaseName('/home/user/scenes/My Scene/')).toBe('My Scene');
  });

  it('should return an empty string for an empty path', () => {
    expect(getBaseName('')).toBe('');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should debounce function calls', async () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 300);

    // Multiple calls within delay should be debounced
    debouncedFn('test1');
    debouncedFn('test2');
    debouncedFn('test3');

    expect(mockFn).toHaveBeenCalledTimes(0); // No calls yet

    // Advance time to trigger the debounced call
    await vi.advanceTimersByTimeAsync(300);

    // Should have executed only the last call
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenLastCalledWith('test3');
  });

  it('should reset timer on each call', async () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 300);

    // First call
    debouncedFn('test1');

    // Advance halfway
    await vi.advanceTimersByTimeAsync(150);
    expect(mockFn).toHaveBeenCalledTimes(0);

    // Call again - should reset timer
    debouncedFn('test2');

    // Advance to original timeout (should not trigger)
    await vi.advanceTimersByTimeAsync(150);
    expect(mockFn).toHaveBeenCalledTimes(0);

    // Advance to new timeout
    await vi.advanceTimersByTimeAsync(150);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenLastCalledWith('test2');
  });

  it('should handle multiple separate calls', async () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 300);

    // First call
    debouncedFn('test1');
    await vi.advanceTimersByTimeAsync(300);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenLastCalledWith('test1');

    // Second call after delay
    debouncedFn('test2');
    await vi.advanceTimersByTimeAsync(300);
    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenLastCalledWith('test2');
  });
});

describe('debounceByKey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should maintain separate debounce timers for different keys', async () => {
    const mockFn = vi.fn();
    const debouncedFn = debounceByKey(mockFn, 300, (key: string) => key);

    // Call with key 'a'
    debouncedFn('a');
    expect(mockFn).toHaveBeenCalledTimes(0);

    // Call with key 'b' - should have separate timer
    debouncedFn('b');
    expect(mockFn).toHaveBeenCalledTimes(0);

    // Advance time
    await vi.advanceTimersByTimeAsync(300);

    // Should have executed both calls
    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenNthCalledWith(1, 'a');
    expect(mockFn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('should debounce calls with the same key', async () => {
    const mockFn = vi.fn();
    const debouncedFn = debounceByKey(mockFn, 300, (key: string) => key);

    // Multiple calls with same key
    debouncedFn('a');
    debouncedFn('a');
    debouncedFn('a');

    expect(mockFn).toHaveBeenCalledTimes(0);

    // Advance time
    await vi.advanceTimersByTimeAsync(300);

    // Should have executed only the last call
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenLastCalledWith('a');
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('when the first attempt fails', () => {
    it('should answer with the next one, since a timeout says nothing about it', async () => {
      const attempt = vi
        .fn()
        .mockRejectedValueOnce(new Error('REQUEST_TIMEOUT'))
        .mockResolvedValue('ok');

      expect(await retry(attempt, 2, 0)).toBe('ok');
      expect(attempt).toHaveBeenCalledTimes(2);
    });
  });

  describe('when every attempt fails', () => {
    it('should let the last failure through rather than swallowing it', async () => {
      const attempt = vi.fn().mockRejectedValue(new Error('gone'));

      await expect(retry(attempt, 3, 0)).rejects.toThrow('gone');
      expect(attempt).toHaveBeenCalledTimes(3);
    });
  });

  describe('when the first attempt succeeds', () => {
    it('should not try again', async () => {
      const attempt = vi.fn().mockResolvedValue('ok');

      expect(await retry(attempt, 3, 0)).toBe('ok');
      expect(attempt).toHaveBeenCalledTimes(1);
    });
  });
});
