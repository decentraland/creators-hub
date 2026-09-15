import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DCLIGNORE,
  createIgnoreMatcher,
  parseDclignore,
} from '../src/modules/optimizer/dclignore';

const SIDECAR = 'assets/optimized-textures/Pride_flag_baseColor.png';

describe('optimizer dclignore', () => {
  describe('parseDclignore', () => {
    it('should keep one pattern per line and drop blanks and comments', () => {
      expect(parseDclignore('node_modules\n\n# a note\r\n  **/wip*  \n')).toEqual([
        'node_modules',
        '**/wip*',
      ]);
    });
  });

  describe('createIgnoreMatcher', () => {
    it('should match a bare pattern against the file name at any depth', () => {
      const ignored = createIgnoreMatcher(['Pride*']);
      expect(ignored(SIDECAR)).toBe(true);
      expect(ignored('assets/optimized-textures/Wall.png')).toBe(false);
    });

    it('should treat **/ as the explicit any-depth form', () => {
      expect(createIgnoreMatcher(['**/Pride*'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['**/*.png'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['**/*.jpg'])(SIDECAR)).toBe(false);
    });

    it('should anchor a pattern with a slash at the project root', () => {
      expect(createIgnoreMatcher(['assets/optimized-textures/*.png'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['/assets/**'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['optimized-textures/*.png'])(SIDECAR)).toBe(false);
    });

    it('should take everything under an ignored directory', () => {
      expect(createIgnoreMatcher(['assets'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['optimized-textures/'])(SIDECAR)).toBe(true);
      // Directory-only patterns do not match a file of that name.
      expect(createIgnoreMatcher(['Pride_flag_baseColor.png/'])(SIDECAR)).toBe(false);
    });

    it('should let a later negation un-ignore a file', () => {
      expect(createIgnoreMatcher(['*.png', '!Pride*'])(SIDECAR)).toBe(false);
      expect(createIgnoreMatcher(['!Pride*', '*.png'])(SIDECAR)).toBe(true);
    });

    it('should not read glob characters as regex', () => {
      expect(createIgnoreMatcher(['Pride_flag_baseColor.png'])(SIDECAR)).toBe(true);
      expect(createIgnoreMatcher(['Pride_flag_baseColorXpng'])(SIDECAR)).toBe(false);
      expect(createIgnoreMatcher(['Pride_flag_base?olor.png'])(SIDECAR)).toBe(true);
    });

    it('should leave a normal sidecar alone under the deploy defaults', () => {
      const ignored = createIgnoreMatcher(DEFAULT_DCLIGNORE);
      expect(ignored(SIDECAR)).toBe(false);
      expect(ignored('.optimize/manifest.json')).toBe(true);
      expect(ignored('src/index.ts')).toBe(true);
      expect(ignored('models/tree.glb')).toBe(false);
    });
  });
});
