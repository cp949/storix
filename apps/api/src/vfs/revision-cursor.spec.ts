import { decodeRevisionCursor, encodeRevisionCursor } from './revision-cursor.js';
import { encodeRevision } from './revision.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

const directoryId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const directoryRevision = encodeRevision({ id: directoryId, version: 3 });
const cursor = { directoryId, directoryRevision, name: 'alpha', id };

describe('revision listing cursor', () => {
  it('round-trips the tagged directory revision and page position', () => {
    const encoded = encodeRevisionCursor(cursor);
    expect(encoded).toMatch(/^rc1\.[A-Za-z0-9_-]+$/);
    expect(decodeRevisionCursor(encoded)).toEqual(cursor);
  });

  it.each([
    '',
    'bad',
    'rc2.aaaa',
    'rc1.!',
    'rc1.YQ',
    `rc1.${Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString('base64url')}`,
    `rc1.${Buffer.from(JSON.stringify({ ...cursor, directoryId: id })).toString('base64url')}`,
    `rc1.${Buffer.from(JSON.stringify({ ...cursor, name: '' })).toString('base64url')}`,
  ])('rejects malformed cursor %s', (raw) => {
    expect(() => decodeRevisionCursor(raw)).toThrow(VfsInvalidCursorError);
  });
});
