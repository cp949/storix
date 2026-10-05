import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { VfsChangeFeedRetentionRepository } from '../../src/persistence/vfs-change-feed-retention.repository.js';

// namespace별 prefix 삭제 결과를 정할 수 있는 PostgreSQL 형태의 DataSource 대역이다.
function makeDataSource(affectedByNamespace: Record<string, number>) {
  let current = '';
  const manager = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        current = String(params[0]);
        return [{}];
      }
      if (sql.includes('FROM vfs_change_feed_state')) {
        return [
          {
            namespace_id: current,
            last_sequence: '2',
            pruned_through: '0',
            has_checkpoint: true,
            signing_secret: 's',
          },
        ];
      }
      return [
        { sequence: '1', expired: true },
        { sequence: '2', expired: true },
      ];
    },
    getRepository: (entity: unknown) => ({
      delete: async () => ({ affected: entity === VfsChangeEventEntity ? affectedByNamespace[current] : 0 }),
      update: async () => ({ affected: 1 }),
    }),
  } as unknown as EntityManager;
  const query = async (sql: string) =>
    sql.includes('AS cutoff')
      ? [{ cutoff: '2026-01-01 00:00:00+00' }]
      : Object.keys(affectedByNamespace).map((namespaceId) => ({
          namespace_id: namespaceId,
          sequence: '1',
          occurred_at: '2025-11-01 00:00:00+00',
          is_head: true,
        }));
  return {
    options: { type: 'postgres' },
    query,
    transaction: async <T>(work: (m: EntityManager) => Promise<T>) => work(manager),
  } as unknown as DataSource;
}

describe('VfsChangeFeedRetentionRepository', () => {
  it('삭제 행 수가 어긋난 namespace는 실패로 집계하고 다음 namespace를 정리한다', async () => {
    const retention = new VfsChangeFeedRetentionRepository(makeDataSource({ 'ns-broken': 1, 'ns-ok': 2 }));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await retention.pruneNext(30, 500, null);

      expect(result).toMatchObject({ deleted: 2, examined: 2, failed: 1, next: null });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('ns-broken'),
        expect.stringContaining('Change feed prune count mismatch'),
      );
    } finally {
      error.mockRestore();
    }
  });
});
