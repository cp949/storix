import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export interface OrphanBlobRow {
  readonly id: string;
  readonly storageKey: string;
}

@Injectable()
export class BlobRepository {
  constructor(private readonly dataSource: DataSource) {}

  // reference_count를 원자적으로 감소시키고, 그 결과가 0이 되는 경우에만 같은
  // UPDATE 안에서 zero_since를 채운다. 별도 SELECT 없이 하나의 문장으로 처리해
  // 경쟁 상태 없이 정확한 시점을 기록한다.
  async decrementReferenceCount(manager: EntityManager, blobId: string, count: number): Promise<void> {
    await manager.query(
      `UPDATE blob
       SET reference_count = reference_count - $1,
           zero_since = CASE WHEN reference_count - $1 = 0 THEN now() ELSE zero_since END
       WHERE id = $2`,
      [count, blobId],
    );
  }

  async findOrphanBlobs(cutoff: Date): Promise<OrphanBlobRow[]> {
    const rows: { id: string; storage_key: string }[] = await this.dataSource.query(
      `SELECT id, storage_key FROM blob
       WHERE reference_count = 0 AND zero_since IS NOT NULL AND zero_since < $1
       ORDER BY id ASC`,
      [cutoff],
    );
    return rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  }

  async deleteBlobRows(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.dataSource.query('DELETE FROM blob WHERE id = ANY($1::uuid[])', [ids]);
  }

  async findAllStorageKeys(): Promise<Set<string>> {
    const rows: { storage_key: string }[] = await this.dataSource.query('SELECT storage_key FROM blob');
    return new Set(rows.map((row) => row.storage_key));
  }
}
