import { parseConditionalMutation } from '../../../src/vfs/dto/conditional-mutation-request.dto.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import { VfsInvalidExpiryError, VfsPreconditionRequiredError } from '../../../src/vfs/vfs.errors.js';

const revision = encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 3 });

describe('conditional mutation request', () => {
  it('copy는 선택 expiresInSeconds를 받고 생략하면 기존 command shape를 유지한다', () => {
    const body = {
      kind: 'copy',
      source: '/a',
      destination: '/b',
      sourceRevision: revision,
      destinationAbsent: true,
    };
    expect(Object.keys(parseConditionalMutation(body))).not.toContain('expiresInSeconds');
    expect(parseConditionalMutation({ ...body, expiresInSeconds: 600 })).toMatchObject({
      kind: 'copy',
      expiresInSeconds: 600,
    });
  });

  it.each([59, 2592001, 600.5, '600', null])(
    'copy의 잘못된 expiresInSeconds %j는 VFS_INVALID_EXPIRY다',
    (value) => {
      expect(() =>
        parseConditionalMutation({
          kind: 'copy',
          source: '/a',
          destination: '/b',
          sourceRevision: revision,
          destinationAbsent: true,
          expiresInSeconds: value,
        }),
      ).toThrow(VfsInvalidExpiryError);
    },
  );

  it('move에 expiresInSeconds가 있으면 VFS_INVALID_EXPIRY다', () => {
    expect(() =>
      parseConditionalMutation({
        kind: 'move',
        source: '/a',
        destination: '/b',
        sourceRevision: revision,
        destinationAbsent: true,
        expiresInSeconds: 600,
      }),
    ).toThrow(VfsInvalidExpiryError);
  });

  it('주입한 범위로 검사한다', () => {
    expect(() =>
      parseConditionalMutation(
        {
          kind: 'copy',
          source: '/a',
          destination: '/b',
          sourceRevision: revision,
          destinationAbsent: true,
          expiresInSeconds: 600,
        },
        { minSeconds: 60, maxSeconds: 300 },
      ),
    ).toThrow(VfsInvalidExpiryError);
  });

  it('persist는 정규 경로와 ifRevision을 받는다', () => {
    expect(parseConditionalMutation({ kind: 'persist', path: '/a//b', ifRevision: revision })).toEqual({
      kind: 'persist',
      path: '/a/b',
      segments: ['a', 'b'],
      ifRevision: revision,
    });
  });

  it('persist에 ifRevision이 없으면 428, 추가 필드와 root 경로는 400이다', () => {
    expect(() => parseConditionalMutation({ kind: 'persist', path: '/a' })).toThrow(
      VfsPreconditionRequiredError,
    );
    expect(() =>
      parseConditionalMutation({ kind: 'persist', path: '/a', ifRevision: revision, recursive: true }),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseConditionalMutation({ kind: 'persist', path: '/', ifRevision: revision })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('setMimeType은 정규 경로와 정규화된 mimeType, segments를 반환한다', () => {
    expect(
      parseConditionalMutation({
        kind: 'setMimeType',
        path: '/a//b',
        ifRevision: revision,
        mimeType: 'IMAGE/PNG',
      }),
    ).toEqual({
      kind: 'setMimeType',
      path: '/a/b',
      segments: ['a', 'b'],
      ifRevision: revision,
      mimeType: 'image/png',
    });
  });

  it('setMimeType에 ifRevision이 없으면 428이다', () => {
    expect(() =>
      parseConditionalMutation({ kind: 'setMimeType', path: '/a', mimeType: 'text/plain' }),
    ).toThrow(VfsPreconditionRequiredError);
  });

  it.each([
    {},
    { mimeType: 'text/plain; charset=utf-8' },
    { mimeType: 'not-a-mime-type' },
  ])('setMimeType의 mimeType 누락·세미콜론 포함·형식 오류 %j는 400이다', (overrides) => {
    expect(() =>
      parseConditionalMutation({
        kind: 'setMimeType',
        path: '/a',
        ifRevision: revision,
        ...overrides,
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('setMimeType에 허용 목록 외 키가 있으면 400이다', () => {
    expect(() =>
      parseConditionalMutation({
        kind: 'setMimeType',
        path: '/a',
        ifRevision: revision,
        mimeType: 'text/plain',
        recursive: true,
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('setMimeType에 루트 경로(path: "/")를 지정하면 400이다', () => {
    expect(() =>
      parseConditionalMutation({
        kind: 'setMimeType',
        path: '/',
        ifRevision: revision,
        mimeType: 'text/plain',
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('canonicalizes paths and keeps explicit conditions', () => {
    expect(parseConditionalMutation({ kind: 'mkdir', path: '/a//./b', ifAbsent: true })).toEqual({
      kind: 'mkdir',
      path: '/a/b',
      segments: ['a', 'b'],
      ifAbsent: true,
    });
    expect(
      parseConditionalMutation({
        kind: 'move',
        source: '/a//b',
        destination: '/c/.',
        sourceRevision: revision,
        destinationAbsent: true,
      }),
    ).toEqual({
      kind: 'move',
      source: '/a/b',
      sourceSegments: ['a', 'b'],
      destination: '/c',
      destinationSegments: ['c'],
      sourceRevision: revision,
      destinationAbsent: true,
    });
  });

  it.each(['move', 'copy'] as const)(
    '%s의 exact selector를 받고 생략 시 기존 command shape를 유지한다',
    (kind) => {
      const body = {
        kind,
        source: '/a',
        destination: '/b',
        sourceRevision: revision,
        destinationAbsent: true,
      };
      const legacy = parseConditionalMutation(body);
      expect(Object.keys(legacy)).not.toContain('destinationResolution');
      expect(parseConditionalMutation({ ...body, destinationResolution: 'exact' })).toEqual({
        ...legacy,
        destinationResolution: 'exact',
      });
      expect(() =>
        parseConditionalMutation({
          kind,
          source: '/a',
          destination: '/b',
          sourceRevision: revision,
          destinationResolution: 'exact',
        }),
      ).toThrow(VfsPreconditionRequiredError);
    },
  );

  it.each(['placement', false, null])(
    '지원하지 않는 destinationResolution %j는 400으로 거절한다',
    (value) => {
      expect(() =>
        parseConditionalMutation({
          kind: 'copy',
          source: '/a',
          destination: '/b',
          sourceRevision: revision,
          destinationAbsent: true,
          destinationResolution: value,
        }),
      ).toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  it.each([
    { kind: 'mkdir', path: '/a' },
    { kind: 'delete', path: '/a' },
    { kind: 'move', source: '/a', destination: '/b', destinationAbsent: true },
    { kind: 'copy', source: '/a', destination: '/b', sourceRevision: revision },
  ])('requires an explicit condition: %j', (body) => {
    expect(() => parseConditionalMutation(body)).toThrow(VfsPreconditionRequiredError);
  });

  it.each([
    null,
    { kind: 'unknown', path: '/a' },
    { kind: 'mkdir', path: '/', ifAbsent: true },
    { kind: 'mkdir', path: '/a', ifAbsent: false },
    { kind: 'mkdir', path: '/a', ifAbsent: true, parents: true },
    { kind: 'mkdir', path: '/a', ifAbsent: true, namespaceId: 'other' },
    { kind: 'delete', path: '/a', ifRevision: 'broken' },
    { kind: 'delete', path: '/a', ifRevision: revision, recursive: 'true' },
    { kind: 'move', source: '/', destination: '/b', sourceRevision: revision, destinationAbsent: true },
    { kind: 'copy', source: '/a', destination: '/b/../c', sourceRevision: revision, destinationAbsent: true },
    { kind: 'copy', source: '/a', destination: '/b', sourceRevision: revision, destinationAbsent: false },
    {
      kind: 'copy',
      source: '/a',
      destination: '/b',
      sourceRevision: revision,
      destinationAbsent: true,
      destinationParents: true,
    },
  ])('rejects malformed command %j', (body) => {
    try {
      parseConditionalMutation(body);
      throw new Error('expected parser rejection');
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
    }
  });

  it.each([
    { kind: 'mkdir', path: '/e\u0301', ifAbsent: true },
    { kind: 'delete', path: '/e\u0301', ifRevision: revision },
    {
      kind: 'move',
      source: '/e\u0301',
      destination: '/dst',
      sourceRevision: revision,
      destinationAbsent: true,
    },
    {
      kind: 'copy',
      source: '/src',
      destination: '/e\u0301',
      sourceRevision: revision,
      destinationAbsent: true,
    },
  ])('rejects NFD conditional paths during parse with 400: %j', (body) => {
    expect(() => parseConditionalMutation(body)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('accepts NFC conditional paths unchanged', () => {
    expect(parseConditionalMutation({ kind: 'mkdir', path: '/\u00e9', ifAbsent: true })).toMatchObject({
      path: '/\u00e9',
      segments: ['\u00e9'],
    });
  });
});
