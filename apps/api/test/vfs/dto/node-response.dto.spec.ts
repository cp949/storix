import { createHash } from 'node:crypto';
import { VfsNodeRecord } from '../../../src/persistence/vfs-node.repository.js';
import {
  toConditionalContentResponse,
  toNodeResponse,
  toPreconditionCurrent,
} from '../../../src/vfs/dto/node-response.dto.js';
import { encodeRevision } from '../../../src/vfs/revision.js';

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
    expiresAt: null,
    ...overrides,
  };
}

describe('toNodeResponse', () => {
  it('expiresAt이 없으면 null을 반환한다', () => {
    expect(toNodeResponse(makeRecord(), '/a').expiresAt).toBeNull();
  });

  it('expiresAt을 ISO 문자열로 반환한다', () => {
    const expiresAt = new Date('2026-09-30T00:00:00.000Z');
    expect(toNodeResponse(makeRecord({ expiresAt }), '/a').expiresAt).toBe('2026-09-30T00:00:00.000Z');
  });

  it('DIRECTORY record를 응답 DTO로 변환한다', () => {
    const result = toNodeResponse(makeRecord(), '/a');

    expect(result).toEqual({
      id: 'node-1',
      path: '/a',
      name: 'a',
      type: 'DIRECTORY',
      size: null,
      mimeType: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      version: 1,
      expiresAt: null,
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

describe('toConditionalContentResponse', () => {
  it('성공한 FILE 노드의 ID와 해당 version의 revision을 함께 반환한다', () => {
    const record = makeRecord({ id: '0195f6a0-7c1b-7d3e-8a4f-1234567890ab', type: 'FILE', version: 3 });
    expect(toConditionalContentResponse(record, '/a', 'a'.repeat(64))).toMatchObject({
      id: record.id,
      revision: encodeRevision(record),
      path: '/a',
    });
  });

  it('전체 평문 SHA-256을 sha256 필드로 반환한다', () => {
    const record = makeRecord({ id: '0195f6a0-7c1b-7d3e-8a4f-1234567890ab', type: 'FILE', version: 3 });
    const sha256 = createHash('sha256')
      .update(Buffer.from([0xff, 0xfe, 0x00, 0x80]))
      .digest('hex');
    expect(toConditionalContentResponse(record, '/a', sha256).sha256).toBe(sha256);
  });
});
