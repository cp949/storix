import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { installSqliteGate } from './sqlite-gate.js';
import { VfsUploadSessionRepository } from './vfs-upload-session.repository.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsUploadSessionEntity } from './entities/vfs-upload-session.entity.js';
import { VfsUploadPartEntity } from './entities/vfs-upload-part.entity.js';
import { VfsUploadUsageEntity } from './entities/vfs-upload-usage.entity.js';

const NAMESPACE = '123e4567-e89b-42d3-a456-426614174000';
const caps = {
  global: { maxStagedBytes: 10n, maxActiveSessions: 2 },
  namespace: { maxStagedBytes: 10n, maxActiveSessions: 2 },
};

describe('upload session repository (SQLite)', () => {
  let db: DataSource;
  let repository: VfsUploadSessionRepository;
  beforeEach(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      entities: [NamespaceEntity, VfsUploadSessionEntity, VfsUploadPartEntity, VfsUploadUsageEntity],
      migrations: ALL_MIGRATIONS,
    }).initialize();
    await db.runMigrations();
    installSqliteGate(db);
    await db.query('INSERT INTO namespace (id, name) VALUES (?, ?)', [NAMESPACE, 'uploads']);
    repository = new VfsUploadSessionRepository(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  function input(key = randomUUID()) {
    return {
      id: randomUUID(),
      namespaceId: NAMESPACE,
      scope: 'test',
      creationKey: key,
      fingerprint: 'a'.repeat(64),
      targetPath: '/file',
      sizeBytes: '10',
      mimeType: 'text/plain',
      conditionType: 'ABSENT' as const,
      conditionRevision: null,
      partSizeBytes: 10,
      partCount: 1,
      now: new Date('2026-09-27T00:00:00Z'),
      expiresAt: new Date('2026-09-28T00:00:00Z'),
      maxExpiresAt: new Date('2026-10-04T00:00:00Z'),
    };
  }

  it('creation key replays once and active cap remains atomic under concurrent creates', async () => {
    const first = input();
    expect((await repository.createSession(first, caps)).kind).toBe('created');
    expect((await repository.createSession({ ...first, id: randomUUID() }, caps)).kind).toBe('replay');
    expect(
      (await repository.createSession({ ...first, id: randomUUID(), fingerprint: 'b'.repeat(64) }, caps))
        .kind,
    ).toBe('conflict');
    const results = await Promise.all([
      repository.createSession(input(), caps),
      repository.createSession(input(), caps),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['created', 'limit']);
    expect(await db.query("SELECT active_sessions FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { active_sessions: 2 },
    ]);
  });

  it('pages cleanup candidates past 500 failed objects with a stable keyset', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect(await repository.claimTerminalTransition(NAMESPACE, id, 'CANCELLED', new Date())).toBe(true);
    const placeholders = Array.from({ length: 501 }, () => "(?, ?, 1, ?, 'x', 'STORED', '2026-09-27 00:00:00', '2026-09-27 00:00:00')");
    const values = Array.from({ length: 501 }, (_, index) => [id, index, `upload-staging/${randomUUID()}`]).flat();
    await db.query(`INSERT INTO vfs_upload_part
      (session_id, part_index, size_bytes, staging_key, digest, state, created_at, updated_at)
      VALUES ${placeholders.join(',')}`, values);
    const first = await repository.findCleanupParts(null, 500);
    expect(first).toHaveLength(500);
    expect(first[0].partIndex).toBe(0);
    expect(first[499].partIndex).toBe(499);
    const second = await repository.findCleanupParts({ sessionId: id, partIndex: 499 }, 500);
    expect(second.map((part) => part.partIndex)).toEqual([500]);
  });

  it('prunes an eligible terminal session beyond 500 older sessions with undeleted parts', async () => {
    const blockedIds = Array.from({ length: 501 }, () => randomUUID());
    const eligibleId = randomUUID();
    const ids = [...blockedIds, eligibleId];
    const sessionValues = ids.flatMap((id) => [id, randomUUID()]);
    const sessions = ids.map((_, index) =>
      `(?, '${NAMESPACE}', 'scope', ?, '${'a'.repeat(64)}', '/file', 1, 'text/plain',
        'ABSENT', 1, 1, 'CANCELLED', '2026-08-01 00:00:00', '2026-08-02 00:00:00',
        '${index === 501 ? '2026-08-02' : '2026-08-01'} 00:00:00', '2026-08-01 00:00:00', '2026-08-01 00:00:00')`);
    await db.query(`INSERT INTO vfs_upload_session
      (id, namespace_id, scope, creation_key, fingerprint, target_path, size_bytes, mime_type,
       condition_type, part_size_bytes, part_count, state, expires_at, max_expires_at,
       terminal_at, created_at, updated_at)
      VALUES ${sessions.join(',')}`, sessionValues);
    const partValues = blockedIds.flatMap((id) => [id, `upload-staging/${randomUUID()}`]);
    const parts = blockedIds.map(() => "(?, 0, 1, ?, 'x', 'STORED', '2026-08-01 00:00:00', '2026-08-01 00:00:00')");
    await db.query(`INSERT INTO vfs_upload_part
      (session_id, part_index, size_bytes, staging_key, digest, state, created_at, updated_at)
      VALUES ${parts.join(',')}`, partValues);
    expect(await repository.pruneTerminalSessions(new Date('2026-09-27T00:00:00Z'), 500)).toBe(1);
    expect((await db.query('SELECT id FROM vfs_upload_session WHERE id = ?', [eligibleId])) as unknown[]).toEqual([]);
  });

  it('initializes namespace usage only after reading the global usage row', async () => {
    const queries: { sql: string; parameters: unknown }[] = [];
    db.setOptions({ logging: ['query'] });
    const spy = jest.spyOn(db.logger, 'logQuery').mockImplementation((sql, parameters) => {
      queries.push({ sql, parameters });
    });
    try {
      expect((await repository.createSession(input(), caps)).kind).toBe('created');
    } finally {
      db.setOptions({ logging: false });
      spy.mockRestore();
    }
    const globalRead = queries.findIndex(
      ({ sql, parameters }) =>
        sql.includes('vfs_upload_usage') &&
        sql.startsWith('SELECT') &&
        Array.isArray(parameters) &&
        parameters.includes('global'),
    );
    const namespaceInsert = queries.findIndex(
      ({ sql }) => sql.includes('vfs_upload_usage') && sql.startsWith('INSERT'),
    );
    expect(globalRead).toBeGreaterThanOrEqual(0);
    expect(namespaceInsert).toBeGreaterThan(globalRead);
  });

  it('reserves bytes before a part write and releases only after object deletion', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/a', caps)).kind).toBe('reserved');
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/b', caps)).kind).toBe('exists');
    const other = await repository.createSession(input(), caps);
    if (other.kind !== 'created') throw new Error('expected second session');
    expect((await repository.reservePart(other.session.id, 0, '1', 'upload-staging/c', caps)).kind).toBe(
      'limit',
    );
    expect(await repository.commitPart(id, 0, 'a'.repeat(64), null)).toBe(true);
    expect((await repository.findForStatus(NAMESPACE, id))?.parts).toEqual([
      expect.objectContaining({ partIndex: 0, sizeBytes: '10', state: 'STORED' }),
    ]);
    expect(await repository.claimTerminalTransition(NAMESPACE, id, 'CANCELLED', new Date())).toBe(true);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/a', 'STORED')).toBe(true);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 0 },
    ]);
  });

  it('only one terminal transition wins and terminal state releases active count', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    const results = await Promise.all([
      repository.claimTerminalTransition(NAMESPACE, id, 'CANCELLED', new Date()),
      repository.claimTerminalTransition(NAMESPACE, id, 'EXPIRED', new Date()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.query("SELECT active_sessions FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { active_sessions: 0 },
    ]);
  });

  it('terminal claim blocks later reservation and in-flight part commit', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/terminal', caps)).kind).toBe(
      'reserved',
    );
    expect(await repository.claimTerminalTransition(NAMESPACE, id, 'CANCELLED', new Date())).toBe(true);
    expect(await repository.commitPart(id, 0, 'a'.repeat(64), null)).toBe(false);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/later', caps)).kind).toBe('closed');
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/terminal', 'RESERVED')).toBe(true);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 0 },
    ]);
  });

  it('failed write releases reservation, but uncertain object remains charged until deletion', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/failure', caps)).kind).toBe('reserved');
    expect(await repository.releasePartReservation(id, 0)).toBe(true);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 0 },
    ]);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/uncertain', caps)).kind).toBe(
      'reserved',
    );
    expect(await repository.releasePartReservation(id, 0, true)).toBe(true);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 10 },
    ]);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/uncertain', 'CLEANUP')).toBe(true);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 0 },
    ]);
  });

  it('reuses a part index after uncertain object deletion without double charging', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/old', caps)).kind).toBe('reserved');
    expect(await repository.releasePartReservation(id, 0, true)).toBe(true);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/blocked', caps)).kind).toBe('exists');
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/old', 'CLEANUP')).toBe(true);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/new', caps)).kind).toBe('reserved');
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 10 },
    ]);
    expect(await repository.commitPart(id, 0, 'b'.repeat(64), null)).toBe(true);
    expect((await repository.findForStatus(NAMESPACE, id))?.parts).toEqual([
      expect.objectContaining({ partIndex: 0, stagingKey: 'upload-staging/new', state: 'STORED' }),
    ]);
  });

  it('rejects a reused staging key after deletion and accepts a fresh key', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/old', caps)).kind).toBe('reserved');
    expect(await repository.releasePartReservation(id, 0, true)).toBe(true);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/old', 'CLEANUP')).toBe(true);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/old', caps)).kind).toBe('invalid');
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 0 },
    ]);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/fresh', caps)).kind).toBe('reserved');
    expect((await repository.findForStatus(NAMESPACE, id))?.parts).toEqual([]);
  });

  it('ignores a stale deletion callback after a part index is reused', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/old', caps)).kind).toBe('reserved');
    expect(await repository.releasePartReservation(id, 0, true)).toBe(true);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/old', 'CLEANUP')).toBe(true);
    expect((await repository.reservePart(id, 0, '10', 'upload-staging/new', caps)).kind).toBe('reserved');
    expect(await repository.commitPart(id, 0, 'b'.repeat(64), null)).toBe(true);
    expect(await repository.claimTerminalTransition(NAMESPACE, id, 'CANCELLED', new Date())).toBe(true);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/old', 'CLEANUP')).toBe(false);
    expect(await db.query("SELECT staged_bytes FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { staged_bytes: 10 },
    ]);
    expect(await repository.markStagingObjectDeleted(id, 0, 'upload-staging/new', 'STORED')).toBe(true);
  });

  it('compares staged byte caps exactly above 2^53', async () => {
    const created = await repository.createSession(input(), {
      global: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 2 },
      namespace: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 2 },
    });
    if (created.kind !== 'created') throw new Error('expected creation');
    await db.query('UPDATE vfs_upload_usage SET staged_bytes = 9007199254740993');
    expect(
      (
        await repository.reservePart(created.session.id, 0, '1', 'upload-staging/boundary', {
          global: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 2 },
          namespace: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 2 },
        })
      ).kind,
    ).toBe('limit');
    expect(
      await db.query('SELECT CAST(staged_bytes AS TEXT) AS value FROM vfs_upload_usage WHERE id = ?', [
        'global',
      ]),
    ).toEqual([{ value: '9007199254740993' }]);
  });

  it('renews within absolute lifetime and prunes only terminal sessions', async () => {
    const created = await repository.createSession(input(), caps);
    if (created.kind !== 'created') throw new Error('expected creation');
    const id = created.session.id;
    const now = new Date('2026-09-27T01:00:00Z');
    expect(await repository.renewSession(NAMESPACE, id, now, 10 * 86400)).toBe(true);
    expect((await repository.findForStatus(NAMESPACE, id))?.session.expiresAt).toEqual(
      created.session.maxExpiresAt,
    );
    expect(await repository.pruneTerminalSessions(new Date('2026-10-10T00:00:00Z'))).toBe(0);
    await db.getRepository(VfsUploadSessionEntity).update({ id }, { sizeBytes: '0', partCount: 0 });
    expect((await repository.claimFinalize(NAMESPACE, id, 60_000)).kind)
      .toBe('claimed');
    expect(await db.query("SELECT active_sessions FROM vfs_upload_usage WHERE id = 'global'")).toEqual([
      { active_sessions: 1 },
    ]);
    await db.getRepository(VfsUploadSessionEntity).update({ id }, { state: 'COMPLETED', terminalAt: now });
    expect(await repository.pruneTerminalSessions(new Date('2026-10-10T00:00:00Z'))).toBe(1);
    expect(await repository.findForStatus(NAMESPACE, id)).toBeNull();
  });
});
