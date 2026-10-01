/** 실제 PostgreSQL·SQLite에서 삭제 접수의 상태·receipt 원자성과 재생을 검증한다. */
import { createHash, randomUUID } from 'node:crypto';
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
  const create = () => provisioning.createWithRoot(`delete-${randomUUID()}`);

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
    const next = await provisioning.createWithRoot(ns.name);
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
}
