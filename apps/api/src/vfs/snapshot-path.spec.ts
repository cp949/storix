import {
  resolveSnapshotRelativePath,
  resolveSnapshotRestorePath,
  resolveSnapshotSourcePath,
  snapshotPathKey,
} from './snapshot-path.js';
import { VfsInvalidPathError } from './vfs.errors.js';

describe('snapshot paths', () => {
  it('canonicalizes absolute FILE source and restore paths', () => {
    expect(resolveSnapshotSourcePath('/a//./b')).toEqual({ canonical: '/a/b', segments: ['a', 'b'] });
    expect(resolveSnapshotRestorePath('/a//./b')).toEqual({ canonical: '/a/b', segments: ['a', 'b'] });
  });

  it('allows TREE root but rejects FILE source and restore root', () => {
    expect(resolveSnapshotSourcePath('/', 'tree')).toEqual({ canonical: '/', segments: [] });
    expect(() => resolveSnapshotSourcePath('/')).toThrow(VfsInvalidPathError);
    expect(() => resolveSnapshotRestorePath('/')).toThrow(VfsInvalidPathError);
  });

  it.each(['a/b', '/a/../b', '/a\\b', '/a\u0000b', '/a\u007fb'])(
    'rejects invalid absolute path %j',
    (raw) => {
      expect(() => resolveSnapshotSourcePath(raw, 'tree')).toThrow(VfsInvalidPathError);
      expect(() => resolveSnapshotRestorePath(raw)).toThrow(VfsInvalidPathError);
    },
  );

  it('canonicalizes relative paths and represents the tree root as dot', () => {
    expect(resolveSnapshotRelativePath('a//./b')).toEqual({ canonical: 'a/b', segments: ['a', 'b'] });
    expect(resolveSnapshotRelativePath('')).toEqual({ canonical: '.', segments: [] });
    expect(resolveSnapshotRelativePath('././')).toEqual({ canonical: '.', segments: [] });
  });

  it.each(['/a', 'a/../b', 'a\\b', 'a\u0001b', 'a\u007fb'])('rejects invalid relative path %j', (raw) => {
    expect(() => resolveSnapshotRelativePath(raw)).toThrow(VfsInvalidPathError);
  });

  it('uses one HTTP decode and does not decode percent escapes again', () => {
    expect(resolveSnapshotRelativePath('a/b')).toEqual({ canonical: 'a/b', segments: ['a', 'b'] });
    expect(resolveSnapshotRelativePath('a%2Fb')).toEqual({ canonical: 'a%2Fb', segments: ['a%2Fb'] });
    expect(resolveSnapshotRelativePath('%2e%2e')).toEqual({ canonical: '%2e%2e', segments: ['%2e%2e'] });
  });

  it('preserves distinct Unicode forms and encodes their UTF-8 bytes as lowercase hex', () => {
    expect(resolveSnapshotSourcePath('/e\u0301').canonical).toBe('/e\u0301');
    expect(resolveSnapshotRestorePath('/e\u0301').canonical).toBe('/e\u0301');
    expect(resolveSnapshotRelativePath('\u00e9').canonical).toBe('\u00e9');
    expect(resolveSnapshotRelativePath('e\u0301').canonical).toBe('e\u0301');
    expect(snapshotPathKey('\u00e9')).toBe('c3a9');
    expect(snapshotPathKey('e\u0301')).toBe('65cc81');
    expect(snapshotPathKey('.')).toBe('2e');
  });
});
