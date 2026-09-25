import { decodeSnapshotCursor, encodeSnapshotCursor } from './snapshot-cursor.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

const snapshotId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';

function rawCursor(payload: unknown): string {
  return `sc1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

describe('snapshot cursor', () => {
  it('round trips a bound canonical cursor', () => {
    const cursor = { snapshotId, pathKey: '65cc81' };
    const raw = encodeSnapshotCursor(cursor);
    expect(raw).toBe(rawCursor(cursor));
    expect(decodeSnapshotCursor(raw, snapshotId)).toEqual(cursor);
  });

  it('rejects a cursor from another snapshot', () => {
    expect(() => decodeSnapshotCursor(encodeSnapshotCursor({ snapshotId, pathKey: '2e' }), otherId)).toThrow(
      VfsInvalidCursorError,
    );
  });

  it.each(['SC1.x', 'sc2.e30', 'sc1.', 'sc1.!!!!', 'sc1.e30=', 'sc1.e30A'])(
    'rejects malformed framing %j',
    (raw) => {
      expect(() => decodeSnapshotCursor(raw)).toThrow(VfsInvalidCursorError);
    },
  );

  it.each([
    { snapshotId: 'invalid', pathKey: '2e' },
    { snapshotId, pathKey: '' },
    { snapshotId, pathKey: 'A0' },
    { snapshotId, pathKey: '2' },
    { snapshotId, pathKey: 'zz' },
    { snapshotId, pathKey: '2e', extra: true },
    { pathKey: '2e', snapshotId },
    [snapshotId, '2e'],
  ])('rejects invalid or noncanonical payload %j', (payload) => {
    expect(() => decodeSnapshotCursor(rawCursor(payload))).toThrow(VfsInvalidCursorError);
  });

  it('rejects trailing JSON data and noncanonical base64url', () => {
    const payload = JSON.stringify({ snapshotId, pathKey: '2e' });
    expect(() => decodeSnapshotCursor(`sc1.${Buffer.from(`${payload} `).toString('base64url')}`)).toThrow(
      VfsInvalidCursorError,
    );
    expect(() => decodeSnapshotCursor(`sc1.${Buffer.from(`${payload}[]`).toString('base64url')}`)).toThrow(
      VfsInvalidCursorError,
    );
  });
});
