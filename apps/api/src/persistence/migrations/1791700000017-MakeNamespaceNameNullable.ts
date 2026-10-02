import { MigrationInterface, QueryRunner } from 'typeorm';
import { withSqliteTableRebuild } from './sqlite-table-rebuild.js';

export class MakeNamespaceNameNullable1791700000017 implements MigrationInterface {
  name = 'MakeNamespaceNameNullable1791700000017';
  transaction: boolean | undefined = process.env.STORIX_DB_DRIVER === 'sqlite' ? false : undefined;

  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type === 'better-sqlite3') {
      await this.rebuildSqlite(runner, true);
      return;
    }
    await runner.query('ALTER TABLE "namespace" ALTER COLUMN "name" DROP NOT NULL');
    await runner.query('ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_name_format"');
    await runner.query(`ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_name_format"
      CHECK ("name" IS NULL OR "name" ~ '^[a-z0-9_-]{1,128}$')`);
    await runner.query(`CREATE INDEX "idx_namespace_active_unnamed" ON "namespace" ("id")
      WHERE "status" = 'ACTIVE' AND "name" IS NULL`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const unnamed: Array<{ found: boolean }> = await runner.query(
      'SELECT EXISTS (SELECT 1 FROM "namespace" WHERE "name" IS NULL) AS found',
    );
    if (unnamed[0]?.found) throw new Error('이름 없는 namespace가 있어 migration down을 거부합니다');

    if (runner.connection.options.type === 'better-sqlite3') {
      await this.rebuildSqlite(runner, false);
      return;
    }
    await runner.query('DROP INDEX "idx_namespace_active_unnamed"');
    await runner.query('ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_name_format"');
    await runner.query('ALTER TABLE "namespace" ALTER COLUMN "name" SET NOT NULL');
    await runner.query(`ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_name_format"
      CHECK ("name" ~ '^[a-z0-9_-]{1,128}$')`);
  }

  private async rebuildSqlite(runner: QueryRunner, nullable: boolean): Promise<void> {
    await withSqliteTableRebuild(runner, async (tx) => {
      const rows = (await tx.query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'namespace'`,
      )) as Array<{ sql: string }>;
      const source = rows[0]?.sql;
      if (!source) throw new Error('namespace table definition not found');
      const existingIndexes = (await tx.query(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'namespace' AND sql IS NOT NULL`,
      )) as Array<{ sql: string }>;
      let create = source.replace('"namespace"', '"namespace_new"');
      if (nullable) {
        create = create.replace(/("name"\s+varchar\(128\))\s+NOT NULL/, '$1');
        create = create.replace(
          /CONSTRAINT "CHK_namespace_name_format" CHECK \([\s\S]*?\),/,
          `CONSTRAINT "CHK_namespace_name_format" CHECK ("name" IS NULL OR ("name" NOT GLOB '*[^a-z0-9_-]*' AND length("name") BETWEEN 1 AND 128)),`,
        );
      } else {
        create = create.replace(/("name"\s+varchar\(128\))(?!\s+NOT NULL)/, '$1 NOT NULL');
        create = create.replace(
          /CONSTRAINT "CHK_namespace_name_format" CHECK \([\s\S]*?\),/,
          `CONSTRAINT "CHK_namespace_name_format" CHECK ("name" NOT GLOB '*[^a-z0-9_-]*' AND length("name") BETWEEN 1 AND 128),`,
        );
      }
      if (create === source.replace('"namespace"', '"namespace_new"'))
        throw new Error('namespace name constraint not found');
      const columns = (await tx.query('PRAGMA table_info("namespace")')) as Array<{ name: string }>;
      const names = columns.map((column) => `"${column.name}"`).join(', ');
      await tx.query(create);
      await tx.query(`INSERT INTO "namespace_new" (${names}) SELECT ${names} FROM "namespace"`);
      await tx.query('DROP TABLE "namespace"');
      await tx.query('ALTER TABLE "namespace_new" RENAME TO "namespace"');
      for (const index of existingIndexes) {
        if (!nullable && index.sql.includes('idx_namespace_active_unnamed')) continue;
        await tx.query(index.sql);
      }
      if (nullable) {
        await tx.query(`CREATE INDEX "idx_namespace_active_unnamed" ON "namespace" ("id")
          WHERE "status" = 'ACTIVE' AND "name" IS NULL`);
      }
    });
  }
}
