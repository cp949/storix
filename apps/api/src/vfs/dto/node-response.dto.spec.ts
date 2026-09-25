import { VfsNodeRecord } from '../../persistence/vfs-node.repository.js';
import { toNodeResponse, toPreconditionCurrent } from './node-response.dto.js';
import { encodeRevision } from '../revision.js';

function makeRecord(overrides: Partial<VfsNodeRecord> = {}): VfsNodeRecord {
  return {
    id: 'node-1',
    name: 'a',
    type: 'DIRECTORY',
    blobId: null,
    size: null,
    mimeType: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

describe('toNodeResponse', () => {
  it('DIRECTORY record를 응답 DTO로 변환한다', () => {
    const result = toNodeResponse(makeRecord(), '/a');

    expect(result).toEqual({
      path: '/a',
      name: 'a',
      type: 'DIRECTORY',
      size: null,
      mimeType: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      version: 1,
    });
  });

  it('FILE record의 size를 문자열에서 숫자로 변환한다', () => {
    const result = toNodeResponse(
      makeRecord({ type: 'FILE', name: 'report.pdf', size: '2048', mimeType: 'application/pdf' }),
      '/report.pdf',
    );

    expect(result).toMatchObject({ size: 2048, mimeType: 'application/pdf' });
  });
});

describe('toPreconditionCurrent', () => {
  const id = '0195f6a0-7c1b-7d3e-8a4f-1234567890ab';

  it('stat 응답 필드에 record의 revision을 더한다', () => {
    const record = makeRecord({ id, type: 'FILE', size: '7', mimeType: 'text/plain', version: 4 });

    const result = toPreconditionCurrent(record, '/a');

    expect(result).toEqual({ ...toNodeResponse(record, '/a'), revision: encodeRevision(record) });
    expect(result.revision).toMatch(/^r1\./);
  });

  it('같은 노드의 version이 바뀌면 revision도 바뀐다', () => {
    const before = toPreconditionCurrent(makeRecord({ id, version: 4 }), '/a');
    const after = toPreconditionCurrent(makeRecord({ id, version: 5 }), '/a');

    expect(after.revision).not.toBe(before.revision);
  });

  it('toNodeResponse 결과에는 revision을 넣지 않는다', () => {
    expect(Object.keys(toNodeResponse(makeRecord({ id }), '/a'))).not.toContain('revision');
  });
});
