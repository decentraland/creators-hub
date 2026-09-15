// Enough of `.dclignore` to tell whether a file the optimizer wrote would be left out of the
// deploy. `@dcl/sdk-commands` feeds the file's lines (plus the defaults below) to the `ignore`
// package, i.e. gitignore semantics: a pattern without a slash matches a basename at any depth,
// one with a slash is anchored at the project root, a trailing slash means directories only,
// `!` un-ignores, and the last matching pattern wins. A directory that matches takes everything
// under it with it.

// Mirrors `defaultDclIgnore` in sdk-commands' dcl-ignore.ts, which the deploy always adds.
export const DEFAULT_DCLIGNORE = [
  '.*',
  'package.json',
  'package-lock.json',
  'yarn-lock.json',
  'build.json',
  'export',
  'tsconfig.json',
  'tslint.json',
  'node_modules',
  'dclcontext',
  '**/*.ts',
  '**/*.tsx',
  'Dockerfile',
  'thumbnails',
  'dist',
  'README.md',
  '*.blend',
  '*.fbx',
  '*.zip',
  '*.rar',
  '*.map',
  'node_modules/**',
  '*.md',
];

type Rule = { regex: RegExp; negated: boolean; anchored: boolean; directoryOnly: boolean };

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

export function parseDclignore(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

function compile(pattern: string): Rule | null {
  let body = pattern;
  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  const directoryOnly = body.endsWith('/');
  if (directoryOnly) body = body.slice(0, -1);
  if (body.startsWith('/')) body = body.slice(1);
  if (body.length === 0) return null;
  // A slash anywhere anchors the pattern at the root; `**/x` is the explicit "any depth" form.
  const anchored = body.includes('/') && !body.startsWith('**/');
  return { regex: globToRegExp(body), negated, anchored, directoryOnly };
}

function matches(rule: Rule, relPath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const subject = rule.anchored ? relPath : relPath.slice(relPath.lastIndexOf('/') + 1);
  return rule.regex.test(subject);
}

// `relPath` is project-relative posix, the way the manifest records files.
export function createIgnoreMatcher(patterns: string[]): (relPath: string) => boolean {
  const rules = patterns.map(compile).filter((rule): rule is Rule => rule !== null);
  return relPath => {
    const segments = relPath.split('/').filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) {
      const candidate = segments.slice(0, depth).join('/');
      const isDirectory = depth < segments.length;
      let ignored = false;
      for (const rule of rules) {
        if (matches(rule, candidate, isDirectory)) ignored = !rule.negated;
      }
      if (ignored) return true;
    }
    return false;
  };
}
