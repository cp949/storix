import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

// 이 파일은 STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행으로만 돌린다
// (Task 6 Step 6 참고) — 전체 test:integration에 포함시키면 같은 워커의
// Postgres 테스트가 dialect-column-types 상수 오염으로 깨진다.
describe('마이그레이션 체인 (SQLite)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('6개 마이그레이션이 전부 적용된다', async () => {
    const applied = await dataSource.query('SELECT name FROM migrations ORDER BY id');
    expect(applied.map((row: { name: string }) => row.name)).toEqual([
      'InitSchema1788637362016',
      'AddIdempotencyKey1788700000000',
      'AddBlobZeroSince1788800000000',
      'AddNamespaceResourceLimits1789000000000',
      'AddEncryptionSupport1789100000000',
      'AddAuditLog1789200000000',
      'AddGcState1789300000000',
    ]);
  });

  it('gc_state 테이블은 생성되지 않는다(AddGcState가 SQLite에서 no-op)', async () => {
    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='gc_state'`);
    expect(tables).toHaveLength(0);
  });

  it('namespace를 생성하고 CHECK 제약이 걸린다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);
    const saved = await repo.save(repo.create({ name: 'acme' }));

    expect(saved.id).toBeDefined();
    expect(saved.encryptionPolicy).toBe('NONE');

    await expect(repo.save(repo.create({ name: 'ABC' }))).rejects.toThrow();
  });

  it('namespace 리소스 상한 CHECK가 재구성 후에도 걸린다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);

    await expect(repo.save(repo.create({ name: 'limit-test', maxSyncDeleteNodes: 0 }))).rejects.toThrow();

    const saved = await repo.save(repo.create({ name: 'limit-ok', maxSyncDeleteNodes: 5 }));
    expect(saved.maxSyncDeleteNodes).toBe(5);
  });

  it('encryption_policy를 ENCRYPTED로 저장하고 blob에 encryption_iv(blob)를 저장·조회한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(
      namespaceRepo.create({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' }),
    );

    const blobRepo = dataSource.getRepository(BlobEntity);
    const iv = Buffer.from('0123456789abcdef');
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId: namespace.id,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '10',
        mimeType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
        encryptionIv: iv,
      }),
    );

    const found = await blobRepo.findOneByOrFail({ id: blob.id });
    expect(found.encryptionIv).toEqual(iv);
    expect(found.createdAt).toBeInstanceOf(Date);
  });

  it('16바이트가 아닌 encryption_iv는 CHECK 제약 위반으로 거부된다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'bad-iv-ns' }));
    const blobRepo = dataSource.getRepository(BlobEntity);

    await expect(
      blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/ab/${randomUUID()}`,
          size: '1',
          mimeType: 'application/octet-stream',
          sha256: 'b'.repeat(64),
          encryptionIv: Buffer.from('ab', 'hex'),
        }),
      ),
    ).rejects.toThrow();
  });

  it('idempotency_key를 jsonb 컬럼 그대로 저장·조회한다', async () => {
    const repo = dataSource.getRepository(IdempotencyKeyEntity);
    const saved = await repo.save(
      repo.create({
        key: 'sqlite-test-key',
        requestHash: 'c'.repeat(64),
        responseStatus: 201,
        responseBody: { id: 'x', nested: { ok: true } },
      }),
    );

    const found = await repo.findOneByOrFail({ key: saved.key });
    expect(found.responseBody).toEqual({ id: 'x', nested: { ok: true } });
  });

  it('audit_log를 생성하고 조회한다', async () => {
    const repo = dataSource.getRepository(AuditLogEntity);
    const saved = await repo.save(repo.create({ requestId: 'req-1', operation: 'FsController.ls', status: 200 }));

    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.createdAt).toBeInstanceOf(Date);
  });

  it('blob.zero_since를 백필하고 조회한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'zero-since-ns' }));
    const blobRepo = dataSource.getRepository(BlobEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId: namespace.id,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'd'.repeat(64),
        referenceCount: 0,
      }),
    );

    // BlobEntity.zeroSince는 INSERT 시 자동으로 채워지지 않는다(migration의
    // 백필은 마이그레이션 실행 시점에 이미 존재하던 row 전용, 이후 갱신은
    // BlobRepository의 reference_count 감소 UPDATE 전용) — Postgres 통합
    // 테스트의 'zero_since를 채워 넣고 조회할 수 있다'와 동일하게 백필을
    // 명시적 UPDATE로 재현한다. sqlite에는 now()가 없어 datetime('now')를 쓴다.
    await dataSource.query(`UPDATE blob SET zero_since = datetime('now') WHERE id = '${blob.id}'`);

    const found = await blobRepo.findOneByOrFail({ id: blob.id });
    expect(found.zeroSince).toBeInstanceOf(Date);
  });
});

describe('재구성 마이그레이션 row 커버리지 (실제 파일)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 의미가 없다');
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-sqlite-migration-coverage-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('AddNamespaceResourceLimits 실행 전 namespace row가 있어도 재구성 후 데이터가 보존된다', async () => {
    const dsBefore = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS.slice(0, 3),
    });
    await dsBefore.initialize();
    await dsBefore.runMigrations();

    const seededId = randomUUID();
    await dsBefore.query(
      `INSERT INTO namespace (id, name, encryption_policy, status, created_at, updated_at)
       VALUES (?, ?, 'NONE', 'ACTIVE', datetime('now'), datetime('now'))`,
      [seededId, 'pre-migration-ns'],
    );
    await dsBefore.destroy();

    const dsAfter = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS.slice(0, 4),
    });
    await dsAfter.initialize();
    await dsAfter.runMigrations();

    const found = await dsAfter.getRepository(NamespaceEntity).findOneByOrFail({ id: seededId });
    expect(found.name).toBe('pre-migration-ns');
    expect(found.maxFileSizeBytes).toBeNull();

    await dsAfter.destroy();
  });

  it('AddEncryptionSupport 실행 전 namespace/blob row가 있어도 재구성 후 데이터가 보존된다', async () => {
    const dsBefore = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS.slice(0, 4),
    });
    await dsBefore.initialize();
    await dsBefore.runMigrations();

    const seededNamespaceId = randomUUID();
    await dsBefore.query(
      `INSERT INTO namespace (id, name, encryption_policy, status, max_sync_delete_nodes, created_at, updated_at)
       VALUES (?, ?, 'NONE', 'ACTIVE', ?, datetime('now'), datetime('now'))`,
      [seededNamespaceId, 'pre-encryption-ns', 5],
    );
    const seededBlobId = randomUUID();
    await dsBefore.query(
      `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      [seededBlobId, seededNamespaceId, 'blobs/ab/pre-encryption-blob', '1', 'application/octet-stream', 'a'.repeat(64)],
    );
    await dsBefore.destroy();

    const dsAfter = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS.slice(0, 5),
    });
    await dsAfter.initialize();
    await dsAfter.runMigrations();

    const foundNamespace = await dsAfter
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: seededNamespaceId });
    expect(foundNamespace.name).toBe('pre-encryption-ns');
    expect(foundNamespace.maxSyncDeleteNodes).toBe(5);

    const foundBlob = await dsAfter.getRepository(BlobEntity).findOneByOrFail({ id: seededBlobId });
    expect(foundBlob.storageKey).toBe('blobs/ab/pre-encryption-blob');
    expect(foundBlob.encryptionIv).toBeNull();

    await dsAfter.destroy();
  });
});

describe('down() 마이그레이션 체인 (실제 파일)', () => {
  let tmpDir: string;
  let dbPath: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 의미가 없다');
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-sqlite-down-chain-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('재구성 마이그레이션이 보존해야 하는 row를 심어 둔 뒤 전부 역순 down하면 원래 스키마로 되돌아오고 데이터도 보존된다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const seededNamespace = await namespaceRepo.save(
      namespaceRepo.create({ name: 'down-chain-ns', maxSyncDeleteNodes: 7 }),
    );
    const blobRepo = dataSource.getRepository(BlobEntity);
    const seededBlob = await blobRepo.save(
      blobRepo.create({
        namespaceId: seededNamespace.id,
        storageKey: 'blobs/ab/down-chain',
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'f'.repeat(64),
      }),
    );

    // { transaction: 'none' }를 명시해야 한다 — DataSource.undoLastMigration()은
    // (runMigrations()와 달리) migrationsTransactionMode 옵션이나 마이그레이션
    // 인스턴스의 transaction=false 오버라이드를 전혀 보지 않고 옵션 미지정 시
    // 항상 자체 트랜잭션으로 감싼다(TypeORM 1.1.1 API 비대칭). 재구성
    // 마이그레이션의 downSqlite()는 PRAGMA foreign_keys=OFF + 수동
    // BEGIN/COMMIT으로 스스로 트랜잭션을 관리하도록 설계돼 있어(PRAGMA
    // foreign_keys는 트랜잭션 안에서는 no-op이므로), 이미 열려 있는 트랜잭션
    // 안에서 호출되면 'cannot start a transaction within a transaction'으로
    // 즉시 실패하거나(중첩 BEGIN) FK enforcement가 꺼지지 않은 채로 namespace를
    // 드롭해 blob.namespace_id FK 위반이 날 수 있다.
    //
    // InitSchema(ALL_MIGRATIONS[0])를 undo하면 namespace/blob 등 테이블 자체가
    // DROP돼 사라진다(InitSchema.down()은 "테이블을 만들기 이전" 상태로 되돌리는
    // 것이 정의라 CREATE의 역인 DROP을 한다) — 그 뒤에는 아래 컬럼/데이터
    // assertion들이 검증 대상 자체가 없어져 무의미해진다. 그래서 InitSchema
    // 직전(ALL_MIGRATIONS.length - 1개)까지만 먼저 되돌려 재구성
    // 마이그레이션(AddNamespaceResourceLimits/AddEncryptionSupport)의 down()이
    // 남긴 실제 스키마·데이터를 검증한 뒤, 마지막으로 InitSchema까지 마저
    // 되돌려 migrations 테이블이 완전히 빈 상태(진짜 "원래 스키마")로
    // 돌아오는지 확인한다. undoLastMigration() 총 호출 횟수는
    // ALL_MIGRATIONS.length와 동일(6 + 1)하다.
    for (let i = 0; i < ALL_MIGRATIONS.length - 1; i += 1) {
      await dataSource.undoLastMigration({ transaction: 'none' });
    }

    const namespaceColumns: { name: string }[] = await dataSource.query(`PRAGMA table_info(namespace)`);
    expect(namespaceColumns.map((c) => c.name)).not.toContain('max_sync_delete_nodes');
    expect(namespaceColumns.map((c) => c.name)).not.toContain('max_file_size_bytes');

    const blobColumns: { name: string }[] = await dataSource.query(`PRAGMA table_info(blob)`);
    expect(blobColumns.map((c) => c.name)).not.toContain('encryption_iv');
    expect(blobColumns.map((c) => c.name)).not.toContain('zero_since');

    const idempotencyKeyTables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency_key'`,
    );
    expect(idempotencyKeyTables).toHaveLength(0);
    const auditLogTables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`,
    );
    expect(auditLogTables).toHaveLength(0);

    // 재구성 down()이 CREATE ... AS SELECT 경로에서 데이터를 유실하지 않았는지 —
    // 원본 row가 (재구성 이전 스키마의 컬럼만으로도) 여전히 조회 가능해야 한다.
    const rawNamespace = await dataSource.query('SELECT name FROM namespace WHERE id = ?', [seededNamespace.id]);
    expect(rawNamespace).toEqual([{ name: 'down-chain-ns' }]);
    const rawBlob = await dataSource.query('SELECT storage_key FROM blob WHERE id = ?', [seededBlob.id]);
    expect(rawBlob).toEqual([{ storage_key: 'blobs/ab/down-chain' }]);

    // 마지막으로 InitSchema까지 되돌려 migrations 테이블이 완전히 비는지 확인한다.
    await dataSource.undoLastMigration({ transaction: 'none' });
    const remaining = await dataSource.query('SELECT name FROM migrations');
    expect(remaining).toHaveLength(0);
  });
});
