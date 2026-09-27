import { treeSnapshotContract } from './vfs-snapshot-tree.test-support.js';
import { createFsHttpFixture } from './fs-http-fixture.test-support.js';
import { registerFsPrerequisiteContract } from './fs-prerequisite.test-support.js';
import { registerFsFileSnapshotContract } from './fs-file-snapshot.test-support.js';
import { registerFsMutationReceiptContract } from './fs-mutation-receipt.test-support.js';
import { registerFsConditionalContentContract } from './fs-conditional-content.test-support.js';
import { registerFsErrorReceiptContract } from './fs-error-receipt.test-support.js';
import { registerFsRevisionReadContract } from './fs-revision-read.test-support.js';
import { registerFsBasicOperationsContract } from './fs-basic-operations.test-support.js';
import { registerFsContentHttpContract } from './fs-content-http.test-support.js';
import { registerFsMoveCopyDeleteContract } from './fs-move-copy-delete.test-support.js';
import { registerVfsTrashHttpContract } from './vfs-trash.http.shared-tests.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';

describe('Fs HTTP contract', () => {
  const ctx = createFsHttpFixture();
  treeSnapshotContract(() => ctx.app);
  registerFsPrerequisiteContract(ctx);
  registerFsFileSnapshotContract(ctx);
  registerFsMutationReceiptContract(ctx);
  registerFsConditionalContentContract(ctx);
  registerFsErrorReceiptContract(ctx);
  registerFsRevisionReadContract(ctx);
  registerFsBasicOperationsContract(ctx);
  registerFsContentHttpContract(ctx);
  registerFsMoveCopyDeleteContract(ctx);
  registerVfsTrashHttpContract(
    () => ctx.app,
    ctx.createNamespace,
    async () => {
      await ctx.app.close();
      await ctx.bootstrap();
    },
  );

  it('PostgreSQL restore는 root 잠금 대기 중 만료된 item을 410으로 거절한다', async () => {
    const namespaceId = await ctx.createNamespace(`trash-lock-expiry-${randomUUID()}`);
    process.env.STORIX_ADMIN_API_KEY = 'trash-admin-test-key';
    await request(ctx.httpServer)
      .patch(`/api/v2/admin/namespaces/${namespaceId}/trash`)
      .set('Authorization', 'Bearer trash-admin-test-key')
      .set('Idempotency-Key', randomUUID())
      .send({ enabled: true })
      .expect(200);
    const base = `/api/v2/namespaces/${namespaceId}/fs`;
    await request(ctx.httpServer).post(`${base}/touch`).send({ path: '/expired' }).expect(201);
    const trashId = (await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/expired' }).expect(204))
      .headers['x-trash-id'] as string;
    const holder = ctx.migrationDataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let pending: Promise<request.Response> | undefined;
    let outcome: request.Response | undefined;
    try {
      const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
        namespaceId,
      ]);
      pending = request(ctx.httpServer)
        .post(`${base}/trash/${trashId}/restore`)
        .set('X-Mutation-Scope', 'trash-expiry-lock')
        .set('Idempotency-Key', randomUUID())
        .send({})
        .then((response) => response);
      let blocked = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const rows = await ctx.migrationDataSource.query(
          'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
          [holderPid],
        );
        if (rows.length > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      // 대기 중인 restore transaction이 시작된 뒤 만료 시각을 정해 오래된 CURRENT_TIMESTAMP를 재현한다.
      await holder.query(
        `UPDATE vfs_trash SET expires_at = clock_timestamp() + interval '2 seconds'
        WHERE id = $1`,
        [trashId],
      );
      const [before] = await holder.query(
        'SELECT expires_at > clock_timestamp() AS before FROM vfs_trash WHERE id = $1',
        [trashId],
      );
      expect(before.before).toBe(true);
      let expired = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const [row] = await holder.query(
          'SELECT expires_at <= clock_timestamp() AS expired FROM vfs_trash WHERE id = $1',
          [trashId],
        );
        if (row.expired) {
          expired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(expired).toBe(true);
    } finally {
      if (holder.isTransactionActive) await holder.commitTransaction();
      await holder.release();
      if (pending) outcome = await pending;
    }
    expect(outcome?.status).toBe(410);
    expect(outcome?.body.code).toBe('VFS_TRASH_ITEM_EXPIRED');
    const [{ count }] = await ctx.migrationDataSource.query(
      'SELECT COUNT(*)::integer AS count FROM vfs_trash WHERE id = $1',
      [trashId],
    );
    expect(count).toBe(1);
    const counters = await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: namespaceId });
    expect(String(counters.retainedTrashNodeCount)).toBe('1');
  });
});
