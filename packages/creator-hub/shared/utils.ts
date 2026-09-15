export type Tail<T extends any[]> = T extends [any, ...infer Rest] ? Rest : never;

export function isUrl(url: string) {
  try {
    new URL(url);
    return true;
  } catch (_error) {
    return false;
  }
}

// Windows reserved device names (case-insensitive), with or without an extension.
const RESERVED_WINDOWS_NAMES = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;

// Characters that are illegal in file/folder names on at least one of the major OSes
// (Windows: < > : " / \ | ? * and control chars; POSIX: / and the null byte).
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

const MAX_FOLDER_NAME_LENGTH = 255;

/**
 * Returns whether or not the provided name is a valid, cross-platform-safe file/folder name.
 * Rejects empty/whitespace-only names, names containing illegal filesystem characters, reserved
 * Windows device names, names ending with a dot (silently stripped by Windows, desyncing the
 * stored path from the real folder), and names that are too long.
 */
export function isValidFolderName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (trimmed.endsWith('.')) return false;
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) return false;
  if (ILLEGAL_FILENAME_CHARS.test(trimmed)) return false;
  if (RESERVED_WINDOWS_NAMES.test(trimmed)) return false;
  return true;
}

/**
 * Human-readable size. Negative values (a run that grew the scene) keep their sign instead of
 * feeding `Math.log` a negative and printing "NaN undefined"; NaN/undefined read as 0.
 */
export function formatBytes(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const magnitude = Math.abs(bytes);
  const i = Math.min(units.length - 1, Math.floor(Math.log(magnitude) / Math.log(1024)));
  const value = (magnitude / 1024 ** i).toFixed(i === 0 ? 0 : 1);
  return `${bytes < 0 ? '-' : ''}${value} ${units[i]}`;
}

/**
 * Returns the last segment of a file system path (POSIX or Windows), i.e. the file/folder name.
 * Unlike `node:path`'s `basename`, this is safe to use from the renderer, which has no access to
 * Node built-ins.
 */
export function getBaseName(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export const throttle = <T, K extends any[]>(
  fn: (...args: K) => T,
  delay: number,
  waitFor?: number,
): [(...args: K) => T | undefined, () => void] => {
  let wait = !!waitFor;
  let timeout: number | undefined;
  let cancelled = false;
  waitFor = waitFor
    ? window.setTimeout(() => {
        wait = false;
      }, waitFor)
    : undefined;

  return [
    (...args: K) => {
      if (cancelled || wait) return undefined;

      const val = fn(...args);
      wait = true;
      timeout = window.setTimeout(() => {
        wait = false;
      }, delay);

      return val;
    },
    () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      if (waitFor) clearTimeout(waitFor);
    },
  ];
};

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Splits into consecutive groups of at most `size`. An empty input yields no groups. */
export const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );

/**
 * Runs `attempt` again after a pause if it throws, and lets the last failure through.
 *
 * For reads across the internet, where a timeout or a 5xx says nothing about
 * whether the next call will work.
 */
export async function retry<T>(attempt: () => Promise<T>, attempts = 2, pauseMs = 500): Promise<T> {
  for (let remaining = attempts - 1; ; remaining--) {
    try {
      return await attempt();
    } catch (error) {
      if (remaining <= 0) throw error;
      await delay(pauseMs);
    }
  }
}

export function debounce<F extends (...args: any[]) => void>(func: F, delay: number) {
  let timer: ReturnType<typeof setTimeout>;
  return function (...args: Parameters<F>) {
    clearTimeout(timer);
    timer = setTimeout(() => func(...args), delay);
  };
}

export function debounceByKey<F extends (...args: any[]) => void>(
  func: F,
  delay: number,
  keySelector: (...args: Parameters<F>) => string,
): (...args: Parameters<F>) => void {
  const debouncedFunctions = new Map<string, ReturnType<typeof debounce>>();

  return (...args: Parameters<F>): void => {
    const key = keySelector(...args);

    if (!debouncedFunctions.has(key)) {
      debouncedFunctions.set(key, debounce(func, delay));
    }

    debouncedFunctions.get(key)!(...args);
  };
}
