import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';

const MAX_NAME_LENGTH = 64;

/**
 * GC 단계별 재개 위치(`gc_cursor`). 위치 문자열의 형식은 단계가 정한다.
 * GC는 PostgreSQL advisory lock으로 한 번에 한 인스턴스만 돌므로 갱신 경합이 없다.
 */
@Injectable()
export class GcCursorRepository {
  constructor(private readonly dataSource: DataSource) {}

  private get ph(): DialectPlaceholders {
    return new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
  }

  async read(name: string): Promise<string | null> {
    const ph = this.ph;
    const rows = (await this.dataSource.query(
      `SELECT position FROM gc_cursor WHERE name = ${ph.bind(name)}`,
      ph.params,
    )) as Array<{ position: string }>;
    return rows[0]?.position ?? null;
  }

  async write(name: string, position: string): Promise<void> {
    if (name.length > MAX_NAME_LENGTH) throw new Error(`GC cursor 이름이 ${MAX_NAME_LENGTH}자를 넘는다`);
    const ph = this.ph;
    await this.dataSource.query(
      `INSERT INTO gc_cursor (name, position, updated_at) VALUES (${ph.bind(name)}, ${ph.bind(position)}, CURRENT_TIMESTAMP)
       ON CONFLICT (name) DO UPDATE SET position = excluded.position, updated_at = CURRENT_TIMESTAMP`,
      ph.params,
    );
  }

  async clear(name: string): Promise<void> {
    const ph = this.ph;
    await this.dataSource.query(`DELETE FROM gc_cursor WHERE name = ${ph.bind(name)}`, ph.params);
  }
}
