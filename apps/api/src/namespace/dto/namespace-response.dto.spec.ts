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
      maxTotalLogicalBytes: '20',
      liveFileByteCount: '12',
      retainedSnapshotByteCount: '5',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as NamespaceEntity;

    expect(toNamespaceResponse(entity, '30')).toEqual({
      id: 'ns-1',
      name: 'acme',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      quota: { limitBytes: '20', usedBytes: '17' },
    });
  });
});
