/**
 * 실제 PostgreSQL·SQLite에서 삭제 접수의 상태·receipt 원자성과 재생을 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsNamespaceNotFoundError } from '../../src/vfs/vfs.errors.js';
import type { CreateUploadSessionInput } from '../../src/persistence/vfs-upload-session.repository.js';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from '../../src/persistence/entities/namespace-deletion-receipt.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceDeletionRepository } from '../../src/persistence/namespace-deletion.repository.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';

/** 두 드라이버에서 같은 삭제 접수 불변식을 실행한다. */
export function registerNamespaceDeletionRepositoryTests(getDb: () => DataSource): void {
  let db: DataSource;
  let deletions: NamespaceDeletionRepository;
  let provisioning: NamespaceProvisioningRepository;
  beforeEach(() => {
    db = getDb();
    deletions = new NamespaceDeletionRepository(db, new VfsUploadSessionRepository(db));
    provisioning = new NamespaceProvisioningRepository(db);
  });
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  const create = () => provisioning.createWithRoot(randomUUID(), `delete-${randomUUID()}`);

  it('ACTIVE namespace를 DELETING으로 바꾸고 operation과 202 receipt를 같은 트랜잭션에 저장한다', async () => {
    const ns = await create();
    expect(await deletions.accept(ns.id, hash('first'), new Date('2026-10-01T00:00:00.000Z'))).toEqual({
      kind: 'stored',
      status: 202,
      body: { namespaceId: ns.id, status: 'DELETING' },
    });
    expect(await db.getRepository(NamespaceEntity).findOneByOrFail({ id: ns.id })).toMatchObject({
      status: 'DELETING',
    });
    expect(
      await db.getRepository(NamespaceDeletionEntity).findOneByOrFail({ namespaceId: ns.id }),
    ).toMatchObject({
      phase: 'UPLOADS',
      requestedAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      completedAt: null,
      blockedReason: null,
    });
    expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: ns.id })).toBe(1);
  });
  it('같은 키 재요청은 최초 status와 body를 재생한다', async () => {
    const ns = await create();
    const first = await deletions.accept(ns.id, hash('replay'), new Date('2026-10-01T00:00:00.000Z'));
    await db.getRepository(NamespaceEntity).update(ns.id, { status: 'DELETED' });
    await db
      .getRepository(NamespaceDeletionEntity)
      .update(ns.id, { phase: 'COMPLETED', completedAt: new Date() });
    await db.getRepository(VfsNodeEntity).delete({ namespaceId: ns.id });
    expect(await deletions.accept(ns.id, hash('replay'), new Date('2026-10-01T00:00:00.000Z'))).toEqual({
      ...first,
      kind: 'replay',
    });
  });
  it('같은 키 동시 요청 두 건은 operation 1개와 receipt 1개만 만든다', async () => {
    const ns = await create();
    const results = await Promise.all([
      deletions.accept(ns.id, hash('concurrent'), new Date('2026-10-01T00:00:00.000Z')),
      deletions.accept(ns.id, hash('concurrent'), new Date('2026-10-01T00:00:00.000Z')),
    ]);
    expect(results.map((result) => result?.kind).sort()).toEqual(['replay', 'stored']);
    expect(results[1]?.body).toEqual(results[0]?.body);
    expect(await db.getRepository(NamespaceDeletionEntity).countBy({ namespaceId: ns.id })).toBe(1);
    expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: ns.id })).toBe(1);
  });
  it('DELETING에 새 키로 요청하면 같은 operation을 가리키는 202 receipt를 새로 저장한다', async () => {
    const ns = await create();
    const first = await deletions.accept(ns.id, hash('one'), new Date('2026-10-01T00:00:00.000Z'));
    expect(await deletions.accept(ns.id, hash('two'), new Date('2026-10-01T00:00:00.000Z'))).toEqual(first);
    expect(await db.getRepository(NamespaceDeletionEntity).countBy({ namespaceId: ns.id })).toBe(1);
    expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: ns.id })).toBe(2);
  });
  it('COMPLETED operation에 새 키로 요청하면 root 없이 200 DELETED receipt를 저장한다', async () => {
    const ns = await create();
    await deletions.accept(ns.id, hash('before'), new Date('2026-10-01T00:00:00.000Z'));
    await db.getRepository(VfsNodeEntity).delete({ namespaceId: ns.id });
    await db.getRepository(NamespaceEntity).update(ns.id, { status: 'DELETED' });
    await db
      .getRepository(NamespaceDeletionEntity)
      .update(ns.id, { phase: 'COMPLETED', completedAt: new Date() });
    expect(await deletions.accept(ns.id, hash('after'), new Date('2026-10-01T00:00:00.000Z'))).toEqual({
      kind: 'stored',
      status: 200,
      body: { namespaceId: ns.id, status: 'DELETED' },
    });
    expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: ns.id })).toBe(2);
  });
  it('없는 namespace는 null을 반환하고 receipt를 저장하지 않는다', async () => {
    const id = randomUUID();
    expect(await deletions.accept(id, hash('missing'), new Date('2026-10-01T00:00:00.000Z'))).toBeNull();
    expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: id })).toBe(0);
  });
  it('DELETING 전환 뒤 같은 이름의 ACTIVE namespace를 새로 만들 수 있다', async () => {
    const ns = await create();
    await deletions.accept(ns.id, hash('reuse'), new Date('2026-10-01T00:00:00.000Z'));
    const next = await provisioning.createWithRoot(randomUUID(), ns.name);
    expect(next.id).not.toBe(ns.id);
    expect(next.status).toBe('ACTIVE');
  });
  it('receipt 저장 실패는 상태·operation·namespace usage를 함께 롤백한다', async () => {
    const ns = await create();
    const sqlite = db.options.type === 'better-sqlite3';
    if (sqlite) {
      await db.query(
        `CREATE TRIGGER reject_deletion_receipt BEFORE INSERT ON namespace_deletion_receipt BEGIN SELECT RAISE(ABORT, 'receipt write failure'); END`,
      );
    } else {
      await db.query(
        `CREATE FUNCTION reject_deletion_receipt() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'receipt write failure'; END; $$ LANGUAGE plpgsql`,
      );
      await db.query(
        `CREATE TRIGGER reject_deletion_receipt BEFORE INSERT ON namespace_deletion_receipt FOR EACH ROW EXECUTE FUNCTION reject_deletion_receipt()`,
      );
    }
    try {
      await expect(deletions.accept(ns.id, hash('rollback'), new Date())).rejects.toThrow(
        'receipt write failure',
      );
      expect(await db.getRepository(NamespaceEntity).findOneByOrFail({ id: ns.id })).toMatchObject({
        status: 'ACTIVE',
      });
      expect(await db.getRepository(NamespaceDeletionEntity).countBy({ namespaceId: ns.id })).toBe(0);
      expect(await db.getRepository(NamespaceDeletionReceiptEntity).countBy({ namespaceId: ns.id })).toBe(0);
      expect(await db.getRepository(VfsUploadUsageEntity).findOneBy({ namespaceId: ns.id })).toBeNull();
      expect(await db.getRepository(VfsNodeEntity).countBy({ namespaceId: ns.id })).toBe(1);
    } finally {
      await db.query(
        sqlite
          ? 'DROP TRIGGER reject_deletion_receipt'
          : 'DROP TRIGGER reject_deletion_receipt ON namespace_deletion_receipt',
      );
      if (!sqlite) await db.query('DROP FUNCTION reject_deletion_receipt()');
    }
  });
  it('상태 조회는 없는 namespace와 미접수 namespace를 구분하고 영속 시각을 반환한다', async () => {
    const ns = await create();
    expect(await deletions.findStatus(randomUUID())).toEqual({ namespaceExists: false, view: null });
    expect(await deletions.findStatus(ns.id)).toEqual({ namespaceExists: true, view: null });
    const now = new Date('2026-10-01T00:00:00.000Z');
    await deletions.accept(ns.id, hash('status'), now);
    expect(await deletions.findStatus(ns.id)).toEqual({
      namespaceExists: true,
      view: {
        namespaceId: ns.id,
        status: 'DELETING',
        phase: 'UPLOADS',
        requestedAt: now,
        completedAt: null,
        blockedReason: null,
      },
    });
  });
  // 같은 root·usage 잠금에 삭제와 writer를 진입시켜 실제 DB 순서를 검증한다.
  const nodes = () =>
    new VfsNodeRepository(
      db.getRepository(NamespaceEntity),
      db.getRepository(VfsNodeEntity),
      db.getRepository(BlobEntity),
      db,
      new BlobRepository(db),
      new ConfigService(),
    );
  const caps = {
    global: { maxStagedBytes: 100000n, maxActiveSessions: 10000 },
    namespace: { maxStagedBytes: 100000n, maxActiveSessions: 100 },
  };
  const input = (namespaceId: string): CreateUploadSessionInput => ({
    id: randomUUID(),
    namespaceId,
    scope: 'deletion-race',
    creationKey: randomUUID(),
    fingerprint: 'a'.repeat(64),
    targetPath: '/upload',
    sizeBytes: '1',
    mimeType: 'text/plain',
    conditionType: 'ABSENT',
    conditionRevision: null,
    fileExpiresInSeconds: null,
    partSizeBytes: 1,
    partCount: 1,
    now: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    maxExpiresAt: new Date(Date.now() + 120000),
  });
  it('사전 root 조회 뒤 삭제가 먼저 커밋되면 withMutation은 반영하지 않고 404를 던진다', async () => {
    const ns = await create();
    const repo = nodes();
    const root = (await repo.getRoot(ns.id))!;
    await deletions.accept(ns.id, hash('writer-late'), new Date());
    await expect(
      repo.withMutation(ns.id, root.id, async (tx) => {
        await tx.manager.getRepository(VfsNodeEntity).update(root.id, { version: 2 });
      }),
    ).rejects.toThrow(VfsNamespaceNotFoundError);
    expect((await db.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version).toBe(1);
    expect(await repo.getRoot(ns.id)).toBeNull();
    expect(await repo.getRootWithLimits(ns.id)).toBeNull();
  });
  it('사전 root 조회 뒤 삭제가 DELETED까지 끝나 root가 사라져도 NAMESPACE_NOT_FOUND 계열로 던진다', async () => {
    const ns = await create();
    const repo = nodes();
    const root = (await repo.getRoot(ns.id))!;
    await deletions.accept(ns.id, hash('writer-deleted'), new Date());
    await db.getRepository(NamespaceEntity).update(ns.id, { status: 'DELETED' });
    await db.getRepository(VfsNodeEntity).delete({ namespaceId: ns.id });
    await expect(repo.withMutation(ns.id, root.id, async () => undefined)).rejects.toThrow(
      VfsNamespaceNotFoundError,
    );
    await expect(repo.createChangeFeedCheckpoint(ns.id, root.id)).rejects.toThrow(VfsNamespaceNotFoundError);
  });
  it('writer가 root 잠금을 먼저 잡으면 변경을 커밋한 뒤 삭제가 접수된다', async () => {
    const ns = await create();
    const repo = nodes();
    const root = (await repo.getRoot(ns.id))!;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writerPid: number | undefined;
    const writer = repo.withMutation(ns.id, root.id, async (tx) => {
      if (db.options.type !== 'better-sqlite3') {
        const [{ pid }] = (await tx.manager.query('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
        writerPid = pid;
      }
      entered();
      await gate;
      await tx.manager.getRepository(VfsNodeEntity).update(root.id, { version: 2 });
    });
    await ready;
    const deletion = deletions.accept(ns.id, hash('writer-first'), new Date());
    try {
      if (db.options.type !== 'better-sqlite3') {
        const deadline = Date.now() + 5000;
        let blocked = 0;
        while (Date.now() < deadline) {
          // bind 값은 pg_stat_activity에 나오지 않는다. writer PID와 root 조회 SQL로 대상을 묶는다.
          const [{ count }] = (await db.query(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity a
             WHERE a.datname = current_database()
               AND $1 = ANY(pg_blocking_pids(a.pid))
               AND a.query LIKE '%vfs_node%'
               AND a.query LIKE '%namespace_id%'
               AND a.query LIKE '%parent_id%IS NULL%'
               AND a.query LIKE '%FOR UPDATE%'`,
            [writerPid],
          )) as { count: number }[];
          blocked = count;
          if (blocked === 1) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(1);
      }
    } finally {
      // 관찰 실패에서도 writer와 삭제 요청을 정착시켜 다음 테스트에 잠금을 남기지 않는다.
      release();
      await Promise.allSettled([writer, deletion]);
    }
    await writer;
    expect((await deletion)?.status).toBe(202);
    expect((await db.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version).toBe(2);
  });
  it('삭제 접수 뒤 createSession·reservePart·claimFinalize·renewSession은 404를 던진다', async () => {
    const ns = await create();
    const uploads = new VfsUploadSessionRepository(db);
    const row = input(ns.id);
    await uploads.createSession(row, caps);
    await deletions.accept(ns.id, hash('upload-block'), new Date());
    for (const attempt of [
      () => uploads.createSession(input(ns.id), caps),
      () => uploads.reservePart(row.id, 0, '1', `upload-staging/${randomUUID()}`, caps),
      () => uploads.claimFinalize(ns.id, row.id, 60000),
      () => uploads.renewSession(ns.id, row.id, new Date(), 60),
    ])
      await expect(attempt()).rejects.toThrow(VfsNamespaceNotFoundError);
  });
  if (process.env.STORIX_DB_DRIVER !== 'sqlite')
    it('삭제 접수와 createSession을 동시에 실행해도 deadlock 없이 둘 중 하나의 순서로 끝난다', async () => {
      const uploads = new VfsUploadSessionRepository(db);
      for (let i = 0; i < 20; i++) {
        const ns = await create();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const results = await Promise.race([
            Promise.allSettled([
              deletions.accept(ns.id, hash(`race-${i}`), new Date()),
              uploads.createSession(input(ns.id), caps),
            ]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('deadlock timeout')), 5000);
            }),
          ]);
          expect(results[0].status).toBe('fulfilled');
          if (results[1].status === 'rejected')
            expect(results[1].reason).toBeInstanceOf(VfsNamespaceNotFoundError);
          else expect(results[1].value.kind).toBe('created');
        } finally {
          clearTimeout(timer);
        }
      }
    });
  it('삭제 접수 뒤 change-feed checkpoint 생성은 404다', async () => {
    const ns = await create();
    const repo = nodes();
    const root = (await repo.getRoot(ns.id))!;
    await deletions.accept(ns.id, hash('feed-block'), new Date());
    await expect(repo.createChangeFeedCheckpoint(ns.id, root.id)).rejects.toThrow(VfsNamespaceNotFoundError);
  });
  it('withMutation allowInactive 옵션은 DELETING namespace의 root 잠금을 허용한다', async () => {
    const ns = await create();
    const repo = nodes();
    const root = (await repo.getRoot(ns.id))!;
    await deletions.accept(ns.id, hash('internal'), new Date());
    expect(
      (await repo.withMutation(ns.id, root.id, async () => 'internal', undefined, { allowInactive: true }))
        .value,
    ).toBe('internal');
    expect(await repo.expireNode(ns.id, root.id, new Date())).toBeNull();
  });
}
