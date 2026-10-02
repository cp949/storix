import type { QueryRunner } from 'typeorm';

/** Migration fixture 재실행 때 현재 namespace ID 타입을 참조 FK에 맞춘 SQL 타입으로 반환한다. */
export async function namespaceIdSqlType(runner: QueryRunner): Promise<string> {
  if (runner.connection.options.type === 'better-sqlite3') return 'varchar(36)';
  const rows = (await runner.query(`
    SELECT data_type, character_maximum_length, collation_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'namespace' AND column_name = 'id'
  `)) as Array<{
    data_type: string;
    character_maximum_length: number | null;
    collation_name: string | null;
  }>;
  const id = rows[0];
  if (!id) throw new Error('namespace ID column not found');
  if (id.data_type === 'uuid') return 'uuid';
  if (id.data_type !== 'character varying') throw new Error(`unsupported namespace ID type: ${id.data_type}`);
  const length = id.character_maximum_length ?? 45;
  const collation = id.collation_name === null ? '' : ` COLLATE "${id.collation_name.replaceAll('"', '""')}"`;
  return `varchar(${length})${collation}`;
}
