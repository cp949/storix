import { NamespaceEntity } from '../../persistence/entities/namespace.entity.js';
import { toNamespaceResponse } from './namespace-response.dto.js';

describe('toNamespaceResponse', () => {
  it('NamespaceEntity를 응답 DTO로 변환하고 날짜를 ISO 문자열로 직렬화한다', () => {
    const entity = {
      id: 'ns-1',
      name: 'acme',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
      status: 'ACTIVE',
      maxFileSizeBytes: null,
      maxTotalLogicalBytes: '20',
      liveFileByteCount: '12',
      retainedSnapshotByteCount: '5',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as NamespaceEntity;

    expect(toNamespaceResponse(entity, 5368709120, '30')).toEqual({
      id: 'ns-1',
      name: 'acme',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      limits: { maxFileSizeBytes: '5368709120' },
      quota: { limitBytes: '20', usedBytes: '17' },
    });
  });

  it.each([
    { override: '8', global: 12, expected: '8' },
    { override: '20', global: 12, expected: '12' },
    { override: null, global: 12, expected: '12' },
  ])('파일 한도 override=$override, 전역=$global에서 적용값 $expected를 반환한다', ({ override, global, expected }) => {
    const entity = {
      maxFileSizeBytes: override,
      maxTotalLogicalBytes: '20',
      liveFileByteCount: '12',
      retainedSnapshotByteCount: '5',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as NamespaceEntity;

    const response = toNamespaceResponse(entity, global, '30');
    expect(response.limits).toEqual({ maxFileSizeBytes: expected });
    expect(response.quota).toEqual({ limitBytes: '20', usedBytes: '17' });
  });

  it('파일 한도는 STORIX_MAX_FILE_SIZE_BYTES 환경변수가 아니라 전달받은 전역값을 사용한다', () => {
    const previous = process.env.STORIX_MAX_FILE_SIZE_BYTES;
    process.env.STORIX_MAX_FILE_SIZE_BYTES = '1';
    try {
      const entity = {
        maxFileSizeBytes: null,
        liveFileByteCount: '0',
        retainedSnapshotByteCount: '0',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      } as NamespaceEntity;
      expect(toNamespaceResponse(entity, 64).limits).toEqual({ maxFileSizeBytes: '64' });
    } finally {
      if (previous === undefined) delete process.env.STORIX_MAX_FILE_SIZE_BYTES;
      else process.env.STORIX_MAX_FILE_SIZE_BYTES = previous;
    }
  });
});
