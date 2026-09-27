import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { DataSource, IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { withoutStatHash } from './fs-http-fixture.test-support.js';
import type { SnapshotPost } from './fs-file-snapshot.test-support.js';

export function registerFsFileSnapshotRestContract(
  ctx: FsHttpContext,
  scope: string,
  snapshotPost: SnapshotPost,
) {
  async function restoreFixture(name: string) {
    const ns = await ctx.createNamespace(name);
    const base = `/api/v2/namespaces/${ns}/fs`;
    const bytes = Buffer.from([0, 255, 128, 65]);
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/source' })
      .set('Content-Type', 'Application/Octet-Stream; ignored=value')
      .send(bytes)
      .expect(201);
    const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/source"}').expect(
      201,
    );
    const blob = await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns });
    return { ns, base, bytes, blob, id: captured.body.snapshotId as string };
  }
  it('restore 생성/교체는 같은 Blob과 MIME을 유지하며 revision과 receipt를 원자적으로 갱신한다', async () => {
    const { ns, base, bytes, blob, id } = await restoreFixture('snapshot-restore-lifecycle');
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
    const key = randomUUID();
    const raw = '{"path":"/target","ifAbsent":true}';
    const restored = await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
    expect(restored.body).toMatchObject({
      snapshotId: id,
      resource: { path: '/target', version: 1, mimeType: 'application/octet-stream' },
    });
    const target = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, name: 'target' });
    expect(target.blobId).toBe(blob.id);
    expect(restored.body.affectedRevisions).toContainEqual({
      path: '/target',
      revision: encodeRevision(target),
    });
    const replay = await snapshotPost(base, `/${id.toUpperCase()}/restore`, key, raw).expect(201);
    expect(replay.body).toEqual(restored.body);
    expect(replay.headers['x-request-id']).toBe(restored.headers['x-request-id']);
    expect((await snapshotPost(base, `/${id}/restore`, key, raw + ' ').expect(409)).body.code).toBe(
      'MUTATION_KEY_REUSED',
    );
    const beforeRoot = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
    const replaced = await snapshotPost(
      base,
      `/${id}/restore`,
      randomUUID(),
      JSON.stringify({ path: '/target', ifRevision: encodeRevision(target) }),
    ).expect(200);
    const afterTarget = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: target.id });
    const afterRoot = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: beforeRoot.id });
    expect(afterTarget.version).toBe(target.version + 1);
    expect(afterRoot.version).toBe(beforeRoot.version + 1);
    expect(replaced.body.resource.version).toBe(afterTarget.version);
    expect(replaced.body.affectedRevisions).toContainEqual({
      path: '/target',
      revision: encodeRevision(afterTarget),
    });
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(2);
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/target', force: 'true' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('new'))
      .expect(200);
    const changed = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: target.id });
    await snapshotPost(
      base,
      `/${id}/restore`,
      randomUUID(),
      JSON.stringify({ path: '/target', ifRevision: encodeRevision(changed) }),
    ).expect(200);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: changed.blobId! }))
        .referenceCount,
    ).toBe(0);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(2);
    await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(200);
    const content = await request(ctx.httpServer)
      .get(`${base}/content`)
      .query({ path: '/target' })
      .expect(200);
    expect(content.body).toEqual(bytes);
    expect(content.headers['content-type']).toBe('application/octet-stream');
  });

  it('restore 조건 오류와 directory/parent/다른 namespace/없는 snapshot을 구별한다', async () => {
    const { ns, base, id } = await restoreFixture('snapshot-restore-errors');
    const node = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, name: 'source' });
    const revision = encodeRevision(node);
    const cases: [object, number][] = [
      [{ path: '/target' }, 428],
      [{ path: '/target', ifAbsent: true, ifRevision: revision }, 400],
      [{ path: '/target', ifAbsent: false }, 400],
      [{ path: '/target', ifRevision: 'bad' }, 400],
      [{ path: '/target', ifRevision: revision }, 404],
      [{ path: '/missing/target', ifAbsent: true }, 404],
      [{ path: '/source', ifAbsent: true }, 412],
      [{ path: '/source', ifRevision: encodeRevision({ id: randomUUID(), version: 1 }) }, 412],
    ];
    for (const [body, status] of cases)
      await snapshotPost(base, `/${id}/restore`, randomUUID(), JSON.stringify(body)).expect(status);
    await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    for (const condition of [{ ifAbsent: true }, { ifRevision: revision }])
      await snapshotPost(
        base,
        `/${id}/restore`,
        randomUUID(),
        JSON.stringify({ path: '/dir', ...condition }),
      ).expect(409);
    await snapshotPost(
      base,
      `/${randomUUID()}/restore`,
      randomUUID(),
      '{"path":"/source","ifAbsent":true}',
    ).expect(404);
    const other = await ctx.createNamespace('snapshot-restore-other');
    await snapshotPost(
      `/api/v2/namespaces/${other}/fs`,
      `/${id}/restore`,
      randomUUID(),
      '{"path":"/target","ifAbsent":true}',
    ).expect(404);
    const ds = ctx.app.get(DataSource);
    await ds.getRepository(VfsSnapshotEntity).update(id, { kind: 'TREE', rootType: 'DIRECTORY' });
    await snapshotPost(base, `/${id}/restore`, randomUUID(), '{"path":"/source","ifAbsent":true}').expect(
      409,
    );
    expect(
      (await ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: node.id })).version,
    ).toBe(node.version);
  });

  it('restore receipt 실패는 target/refcount/revision을 롤백하고 같은 key 재시도를 허용한다', async () => {
    const { ns, base, id, blob } = await restoreFixture('snapshot-restore-rollback');
    const key = randomUUID();
    const raw = '{"path":"/target","ifAbsent":true}';
    const root = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
    const spy = jest
      .spyOn(ctx.app.get(VfsMutationReceiptRepository), 'complete')
      .mockRejectedValueOnce(new Error('injected restore receipt failure'));
    try {
      await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneBy({ namespaceId: ns, name: 'target' }),
    ).toBeNull();
    expect(
      (await ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version,
    ).toBe(root.version);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(2);
    expect(
      await ctx.migrationDataSource
        .getRepository(VfsMutationReceiptEntity)
        .findOneBy({ namespaceId: ns, idempotencyKey: key }),
    ).toBeNull();
    await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
  });

  it('restore가 namespace 논리 quota를 넘으면 파일·snapshot·Blob 참조·revision·사용량을 유지한다', async () => {
    const { ns, base, id, blob } = await restoreFixture('snapshot-restore-quota');
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
    await ctx.migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxTotalLogicalBytes: '7' });
    const root = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
    const namespaceBefore = await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: ns });
    const snapshotDataSource = ctx.app.get(DataSource);
    const snapshotBefore = await snapshotDataSource.getRepository(VfsSnapshotEntity).findOneByOrFail({ id });
    const entryCountBefore = await snapshotDataSource
      .getRepository(VfsSnapshotEntryEntity)
      .countBy({ snapshotId: id });
    const blobBefore = await ctx.migrationDataSource
      .getRepository(BlobEntity)
      .findOneByOrFail({ id: blob.id });

    const rejected = await snapshotPost(
      base,
      `/${id}/restore`,
      randomUUID(),
      '{"path":"/target","ifAbsent":true}',
    ).expect(413);
    expect(rejected.body.code).toBe('VFS_QUOTA_EXCEEDED');
    expect(
      await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneBy({ namespaceId: ns, name: 'target' }),
    ).toBeNull();
    expect(
      (await ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version,
    ).toBe(root.version);
    const namespaceAfter = await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: ns });
    expect(String(namespaceAfter.liveFileByteCount)).toBe(String(namespaceBefore.liveFileByteCount));
    expect(String(namespaceAfter.retainedSnapshotByteCount)).toBe(
      String(namespaceBefore.retainedSnapshotByteCount),
    );
    expect(namespaceAfter.retainedSnapshotNodeCount).toBe(namespaceBefore.retainedSnapshotNodeCount);
    expect(await snapshotDataSource.getRepository(VfsSnapshotEntity).findOneByOrFail({ id })).toEqual(
      snapshotBefore,
    );
    expect(await snapshotDataSource.getRepository(VfsSnapshotEntryEntity).countBy({ snapshotId: id })).toBe(
      entryCountBefore,
    );
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(blobBefore.referenceCount);
  });

  it('restore 교체 rollback은 두 Blob 참조와 기존 bytes/revision 및 snapshot 예산을 보존한다', async () => {
    const { ns, base, id, blob } = await restoreFixture('snapshot-restore-replace-rollback');
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/target' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('old target'))
      .expect(201);
    const target = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, name: 'target' });
    const key = randomUUID();
    const raw = JSON.stringify({ path: '/target', ifRevision: encodeRevision(target) });
    const spy = jest
      .spyOn(ctx.app.get(VfsMutationReceiptRepository), 'complete')
      .mockRejectedValueOnce(new Error('injected restore replace failure'));
    try {
      await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
    } finally {
      spy.mockRestore();
    }
    const after = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: target.id });
    expect(after.blobId).toBe(target.blobId);
    expect(after.version).toBe(target.version);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(2);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: target.blobId! }))
        .referenceCount,
    ).toBe(1);
    const namespace = await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: ns });
    expect(namespace.retainedSnapshotNodeCount).toBe(1);
    expect(String(namespace.retainedSnapshotByteCount)).toBe(blob.size);
    expect(
      (await request(ctx.httpServer).get(`${base}/content`).query({ path: '/target' }).expect(200)).body,
    ).toEqual(Buffer.from('old target'));
    await snapshotPost(base, `/${id}/restore`, key, raw).expect(200);
  });

  it('restore 412를 current와 함께 receipt로 고정해 target 제거 뒤에도 같은 key는 재생한다', async () => {
    const { base, id } = await restoreFixture('snapshot-restore-condition-retry');
    const key = randomUUID();
    const raw = '{"path":"/source","ifAbsent":true}';
    const stat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/source' }).expect(200))
      .body;
    const revisionAtConflict = (
      await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/source' }).expect(200)
    ).body.revision as string;
    const first = await snapshotPost(base, `/${id}/restore`, key, raw).expect(412);
    expect(first.body).toMatchObject({
      code: 'VFS_PRECONDITION_FAILED',
      path: '/source',
      current: { ...withoutStatHash(stat), revision: revisionAtConflict },
    });
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
    const replay = await snapshotPost(base, `/${id}/restore`, key, raw).expect(412);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.current.revision).toBe(revisionAtConflict);
    expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    expect(
      (await snapshotPost(base, `/${id}/restore`, key, '{"path":"/source","ifAbsent":true }').expect(409))
        .body.code,
    ).toBe('MUTATION_KEY_REUSED');
    await snapshotPost(base, `/${id}/restore`, randomUUID(), raw).expect(201);
  });

  it.each(['restore', 'delete'] as const)(
    'PostgreSQL root lock 순서 %s 선행은 restore/delete를 직렬화한다',
    async (first) => {
      const { ns, base, bytes, id, blob } = await restoreFixture(`snapshot-restore-race-${first}`);
      const holder = ctx.migrationDataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
        ns,
      ]);
      const pending: Promise<request.Response>[] = [];
      let completed = 0;
      const start = (operation: 'restore' | 'delete') => {
        const result = snapshotPost(
          base,
          `/${id}/${operation}`,
          randomUUID(),
          operation === 'restore' ? '{"path":"/target","ifAbsent":true}' : '{}',
        ).then((response) => {
          completed += 1;
          return response;
        });
        pending.push(result);
      };
      const blocked = async (count: number) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = await ctx.migrationDataSource.query(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
            [holderPid],
          );
          if (rows.length >= count) {
            expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
            return;
          }
          if (completed > 0) throw new Error('mutation finished before root lock release');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`expected ${count} PostgreSQL root lock waiters`);
      };
      try {
        start(first);
        await blocked(1);
        start(first === 'restore' ? 'delete' : 'restore');
        await blocked(2);
      } finally {
        await holder.commitTransaction();
        await holder.release();
        await Promise.all(pending);
      }
      const [one, two] = await Promise.all(pending);
      expect([one.status, two.status]).toEqual(first === 'restore' ? [201, 200] : [200, 404]);
      expect(await ctx.app.get(DataSource).getRepository(VfsSnapshotEntity).findOneBy({ id })).toBeNull();
      const target = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneBy({ namespaceId: ns, name: 'target' });
      expect(target?.blobId ?? null).toBe(first === 'restore' ? blob.id : null);
      expect(
        (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
          .referenceCount,
      ).toBe(first === 'restore' ? 2 : 1);
      for (const path of first === 'restore' ? ['/source', '/target'] : ['/source'])
        expect(
          (await request(ctx.httpServer).get(`${base}/content`).query({ path }).expect(200)).body,
        ).toEqual(bytes);
    },
  );

  it('원본 overwrite/delete 뒤에도 binary bytes와 정규화 MIME을 유지하고 삭제는 한 번만 ref를 해제한다', async () => {
    const ns = await ctx.createNamespace('snapshot-file-lifecycle');
    const base = `/api/v2/namespaces/${ns}/fs`;
    const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/binary' })
      .set('Content-Type', 'Application/Octet-Stream; ignored=value')
      .send(bytes)
      .expect(201);
    const blob = await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns });
    const key = randomUUID();
    const raw = '{"kind":"file","path":"/binary"}';
    const first = await snapshotPost(base, '', key, raw).expect(201);
    expect(first.body).toMatchObject({
      snapshotId: expect.any(String),
      kind: 'file',
      sourcePath: '/binary',
      nodeCount: 1,
      logicalBytes: '6',
    });
    const id = first.body.snapshotId as string;
    expect((await snapshotPost(base, '', key, raw).expect(201)).body).toEqual(first.body);
    expect((await snapshotPost(base, '', key, raw).expect(201)).headers['x-request-id']).toBe(
      first.headers['x-request-id'],
    );
    for (const changed of ['{ "kind":"file","path":"/binary"}', '{"kind":"file","path":"/other"}']) {
      expect((await snapshotPost(base, '', key, changed).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
    }
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(2);
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/binary', force: 'true' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('replacement'))
      .expect(200);
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/binary' }).expect(204);
    expect((await request(ctx.httpServer).get(`${base}/snapshots/${id}`).expect(200)).body).toEqual(
      first.body,
    );
    const read = await request(ctx.httpServer).get(`${base}/snapshots/${id}/content`).expect(200);
    expect(read.body).toEqual(bytes);
    expect(read.headers['content-type']).toBe('application/octet-stream');
    const range = await request(ctx.httpServer)
      .get(`${base}/snapshots/${id}/content`)
      .set('Range', 'bytes=1-3')
      .expect(206);
    expect(range.body).toEqual(bytes.subarray(1, 4));
    expect(range.headers['content-range']).toBe('bytes 1-3/6');
    await request(ctx.httpServer)
      .get(`${base}/snapshots/${id}/content`)
      .set('Range', 'bytes=99-100')
      .expect(416);
    const other = await ctx.createNamespace('snapshot-file-other');
    const otherBase = `/api/v2/namespaces/${other}/fs`;
    await request(ctx.httpServer).get(`${otherBase}/snapshots/${id}`).expect(404);
    await request(ctx.httpServer).get(`${otherBase}/snapshots/${id}/content`).expect(404);
    await snapshotPost(otherBase, `/${id}/delete`, randomUUID(), '{}').expect(404);
    const deleteKey = randomUUID();
    const removed = await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200);
    expect(removed.body).toEqual({ snapshotId: id, deleted: true });
    expect((await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200)).body).toEqual(
      removed.body,
    );
    expect(
      (await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200)).headers['x-request-id'],
    ).toBe(removed.headers['x-request-id']);
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
        .referenceCount,
    ).toBe(0);
    const namespace = await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: ns });
    expect(namespace.retainedSnapshotNodeCount).toBe(0);
    expect(String(namespace.retainedSnapshotByteCount)).toBe('0');
    await request(ctx.httpServer).get(`${base}/snapshots/${id}`).expect(404);
    await request(ctx.httpServer).get(`${base}/snapshots/${id}/content`).expect(404);
    await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(404);
    expect((await snapshotPost(base, `/${randomUUID()}/delete`, deleteKey, '{}').expect(409)).body.code).toBe(
      'MUTATION_KEY_REUSED',
    );
  });

  it('삭제된 snapshot과 없는 snapshot의 delete 404를 같은 key에서 최초 body와 X-Request-Id로 재생한다', async () => {
    const { ns, base, id } = await restoreFixture('snapshot-delete-404-replay');
    await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(200);
    for (const target of [id, randomUUID()]) {
      const key = randomUUID();
      const first = await snapshotPost(base, `/${target}/delete`, key, '{}').expect(404);
      expect(first.body.code).toBe('VFS_SNAPSHOT_NOT_FOUND');
      expect(
        await ctx.migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneBy({ namespaceId: ns, scope, idempotencyKey: key }),
      ).toMatchObject({ state: 'COMPLETE', responseStatus: 404 });
      const replay = await snapshotPost(base, `/${target}/delete`, key, '{}').expect(404);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    }
  });

  it('암호화 FILE의 원본 삭제 뒤 전체/Range 읽기도 원본 bytes를 반환한다', async () => {
    const nsResponse = await request(ctx.httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'snapshot-encrypted-ns')
      .send({ name: 'snapshot-encrypted', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const ns = nsResponse.body.id as string;
    const base = `/api/v2/namespaces/${ns}/fs`;
    const bytes = Buffer.from(Array.from({ length: 80 }, (_, i) => i * 3));
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/secret' })
      .set('Content-Type', 'application/octet-stream')
      .send(bytes)
      .expect(201);
    const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/secret"}').expect(
      201,
    );
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/secret' }).expect(204);
    const content = `${base}/snapshots/${captured.body.snapshotId}/content`;
    expect((await request(ctx.httpServer).get(content).expect(200)).body).toEqual(bytes);
    expect((await request(ctx.httpServer).get(content).set('Range', 'bytes=13-47').expect(206)).body).toEqual(
      bytes.subarray(13, 48),
    );
  });

  it('receipt 실패 시 metadata/ref/usage를 롤백하고 같은 key로 재시도한다', async () => {
    const ns = await ctx.createNamespace('snapshot-atomic-receipt');
    const base = `/api/v2/namespaces/${ns}/fs`;
    await request(ctx.httpServer).post(`${base}/touch`).send({ path: '/a' }).expect(201);
    const ds = ctx.app.get(DataSource);
    const key = randomUUID();
    const raw = '{"kind":"file","path":"/a"}';
    const failure = jest
      .spyOn(ctx.app.get(VfsMutationReceiptRepository), 'complete')
      .mockRejectedValueOnce(new Error('injected snapshot receipt failure'));
    try {
      await snapshotPost(base, '', key, raw).expect(500);
    } finally {
      failure.mockRestore();
    }
    expect(await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(0);
    expect(await ds.getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId: ns })).toBe(0);
    expect((await ds.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns })).referenceCount).toBe(1);
    expect(
      (await ds.getRepository(NamespaceEntity).findOneByOrFail({ id: ns })).retainedSnapshotNodeCount,
    ).toBe(0);
    expect(await ds.getRepository(VfsMutationReceiptEntity).countBy({ namespaceId: ns })).toBe(0);
    const snapshot = await snapshotPost(base, '', key, raw).expect(201);
    const deletionKey = randomUUID();
    const deleteFailure = jest
      .spyOn(ctx.app.get(VfsMutationReceiptRepository), 'complete')
      .mockRejectedValueOnce(new Error('injected snapshot delete failure'));
    try {
      await snapshotPost(base, `/${snapshot.body.snapshotId}/delete`, deletionKey, '{}').expect(500);
    } finally {
      deleteFailure.mockRestore();
    }
    expect(await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(1);
    expect((await ds.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns })).referenceCount).toBe(2);
    await snapshotPost(base, `/${snapshot.body.snapshotId}/delete`, deletionKey, '{}').expect(200);
  });

  it('work 412의 오류 receipt fencing이 실패하면 500이고 receipt를 남기지 않아 같은 key 재시도가 재평가된다', async () => {
    const { ns, base, id } = await restoreFixture('snapshot-error-receipt-fence');
    const key = randomUUID();
    const raw = '{"path":"/source","ifAbsent":true}';
    // restore work가 412를 던지고 롤백된 뒤 별도 트랜잭션의 오류 receipt 저장이 claim lost로 실패한다.
    const fenced = jest
      .spyOn(ctx.app.get(VfsMutationReceiptRepository), 'completeAfterRollback')
      .mockRejectedValueOnce(new Error('VFS mutation claim lost'));
    try {
      await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
      expect(fenced).toHaveBeenCalledTimes(1);
    } finally {
      fenced.mockRestore();
    }
    expect(
      await ctx.migrationDataSource
        .getRepository(VfsMutationReceiptEntity)
        .findOneBy({ namespaceId: ns, scope, idempotencyKey: key }),
    ).toBeNull();
    // 412가 저장되지 않았으므로 원본을 지운 뒤 같은 key 재시도는 새로 평가되어 복원된다.
    await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
    const retried = await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
    expect(retried.body.resource.path).toBe('/source');
  });

  it('한도 초과 413을 완료 receipt로 재생하며 원본 종류와 ID를 검증한다', async () => {
    const ns = await ctx.createNamespace('snapshot-file-errors');
    const base = `/api/v2/namespaces/${ns}/fs`;
    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path: '/a' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('ab'))
      .expect(201);
    await ctx.migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxSnapshotBytes: '1' });
    const root = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
    const key = randomUUID();
    const raw = '{"kind":"file","path":"/a"}';
    const limited = await snapshotPost(base, '', key, raw).expect(413);
    expect(limited.body.code).toBe('VFS_SNAPSHOT_LIMIT_EXCEEDED');
    expect(await ctx.app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(
      0,
    );
    expect(
      (await ctx.migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns }))
        .referenceCount,
    ).toBe(1);
    expect(
      (await ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version,
    ).toBe(root.version);
    expect(
      String(
        (await ctx.migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns }))
          .retainedSnapshotByteCount,
      ),
    ).toBe('0');
    await ctx.migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxSnapshotBytes: null });
    const replayed = await snapshotPost(base, '', key, raw).expect(413);
    expect(replayed.body).toEqual(limited.body);
    expect(replayed.headers['x-request-id']).toBe(limited.headers['x-request-id']);
    expect(await ctx.app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(
      0,
    );
    const snapshot = await snapshotPost(base, '', randomUUID(), raw).expect(201);
    await request(ctx.httpServer)
      .get(`${base}/snapshots/${snapshot.body.snapshotId}/content`)
      .query({ path: ['a', 'b'] })
      .expect(400);
    await request(ctx.httpServer).get(`${base}/snapshots/not-a-uuid`).expect(404);
    await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    expect(
      (await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/dir"}').expect(409)).body.code,
    ).toBe('VFS_IS_DIRECTORY');
    await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/missing"}').expect(404);
  });

  it('빈 본문과 잘못된 JSON의 400을 원래 request ID로 재생한다', async () => {
    const ns = await ctx.createNamespace('snapshot-invalid-json');
    const base = `/api/v2/namespaces/${ns}/fs`;
    for (const raw of ['', '{broken']) {
      const key = randomUUID();
      const first = await snapshotPost(base, '', key, raw).expect(400);
      expect(first.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
      const replay = await snapshotPost(base, '', key, raw).expect(400);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    }
  });

  it('진행 중 key는 Retry-After를 제공하고 key와 scope를 검증한다', async () => {
    const namespaceId = await ctx.createNamespace('snapshot-busy');
    const base = `/api/v2/namespaces/${namespaceId}/fs`;
    const key = randomUUID();
    await ctx.app.get(VfsMutationReceiptRepository).claim({ namespaceId, scope, key }, new Date());
    const busy = await snapshotPost(base, '', key, '{"kind":"file","path":"/a"}').expect(409);
    expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
    expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
    await snapshotPost(base, '', 'invalid', '{}').expect(400);
    await request(ctx.httpServer)
      .post(`${base}/snapshots`)
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'file', path: '/a' })
      .expect(400);
  });
}
