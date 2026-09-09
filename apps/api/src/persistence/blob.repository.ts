import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';

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
    return isSqliteDataSource(this.dataSource.options);
  }

  // reference_count를 원자적으로 감소시키고, 그 결과가 0이 되는 경우에만 같은
  // UPDATE 안에서 zero_since를 채운다. 별도 SELECT 없이 하나의 문장으로 처리해
  // 경쟁 상태 없이 정확한 시점을 기록한다.
  async decrementReferenceCount(manager: EntityManager, blobId: string, count: number): Promise<void> {
    const ph = new DialectPlaceholders(this.isSqlite);
    await manager.query(
      `UPDATE blob
       SET reference_count = reference_count - ${ph.bind(count)},
           zero_since = CASE WHEN reference_count - ${ph.bind(count)} = 0 THEN CURRENT_TIMESTAMP ELSE zero_since END
       WHERE id = ${ph.bind(blobId)}`,
      ph.params,
    );
  }

  async findOrphanBlobs(cutoff: Date): Promise<OrphanBlobRow[]> {
    // SQLite는 Date 객체 바인딩을 지원하지 않으므로 문자열로 변환해서 넘긴다
    // (formatSqliteTimestamp 참고) — 이건 플레이스홀더 문법이 아니라 값 자체의
    // 드라이버별 표현 차이라 DialectPlaceholders가 대신해줄 수 없다.
    const ph = new DialectPlaceholders(this.isSqlite);
    const cutoffValue = this.isSqlite ? formatSqliteTimestamp(cutoff) : cutoff;
    const rows: { id: string; storage_key: string }[] = await this.dataSource.query(
      `SELECT id, storage_key FROM blob
       WHERE reference_count = 0 AND zero_since IS NOT NULL AND zero_since < ${ph.bind(cutoffValue)}
       ORDER BY id ASC`,
      ph.params,
    );
    return rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  }

  // 여기 분기는 DialectPlaceholders로 통일하지 않는다 — 플레이스홀더 문법
  // 차이가 아니라 SQLite(청크 단위 반복 DELETE)와 Postgres(배열 파라미터
  // 한 번) 자체가 서로 다른 전략이라 통일할 대상이 아니다.
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
