import { randomUUID } from 'node:crypto';
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

  it('5개 마이그레이션이 전부 적용된다', async () => {
    const applied = await dataSource.query('SELECT name FROM migrations ORDER BY id');
    expect(applied.map((row: { name: string }) => row.name)).toEqual([
      'InitSchema1788637362016',
      'AddIdempotencyKey1788700000000',
      'AddBlobZeroSince1788800000000',
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

  it('namespace 리소스 상한 CHECK가 걸린다', async () => {
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
