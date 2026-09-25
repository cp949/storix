import { encodeRevision } from '../revision.js';
import { parseSnapshotCreateRequest, parseSnapshotRestoreRequest } from './snapshot-request.dto.js';

const revision = encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 1 });

describe('snapshot requests', () => {
  it('accepts FILE and TREE create with canonical absolute paths', () => {
    expect(parseSnapshotCreateRequest({ kind: 'file', path: '/a//./b' })).toEqual({
      kind: 'file',
      path: '/a/b',
    });
    expect(parseSnapshotCreateRequest({ kind: 'tree', path: '/' })).toEqual({
      kind: 'tree',
      path: '/',
    });
  });

  it.each([
    null,
    [],
    {},
    { kind: 'FILE', path: '/a' },
    { kind: 'file', path: '/' },
    { kind: 'tree', path: 'a' },
    { kind: 'tree', path: '/a/../b' },
    { kind: 'file', path: '/a', extra: true },
    { kind: 'file', path: 1 },
  ])('rejects malformed create request %j', (value) => {
    expect(() => parseSnapshotCreateRequest(value)).toThrow();
  });

  it('accepts one explicit restore condition and canonicalizes destination', () => {
    expect(parseSnapshotRestoreRequest({ path: '/a//b', ifAbsent: true })).toEqual({
      path: '/a/b',
      condition: { ifAbsent: true },
    });
    expect(parseSnapshotRestoreRequest({ path: '/a/./b', ifRevision: revision })).toEqual({
      path: '/a/b',
      condition: { ifRevision: revision },
    });
  });

  it.each([
    null,
    [],
    {},
    { path: '/a' },
    { path: '/a', ifAbsent: false },
    { path: '/a', ifRevision: 'r1.invalid' },
    { path: '/a', ifAbsent: true, ifRevision: revision },
    { path: '/', ifAbsent: true },
    { path: 'a', ifAbsent: true },
    { path: '/a', ifAbsent: true, force: true },
  ])('rejects malformed restore request %j', (value) => {
    expect(() => parseSnapshotRestoreRequest(value)).toThrow();
  });
});
