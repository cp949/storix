import { decodeSnapshotListCursor, encodeSnapshotListCursor } from './snapshot-list-cursor.js';

describe('snapshot list cursor', () => {
  const cursor = {
    namespaceId: '11111111-1111-4111-8111-111111111111',
    rootNodeId: '22222222-2222-4222-8222-222222222222',
    createdAtKey: '2026-09-26T01:02:03.123456Z',
    snapshotId: '33333333-3333-4333-8333-333333333333',
  };
  it('round trips an exact canonical ordering key', () => {
    const encoded = encodeSnapshotListCursor(cursor);
    expect(decodeSnapshotListCursor(encoded, cursor.namespaceId, cursor.rootNodeId)).toEqual(cursor);
  });
  it.each([
    'bad',
    `sl1.${Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString('base64url')}`,
    `sl1.${Buffer.from(JSON.stringify({ ...cursor, createdAtKey: '2026-09-26T01:02:03.12Z' })).toString('base64url')}`,
  ])('rejects malformed cursors', (raw) => {
    expect(() => decodeSnapshotListCursor(raw, cursor.namespaceId, cursor.rootNodeId)).toThrow(
      expect.objectContaining({ code: 'VFS_INVALID_CURSOR' }),
    );
  });
  it('binds the cursor to its namespace and root node', () => {
    const raw = encodeSnapshotListCursor(cursor);
    expect(() =>
      decodeSnapshotListCursor(raw, '44444444-4444-4444-8444-444444444444', cursor.rootNodeId),
    ).toThrow();
    expect(() =>
      decodeSnapshotListCursor(raw, cursor.namespaceId, '44444444-4444-4444-8444-444444444444'),
    ).toThrow();
  });
});
