import { MigrationInterface, QueryRunner } from 'typeorm';

interface ForeignKeyDefinition {
  readonly tableName: string;
  readonly constraintName: string;
  readonly definition: string;
}

interface ColumnReference {
  readonly tableName: string;
  readonly columnName: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export class ConvertNamespaceIdToString1791700000016 implements MigrationInterface {
  name = 'ConvertNamespaceIdToString1791700000016';

  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type === 'better-sqlite3') {
      return;
    }

    const foreignKeys: ForeignKeyDefinition[] = await runner.query(`
      SELECT local.relname AS "tableName",
             constraint_row.conname AS "constraintName",
             pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS local ON local.oid = constraint_row.conrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = local.relnamespace
      WHERE constraint_row.contype = 'f'
        AND schema_row.nspname = current_schema()
        AND (
          constraint_row.confrelid = 'namespace'::regclass
          OR EXISTS (
            SELECT 1
            FROM unnest(constraint_row.conkey) AS key_column(attnum)
            JOIN pg_attribute AS column_row
              ON column_row.attrelid = local.oid AND column_row.attnum = key_column.attnum
            WHERE column_row.attname = 'namespace_id'
          )
        )
    `);

    for (const foreignKey of foreignKeys) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(foreignKey.tableName)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.constraintName)}`,
      );
    }

    await runner.query('ALTER TABLE "namespace" ALTER COLUMN "id" DROP DEFAULT');
    await runner.query(
      'ALTER TABLE "namespace" ALTER COLUMN "id" TYPE varchar(45) COLLATE "C" USING "id"::text',
    );

    const columns: ColumnReference[] = await runner.query(`
      SELECT table_row.relname AS "tableName", column_row.attname AS "columnName"
      FROM pg_attribute AS column_row
      JOIN pg_class AS table_row ON table_row.oid = column_row.attrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
      JOIN pg_type AS type_row ON type_row.oid = column_row.atttypid
      WHERE schema_row.nspname = current_schema()
        AND table_row.relkind = 'r'
        AND column_row.attnum > 0
        AND NOT column_row.attisdropped
        AND column_row.attname = 'namespace_id'
        AND type_row.typname = 'uuid'
    `);

    for (const column of columns) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(column.tableName)} ALTER COLUMN ${quoteIdentifier(column.columnName)} TYPE varchar(45) COLLATE "C" USING ${quoteIdentifier(column.columnName)}::text`,
      );
    }

    await runner.query('ALTER TABLE "vfs_upload_usage" ALTER COLUMN "id" TYPE varchar(64)');

    for (const foreignKey of foreignKeys) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(foreignKey.tableName)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.constraintName)} ${foreignKey.definition}`,
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type === 'better-sqlite3') {
      return;
    }

    const invalidIds: Array<{ id: string }> = await runner.query(
      `SELECT "id" FROM "namespace" WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1`,
    );
    if (invalidIds.length > 0) {
      throw new Error('namespace ID를 UUID로 변환할 수 없어 migration down을 거부합니다');
    }

    const columns: ColumnReference[] = await runner.query(`
      SELECT table_row.relname AS "tableName", column_row.attname AS "columnName"
      FROM pg_attribute AS column_row
      JOIN pg_class AS table_row ON table_row.oid = column_row.attrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
      JOIN pg_type AS type_row ON type_row.oid = column_row.atttypid
      WHERE schema_row.nspname = current_schema()
        AND table_row.relkind = 'r'
        AND column_row.attnum > 0
        AND NOT column_row.attisdropped
        AND column_row.attname = 'namespace_id'
        AND type_row.typname = 'varchar'
    `);
    for (const column of columns) {
      const invalidReferences: Array<{ found: boolean }> = await runner.query(
        `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(column.tableName)} WHERE ${quoteIdentifier(column.columnName)} IS NOT NULL AND ${quoteIdentifier(column.columnName)} !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS found`,
      );
      if (invalidReferences[0]?.found) {
        throw new Error('namespace 참조 값을 UUID로 변환할 수 없어 migration down을 거부합니다');
      }
    }

    const foreignKeys: ForeignKeyDefinition[] = await runner.query(`
      SELECT local.relname AS "tableName",
             constraint_row.conname AS "constraintName",
             pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS local ON local.oid = constraint_row.conrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = local.relnamespace
      WHERE constraint_row.contype = 'f'
        AND schema_row.nspname = current_schema()
        AND (
          constraint_row.confrelid = 'namespace'::regclass
          OR EXISTS (
            SELECT 1
            FROM unnest(constraint_row.conkey) AS key_column(attnum)
            JOIN pg_attribute AS column_row
              ON column_row.attrelid = local.oid AND column_row.attnum = key_column.attnum
            WHERE column_row.attname = 'namespace_id'
          )
        )
    `);

    for (const foreignKey of foreignKeys) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(foreignKey.tableName)} DROP CONSTRAINT ${quoteIdentifier(foreignKey.constraintName)}`,
      );
    }

    for (const column of columns) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(column.tableName)} ALTER COLUMN ${quoteIdentifier(column.columnName)} TYPE uuid USING ${quoteIdentifier(column.columnName)}::uuid`,
      );
    }

    await runner.query('ALTER TABLE "namespace" ALTER COLUMN "id" TYPE uuid USING "id"::uuid');
    await runner.query('ALTER TABLE "namespace" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()');
    await runner.query('ALTER TABLE "vfs_upload_usage" ALTER COLUMN "id" TYPE varchar(40)');

    for (const foreignKey of foreignKeys) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(foreignKey.tableName)} ADD CONSTRAINT ${quoteIdentifier(foreignKey.constraintName)} ${foreignKey.definition}`,
      );
    }
  }
}
