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

  it('FILE 생성 요청의 유효한 sourceRevision을 그대로 포함한다', () => {
    expect(parseSnapshotCreateRequest({ kind: 'file', path: '/a//b', sourceRevision: revision })).toEqual({
      kind: 'file',
      path: '/a/b',
      sourceRevision: revision,
    });
  });

  it('sourceRevision이 없으면 command에 sourceRevision 키를 만들지 않고 직렬화도 기존과 같다', () => {
    const command = parseSnapshotCreateRequest({ kind: 'file', path: '/a/b' });
    expect(Object.keys(command)).toEqual(['kind', 'path']);
    expect(JSON.stringify(command)).toBe('{"kind":"file","path":"/a/b"}');
    expect(JSON.stringify(parseSnapshotCreateRequest({ kind: 'tree', path: '/a' }))).toBe(
      '{"kind":"tree","path":"/a"}',
    );
  });

  it.each(['r1.invalid', 'R1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '', 'abc'])(
    '형식이 잘못된 sourceRevision %j는 VFS_INVALID_REVISION으로 거부한다',
    (sourceRevision) => {
      expect(() => parseSnapshotCreateRequest({ kind: 'file', path: '/a', sourceRevision })).toThrow(
        expect.objectContaining({ code: 'VFS_INVALID_REVISION', status: 400 }),
      );
    },
  );

  it.each([null, 1, true, {}, [revision]])(
    '문자열이 아닌 sourceRevision %j는 VFS_INVALID_MUTATION_REQUEST로 거부한다',
    (sourceRevision) => {
      expect(() => parseSnapshotCreateRequest({ kind: 'file', path: '/a', sourceRevision })).toThrow(
        expect.objectContaining({ code: 'VFS_INVALID_MUTATION_REQUEST', status: 400 }),
      );
    },
  );

  it.each([revision, 'r1.invalid'])(
    'TREE 생성 요청의 sourceRevision %j는 VFS_INVALID_MUTATION_REQUEST로 거부한다',
    (sourceRevision) => {
      expect(() => parseSnapshotCreateRequest({ kind: 'tree', path: '/a', sourceRevision })).toThrow(
        expect.objectContaining({ code: 'VFS_INVALID_MUTATION_REQUEST', status: 400 }),
      );
    },
  );

  it('sourceRevision을 추가해도 미지 키는 계속 거부한다', () => {
    expect(() =>
      parseSnapshotCreateRequest({
        kind: 'file',
        path: '/a',
        sourceRevision: revision,
        ifRevision: revision,
      }),
    ).toThrow(expect.objectContaining({ code: 'VFS_INVALID_MUTATION_REQUEST' }));
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
