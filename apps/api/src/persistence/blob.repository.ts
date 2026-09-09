import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export interface OrphanBlobRow {
  readonly id: string;
  readonly storageKey: string;
}

// SQLite는 Date 객체 바인딩을 지원하지 않는다(TypeError: SQLite3 can only bind
// numbers, strings, bigints, buffers, and null). CURRENT_TIMESTAMP 컬럼 값과
// 같은 포맷("YYYY-MM-DD HH:MM:SS", 밀리초/타임존 없음)의 문자열이어야 문자열
// 비교가 실제 시각 순서와 일치한다 — toISOString()의 'T'/밀리초/'Z'를 그대로
// 쓰면 안 된다.
function formatSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// SQLite의 SQLITE_MAX_VARIABLE_NUMBER 제약(최근 버전 32766, 구버전 999)을 피하기
// 위해 대량 삭제 시 청크 단위로 처리한다. Postgres는 배열 파라미터 하나로 처리되므로
// 이 제약이 없다.
export const BLOB_DELETE_CHUNK_SIZE = 500;

@Injectable()
export class BlobRepository {
  constructor(private readonly dataSource: DataSource) {}

  private get isSqlite(): boolean {
    return this.dataSource.options.type === 'better-sqlite3';
  }

  // reference_count를 원자적으로 감소시키고, 그 결과가 0이 되는 경우에만 같은
  // UPDATE 안에서 zero_since를 채운다. 별도 SELECT 없이 하나의 문장으로 처리해
  // 경쟁 상태 없이 정확한 시점을 기록한다.
  async decrementReferenceCount(manager: EntityManager, blobId: string, count: number): Promise<void> {
    if (this.isSqlite) {
      // SQLite '?' 플레이스홀더는 Postgres '$1'과 달리 텍스트 내 위치별로
      // 바인딩되어 재사용할 수 없다 — reference_count가 두 번 등장하므로
      // count도 두 번 넘긴다.
      await manager.query(
        `UPDATE blob
         SET reference_count = reference_count - ?,
             zero_since = CASE WHEN reference_count - ? = 0 THEN CURRENT_TIMESTAMP ELSE zero_since END
         WHERE id = ?`,
        [count, count, blobId],
      );
      return;
    }
    await manager.query(
      `UPDATE blob
       SET reference_count = reference_count - $1,
           zero_since = CASE WHEN reference_count - $1 = 0 THEN CURRENT_TIMESTAMP ELSE zero_since END
       WHERE id = $2`,
      [count, blobId],
    );
  }

  async findOrphanBlobs(cutoff: Date): Promise<OrphanBlobRow[]> {
    const rows: { id: string; storage_key: string }[] = this.isSqlite
      ? await this.dataSource.query(
          `SELECT id, storage_key FROM blob
           WHERE reference_count = 0 AND zero_since IS NOT NULL AND zero_since < ?
           ORDER BY id ASC`,
          [formatSqliteTimestamp(cutoff)],
        )
      : await this.dataSource.query(
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
    if (this.isSqlite) {
      // better-sqlite3는 배열 파라미터 바인딩(Postgres의 ANY($1::uuid[]))을
      // 지원하지 않고, SQLITE_MAX_VARIABLE_NUMBER 제약(최근 버전 32766, 구버전 999)이
      // 있다. ids를 청크 단위로 나눠 여러 번 DELETE를 실행해 이 제약을 우회한다.
      for (let i = 0; i < ids.length; i += BLOB_DELETE_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + BLOB_DELETE_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        await this.dataSource.query(`DELETE FROM blob WHERE id IN (${placeholders})`, chunk);
      }
      return;
    }
    await this.dataSource.query('DELETE FROM blob WHERE id = ANY($1::uuid[])', [ids]);
  }

  async findAllStorageKeys(): Promise<Set<string>> {
    const rows: { storage_key: string }[] = await this.dataSource.query('SELECT storage_key FROM blob');
    return new Set(rows.map((row) => row.storage_key));
  }
}
