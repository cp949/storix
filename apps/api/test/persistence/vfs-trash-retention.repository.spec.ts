/**
 * 후보 조회 뒤 삭제 접수가 먼저 커밋되는 보존 정리 경합을 목으로 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "GC 단계". 결정은 api ADR-0032.
 */
import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { DataSource } from 'typeorm';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import { VfsNamespaceNotFoundError } from '../../src/vfs/vfs.errors.js';

// 실제 상태 검사에서 발생하는 오류가 다른 namespace의 보존 정리를 막지 않는 계약이다.
describe('휴지통 보존 정리의 namespace 삭제 경합', () => {
  it('후보 조회 뒤 비활성으로 바뀐 namespace는 건너뛰고 다음 항목을 정리한다', async () => {
    const db = {
      options: { type: 'better-sqlite3' },
      query: async () => [
        { id: 'deleted', namespaceId: 'deleting', nodeCount: '1', logicalBytes: '3' },
        { id: 'active', namespaceId: 'active', nodeCount: '2', logicalBytes: '5' },
      ],
    } as unknown as DataSource;
    const nodes = {
      async purgeTrashItem(id: string) {
        if (id === 'deleting') throw new VfsNamespaceNotFoundError(id);
      },
    } as unknown as VfsNodeRepository;
    expect(await new VfsTrashRetentionRepository(db, nodes).pruneExpiredBatch(500)).toEqual({
      items: 1,
      nodes: 2,
      bytes: '5',
      failed: 0,
    });
  });

  it('예상 밖 오류는 error 로그와 실패 수로 남기고 다음 항목을 정리한다', async () => {
    const db = {
      options: { type: 'better-sqlite3' },
      query: async () => [
        { id: 'broken', namespaceId: 'ns-a', nodeCount: '1', logicalBytes: '3' },
        { id: 'healthy', namespaceId: 'ns-b', nodeCount: '2', logicalBytes: '5' },
      ],
    } as unknown as DataSource;
    const nodes = {
      async purgeTrashItem(_namespaceId: string, id: string) {
        if (id === 'broken') throw new Error('Trash manifest byte count mismatch');
      },
    } as unknown as VfsNodeRepository;
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect(await new VfsTrashRetentionRepository(db, nodes).pruneExpiredBatch(500)).toEqual({
        items: 1,
        nodes: 2,
        bytes: '5',
        failed: 1,
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/namespace=ns-a trash=broken: Trash manifest byte count mismatch/),
        expect.anything(),
      );
    } finally {
      error.mockRestore();
    }
  });
});
