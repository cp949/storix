import { VfsNodeRecord } from '../../persistence/vfs-node.repository.js';
import { toNodeResponse } from './node-response.dto.js';

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
