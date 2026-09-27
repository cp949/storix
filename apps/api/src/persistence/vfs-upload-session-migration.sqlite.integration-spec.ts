import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { AddVfsUploadSessions1791700000000 } from './migrations/1791700000000-AddVfsUploadSessions.js';
import { AddUploadCreationExpiry1791700000001 } from './migrations/1791700000001-AddUploadCreationExpiry.js';

describe('upload session migration (SQLite)', () => {
  let db: DataSource;
  beforeEach(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrations: ALL_MIGRATIONS,
    }).initialize();
    await db.runMigrations();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('creates constrained session, part and usage tables and permits rollback/reapply', async () => {
    const names = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")) as {
      name: string;
    }[];
    for (const name of ['vfs_upload_session', 'vfs_upload_part', 'vfs_upload_usage'])
      expect(names.map((row) => row.name)).toContain(name);
    const indexes = (await db.query("SELECT name FROM sqlite_master WHERE type = 'index'")) as {
      name: string;
    }[];
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(['idx_vfs_upload_session_state_expires', 'idx_vfs_upload_part_state']),
    );
    const runner = db.createQueryRunner();
    const migration = new AddVfsUploadSessions1791700000000();
    await migration.down(runner);
    expect(
      (await db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vfs_upload_%'",
      )) as unknown[],
    ).toEqual([]);
    await migration.up(runner);
    expect((await db.query("SELECT * FROM vfs_upload_usage WHERE id = 'global'")) as unknown[]).toHaveLength(
      1,
    );
    await runner.release();
  });

  it('backfills immutable creation expiry and its down removes only the new column', async () => {
    const runner = db.createQueryRunner();
    const migration = new AddUploadCreationExpiry1791700000001();
    await migration.down(runner);
    await db.query("INSERT INTO namespace (id, name) VALUES ('123e4567-e89b-42d3-a456-426614174000', 'backfill')");
    await db.query(`INSERT INTO vfs_upload_session
      (id, namespace_id, scope, creation_key, fingerprint, target_path, size_bytes, mime_type,
       condition_type, part_size_bytes, part_count, state, expires_at, max_expires_at, created_at, updated_at)
      VALUES (?, ?, 'scope', ?, ?, '/file', 0, 'text/plain', 'ABSENT', 4, 0, 'OPEN', ?, ?, ?, ?)`, [
      '223e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174000',
      '323e4567-e89b-42d3-a456-426614174000', 'a'.repeat(64),
      '2026-09-27 01:00:00', '2026-09-28 00:00:00', '2026-09-27 00:00:00', '2026-09-27 00:00:00',
    ]);
    await migration.up(runner);
    const rows = await db.query('SELECT creation_expires_at, expires_at FROM vfs_upload_session') as
      Array<{ creation_expires_at: string; expires_at: string }>;
    expect(rows[0].creation_expires_at).toBe(rows[0].expires_at);
    await migration.down(runner);
    const columns = await db.query('PRAGMA table_info(vfs_upload_session)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('creation_expires_at');
    expect(columns.map((column) => column.name)).toContain('expires_at');
    await runner.release();
  });
});
