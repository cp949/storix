import { parseConditionalMutation } from './conditional-mutation-request.dto.js';
import { encodeRevision } from '../revision.js';
import { VfsPreconditionRequiredError } from '../vfs.errors.js';

const revision = encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 3 });

describe('conditional mutation request', () => {
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
