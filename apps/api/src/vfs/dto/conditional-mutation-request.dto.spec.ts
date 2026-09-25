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
});
