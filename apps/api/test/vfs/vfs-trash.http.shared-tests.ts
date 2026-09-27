import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';

export function registerVfsTrashHttpContract(
  getApp: () => INestApplication,
  createNamespace: (name: string) => Promise<string>,
  restartApp: () => Promise<void>,
) {
  const http = () => request(getApp().getHttpServer());
  const namespace = (id: string) => `/api/v2/namespaces/${id}/fs`;

  it('FILE 삭제는 원본 revision·Blob을 보존하고 receipt 재생과 같은 경로 재생성을 지원한다', async () => {
    const id = await createNamespace(`trash-file-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/content`).query({ path: '/doc' }).set('Content-Type', 'text/plain').send('hello').expect(201);
    const before = (await http().get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body;
    const snapshot = (await http().post(`${base}/snapshots`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({ kind: 'file', path: '/doc' }).expect(201)).body;
    const key = randomUUID();
    const command = { kind: 'delete', path: '/doc', ifRevision: before.revision };
    const first = await http().post(`${base}/mutations`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', key).send(command).expect(200);
    expect(first.body.trashId).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await http().post(`${base}/mutations`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', key).send(command).expect(200);
    expect(replay.body).toEqual(first.body);
    await http().get(`${base}/stat`).query({ path: '/doc' }).expect(404);
    const created = await http().post(`${base}/content`).query({ path: '/doc' })
      .set('Content-Type', 'text/plain').send('new').expect(201);
    expect(created.body.id).not.toBe(before.id);
    expect((await http().get(`${base}/snapshots/${snapshot.snapshotId}/content`).expect(200)).text).toBe('hello');

    const ds = getApp().get(DataSource);
    const trash = await ds.getRepository(VfsTrashEntity).findOneByOrFail({ id: first.body.trashId, namespaceId: id });
    const entry = await ds.getRepository(VfsTrashEntryEntity).findOneByOrFail({ trashId: trash.id, relativePath: '.' });
    const blob = await ds.getRepository(BlobEntity).findOneByOrFail({ id: entry.blobId! });
    expect([trash.originalPath, trash.rootNodeId, trash.rootRevision, String(trash.nodeCount), String(trash.logicalBytes)])
      .toEqual(['/doc', before.id, before.revision, '1', '5']);
    expect([entry.sourceNodeId, entry.sourceRevision, String(entry.size), entry.mimeType, blob.referenceCount])
      .toEqual([before.id, before.revision, '5', 'text/plain', 2]);
    const counters = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
    expect([String(counters.liveFileByteCount), String(counters.retainedTrashByteCount), String(counters.retainedTrashNodeCount)])
      .toEqual(['3', '5', '1']);
    const published = (await http().get(`/api/v2/namespaces/${id}`).expect(200)).body;
    expect(published.quota).toMatchObject({
      usedBytes: '13', trash: { retainedNodeCount: 1, maxRetainedNodes: 100000 },
    });
  });

  it('TREE 삭제는 subtree manifest와 keyset 목록을 만들고 노드 한도 초과를 원자적으로 거절한다', async () => {
    const previousLimit = process.env.STORIX_MAX_RETAINED_TRASH_NODES;
    process.env.STORIX_MAX_RETAINED_TRASH_NODES = '3';
    try {
    const id = await createNamespace(`trash-tree-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    await http().post(`${base}/content`).query({ path: '/dir/a' }).set('Content-Type', 'text/plain').send('ab').expect(201);
    const original = (await http().get(`${base}/stat`).query({ path: '/dir/a' }).expect(200)).body;
    const deleted = await http().post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204);
    const trashId = deleted.headers['x-trash-id'];
    expect(trashId).toMatch(/^[0-9a-f-]{36}$/);
    await http().get(`${base}/stat`).query({ path: '/dir/a' }).expect(404);
    const ds = getApp().get(DataSource);
    const entries = await ds.getRepository(VfsTrashEntryEntity).findBy({ trashId });
    expect(entries.map((item) => [item.relativePath, item.type]).sort())
      .toEqual([['.', 'DIRECTORY'], ['a', 'FILE']]);
    expect(entries.find((item) => item.relativePath === 'a')?.sourceRevision).toBe(original.revision);
    expect(await ds.getRepository(VfsNodeEntity).countBy({ namespaceId: id, id: original.id })).toBe(0);

    await http().post(`${base}/mkdir`).send({ path: '/empty' }).expect(201);
    const empty = await http().post(`${base}/rmdir`).query({ path: '/empty' }).expect(204);
    expect(empty.headers['x-trash-id']).toMatch(/^[0-9a-f-]{36}$/);
    const page = (await http().get(`${base}/trash`).query({ limit: 1 }).expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = (await http().get(`${base}/trash`).query({ limit: 1, cursor: page.nextCursor }).expect(200)).body;
    expect([...page.items, ...next.items].map((item: { trashId: string }) => item.trashId).sort())
      .toEqual([trashId, empty.headers['x-trash-id']].sort());
    expect((await http().get(`${base}/trash`).query({ cursor: `${page.nextCursor}x` }).expect(400)).body.code)
      .toBe('VFS_INVALID_CURSOR');
    await http().post(`${base}/touch`).send({ path: '/limit' }).expect(201);
    const before = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
    const failed = await http().post(`${base}/rm`).query({ path: '/limit' }).expect(413);
    expect(failed.body.code).toBe('VFS_TRASH_LIMIT_EXCEEDED');
    await http().get(`${base}/stat`).query({ path: '/limit' }).expect(200);
    await http().post(`${base}/mkdir`).send({ path: '/empty-again' }).expect(201);
    const rmdirFailed = await http().post(`${base}/rmdir`).query({ path: '/empty-again' }).expect(413);
    expect(rmdirFailed.body.code).toBe('VFS_TRASH_LIMIT_EXCEEDED');
    await http().get(`${base}/stat`).query({ path: '/empty-again' }).expect(200);
    const after = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
    expect([after.liveFileByteCount, after.retainedTrashByteCount, after.retainedTrashNodeCount])
      .toEqual([before.liveFileByteCount, before.retainedTrashByteCount, before.retainedTrashNodeCount]);
    expect(await ds.getRepository(VfsTrashEntity).countBy({ namespaceId: id })).toBe(2);
    } finally {
      if (previousLimit === undefined) delete process.env.STORIX_MAX_RETAINED_TRASH_NODES;
      else process.env.STORIX_MAX_RETAINED_TRASH_NODES = previousLimit;
    }
  });

  it('FILE을 원래 ID와 새 revision으로 복원하고 snapshot 및 receipt를 보존한다', async () => {
    const id = await createNamespace(`trash-restore-file-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/content`).query({ path: '/doc' }).set('Content-Type', 'text/plain')
      .send('original').expect(201);
    const before = (await http().get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body;
    const snapshot = (await http().post(`${base}/snapshots`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({ kind: 'file', path: '/doc' }).expect(201)).body;
    const trashId = (await http().post(`${base}/rm`).query({ path: '/doc' }).expect(204))
      .headers['x-trash-id'] as string;
    const key = randomUUID();
    const route = `${base}/trash/${trashId}/restore`;
    const first = await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', key).send({}).expect(200);
    expect(first.body.trashId).toBe(trashId);
    expect(first.body.resource).toMatchObject({ id: before.id, path: '/doc', size: 8, mimeType: 'text/plain' });
    expect(first.body.resource.revision).not.toBe(before.revision);
    await restartApp();
    expect((await http().get(`${base}/content`).query({ path: '/doc' }).expect(200)).text).toBe('original');
    expect((await http().get(`${base}/snapshots/${snapshot.snapshotId}/content`).expect(200)).text).toBe('original');
    expect((await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', key).send({}).expect(200)).body).toEqual(first.body);
    expect((await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({}).expect(404)).body.code)
      .toBe('VFS_TRASH_ITEM_NOT_FOUND');
    const counters = await getApp().get(DataSource).getRepository(NamespaceEntity).findOneByOrFail({ id });
    expect([String(counters.liveFileByteCount), String(counters.retainedTrashByteCount), String(counters.retainedTrashNodeCount)])
      .toEqual(['8', '0', '0']);
  });

  it('TREE를 대체 경로에 복원하고 목적지 충돌 및 부모 부재를 거절한다', async () => {
    const id = await createNamespace(`trash-restore-tree-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    await http().post(`${base}/content`).query({ path: '/dir/a' }).set('Content-Type', 'text/plain')
      .send('a').expect(201);
    const root = (await http().get(`${base}/stat`).query({ path: '/dir' }).expect(200)).body;
    const child = (await http().get(`${base}/stat`).query({ path: '/dir/a' }).expect(200)).body;
    const trashId = (await http().post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204))
      .headers['x-trash-id'] as string;
    const route = `${base}/trash/${trashId}/restore`;
    const missing = await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({ targetPath: '/missing/dir' }).expect(404);
    expect(missing.body.code).toBe('VFS_NODE_NOT_FOUND');
    await http().post(`${base}/touch`).send({ path: '/dir' }).expect(201);
    const occupied = await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({}).expect(412);
    expect(occupied.body.code).toBe('VFS_PRECONDITION_FAILED');
    await http().post(`${base}/mkdir`).send({ path: '/other' }).expect(201);
    const restored = await http().post(route).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({ targetPath: '/other/dir' }).expect(200);
    expect(restored.body.resource).toMatchObject({ id: root.id, path: '/other/dir', type: 'DIRECTORY' });
    expect(restored.body.resource.revision).not.toBe(root.revision);
    const after = (await http().get(`${base}/stat`).query({ path: '/other/dir/a' }).expect(200)).body;
    expect(after.id).toBe(child.id);
    expect(after.revision).not.toBe(child.revision);
    expect((await http().get(`${base}/content`).query({ path: '/other/dir/a' }).expect(200)).text).toBe('a');
  });

  it('TREE root보다 먼저 정렬되는 자식 이름도 원래 ID와 구조로 복원한다', async () => {
    const id = await createNamespace(`trash-root-order-${randomUUID()}`);
    const base = namespace(id);
    for (const path of ['/dir', '/dir/nested']) await http().post(`${base}/mkdir`).send({ path }).expect(201);
    const paths = ['/dir', '/dir/_foo', '/dir/-foo', '/dir/nested', '/dir/nested/child'];
    for (const path of paths.filter((item) => !['/dir', '/dir/nested'].includes(item)))
      await http().post(`${base}/touch`).send({ path }).expect(201);
    const before = await Promise.all(paths.map(async (path) =>
      (await http().get(`${base}/stat`).query({ path }).expect(200)).body.id as string));
    const trashId = (await http().post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204))
      .headers['x-trash-id'] as string;
    await http().post(`${base}/trash/${trashId}/restore`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({}).expect(200);
    const after = await Promise.all(paths.map(async (path) =>
      (await http().get(`${base}/stat`).query({ path }).expect(200)).body.id as string));
    expect(after).toEqual(before);
  });

  it('불가능한 달력 날짜 cursor를 SQL 실행 전에 400으로 거절한다', async () => {
    const id = await createNamespace(`trash-invalid-date-${randomUUID()}`);
    const base = namespace(id);
    const cursor = `tr1.${Buffer.from(JSON.stringify({
      namespaceId: id, deletedAtKey: '2026-02-31T00:00:00.123456Z',
      trashId: randomUUID(), order: 'deletedAtDescTrashIdAsc',
    })).toString('base64url')}`;
    const response = await http().get(`${base}/trash`).query({ cursor }).expect(400);
    expect(response.body.code).toBe('VFS_INVALID_CURSOR');
  });

  it('PostgreSQL이 지원하지 않는 0000년 cursor를 SQL 실행 전에 400으로 거절한다', async () => {
    const id = await createNamespace(`trash-year-zero-${randomUUID()}`);
    const base = namespace(id);
    const cursor = `tr1.${Buffer.from(JSON.stringify({
      namespaceId: id, deletedAtKey: '0000-01-01T00:00:00.123456Z',
      trashId: randomUUID(), order: 'deletedAtDescTrashIdAsc',
    })).toString('base64url')}`;
    const response = await http().get(`${base}/trash`).query({ cursor }).expect(400);
    expect(response.body.code).toBe('VFS_INVALID_CURSOR');
  });

  it('안전 정수 경계의 휴지통 metadata를 목록과 복구 및 quota 응답에서 정확히 유지한다', async () => {
    const id = await createNamespace(`trash-bigint-restore-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    for (const name of ['a', 'b'])
      await http().post(`${base}/content`).query({ path: `/dir/${name}` })
        .set('Content-Type', 'text/plain').send(name).expect(201);
    const trashId = (await http().post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204))
      .headers['x-trash-id'] as string;
    const ds = getApp().get(DataSource);
    await ds.getRepository(VfsTrashEntryEntity).update({ trashId, relativePath: 'a' }, { size: '4503599627370496' });
    await ds.getRepository(VfsTrashEntryEntity).update({ trashId, relativePath: 'b' }, { size: '4503599627370497' });
    await ds.getRepository(VfsTrashEntity).update({ id: trashId }, { logicalBytes: '9007199254740993' });
    await ds.getRepository(NamespaceEntity).update({ id }, { retainedTrashByteCount: '9007199254740993' });

    const listed = (await http().get(`${base}/trash`).expect(200)).body;
    expect(listed.items.find((item: { trashId: string }) => item.trashId === trashId).logicalBytes)
      .toBe('9007199254740993');
    expect((await http().get(`/api/v2/namespaces/${id}`).expect(200)).body.quota.usedBytes)
      .toBe('9007199254740993');
    const namespaces = (await http().get('/api/v2/namespaces').expect(200)).body;
    expect(namespaces.find((item: { id: string }) => item.id === id).quota.usedBytes)
      .toBe('9007199254740993');
    const previousAdminKey = process.env.STORIX_ADMIN_API_KEY;
    process.env.STORIX_ADMIN_API_KEY = 'trash-admin-test-key';
    try {
      const updated = await http().patch(`/api/v2/admin/namespaces/${id}/quota`)
        .set('Authorization', 'Bearer trash-admin-test-key').set('Idempotency-Key', randomUUID())
        .send({ maxTotalLogicalBytes: '53687091200' }).expect(200);
      expect(updated.body.quota.usedBytes).toBe('9007199254740993');
    } finally {
      if (previousAdminKey === undefined) delete process.env.STORIX_ADMIN_API_KEY;
      else process.env.STORIX_ADMIN_API_KEY = previousAdminKey;
    }
    await http().post(`${base}/trash/${trashId}/restore`).set('X-Mutation-Scope', 'trash-test')
      .set('Idempotency-Key', randomUUID()).send({}).expect(200);
    const counters = await ds.getRepository(NamespaceEntity).createQueryBuilder('n')
      .select('CAST(n.live_file_byte_count AS TEXT)', 'live')
      .addSelect('CAST(n.retained_trash_byte_count AS TEXT)', 'trash')
      .where('n.id = :id', { id }).getRawOne<{ live: string; trash: string }>();
    expect([counters?.live, counters?.trash])
      .toEqual(['9007199254740993', '0']);
    expect((await http().get(`/api/v2/namespaces/${id}`).expect(200)).body.quota.usedBytes)
      .toBe('9007199254740993');
  });

  it('안전 정수 경계의 휴지통 metadata를 purge할 때 정확히 감산한다', async () => {
    const id = await createNamespace(`trash-bigint-purge-${randomUUID()}`);
    const base = namespace(id);
    await http().post(`${base}/content`).query({ path: '/doc' })
      .set('Content-Type', 'text/plain').send('x').expect(201);
    const trashId = (await http().post(`${base}/rm`).query({ path: '/doc' }).expect(204))
      .headers['x-trash-id'] as string;
    const ds = getApp().get(DataSource);
    await ds.getRepository(VfsTrashEntryEntity).update({ trashId }, { size: '9007199254740993' });
    await ds.getRepository(VfsTrashEntity).update({ id: trashId }, { logicalBytes: '9007199254740993' });
    await ds.getRepository(NamespaceEntity).update({ id }, { retainedTrashByteCount: '9007199254740993' });
    const previous = process.env.STORIX_ADMIN_API_KEY;
    process.env.STORIX_ADMIN_API_KEY = 'trash-admin-test-key';
    try {
      await http().post(`${base}/trash/${trashId}/purge`).set('Authorization', 'Bearer trash-admin-test-key')
        .set('X-Mutation-Scope', 'trash-test').set('Idempotency-Key', randomUUID()).send({}).expect(200);
      const counters = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
      expect([String(counters.liveFileByteCount), String(counters.retainedTrashByteCount)])
        .toEqual(['0', '0']);
    } finally {
      if (previous === undefined) delete process.env.STORIX_ADMIN_API_KEY;
      else process.env.STORIX_ADMIN_API_KEY = previous;
    }
  });

  it('휴지통 counter가 quota 경계에 있으면 1바이트 초과 쓰기를 거절한다', async () => {
    const previous = process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES;
    process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES = '9007199254740993';
    try {
      await restartApp();
      const id = await createNamespace(`trash-bigint-quota-${randomUUID()}`);
      const base = namespace(id);
      const ds = getApp().get(DataSource);
      await ds.getRepository(NamespaceEntity).update({ id }, { retainedTrashByteCount: '9007199254740993' });
      const rejected = await http().post(`${base}/content`).query({ path: '/one' })
        .set('Content-Type', 'text/plain').send('x').expect(413);
      expect(rejected.body.code).toBe('VFS_QUOTA_EXCEEDED');
      await http().get(`${base}/stat`).query({ path: '/one' }).expect(404);
    } finally {
      if (previous === undefined) delete process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES;
      else process.env.STORIX_MAX_TOTAL_LOGICAL_BYTES = previous;
      await restartApp();
    }
  });

  it('만료 item 복원은 410이고 관리자 purge는 Blob 공유를 보존하며 receipt를 재생한다', async () => {
    const id = await createNamespace(`trash-purge-${randomUUID()}`);
    const base = namespace(id);
    const nodes = getApp().get(VfsNodeRepository);
    const root = await nodes.getRoot(id);
    await nodes.createChangeFeedCheckpoint(id, root!.id);
    const previous = process.env.STORIX_ADMIN_API_KEY;
    process.env.STORIX_ADMIN_API_KEY = 'trash-admin-test-key';
    try {
      await http().post(`${base}/content`).query({ path: '/doc' }).set('Content-Type', 'text/plain')
        .send('shared').expect(201);
      const snapshot = (await http().post(`${base}/snapshots`).set('X-Mutation-Scope', 'trash-test')
        .set('Idempotency-Key', randomUUID()).send({ kind: 'file', path: '/doc' }).expect(201)).body;
      const trashId = (await http().post(`${base}/rm`).query({ path: '/doc' }).expect(204))
        .headers['x-trash-id'] as string;
      const ds = getApp().get(DataSource);
      await ds.getRepository(VfsTrashEntity).update({ id: trashId }, {
        deletedAt: new Date(Date.now() - 2 * 86400000), expiresAt: new Date(Date.now() - 86400000),
      });
      expect((await http().post(`${base}/trash/${trashId}/restore`).set('X-Mutation-Scope', 'trash-test')
        .set('Idempotency-Key', randomUUID()).send({}).expect(410)).body.code).toBe('VFS_TRASH_ITEM_EXPIRED');
      const route = `${base}/trash/${trashId}/purge`;
      await http().post(route).set('Authorization', 'Bearer ordinary-key').set('X-Mutation-Scope', 'trash-test')
        .set('Idempotency-Key', randomUUID()).send({}).expect(401);
      const feedBeforePurge = await nodes.listChangeFeedEvents(id, '0', 100);
      const key = randomUUID();
      const first = await http().post(route).set('Authorization', 'Bearer trash-admin-test-key')
        .set('X-Mutation-Scope', 'trash-test').set('Idempotency-Key', key).send({}).expect(200);
      expect(first.body).toEqual({ trashId, purged: true });
      expect((await http().post(route).set('Authorization', 'Bearer trash-admin-test-key')
        .set('X-Mutation-Scope', 'trash-test').set('Idempotency-Key', key).send({}).expect(200)).body)
        .toEqual(first.body);
      expect((await http().post(route).set('Authorization', 'Bearer trash-admin-test-key')
        .set('X-Mutation-Scope', 'trash-test').set('Idempotency-Key', key)
        .send({ different: true }).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      expect(await ds.getRepository(VfsTrashEntity).countBy({ id: trashId })).toBe(0);
      const blob = await ds.getRepository(BlobEntity).findOneByOrFail({ namespaceId: id });
      expect(blob.referenceCount).toBe(1);
      expect(await nodes.listChangeFeedEvents(id, '0', 100)).toEqual(feedBeforePurge);
      expect((await http().get(`${base}/snapshots/${snapshot.snapshotId}/content`).expect(200)).text).toBe('shared');
    } finally {
      if (previous === undefined) delete process.env.STORIX_ADMIN_API_KEY;
      else process.env.STORIX_ADMIN_API_KEY = previous;
    }
  });

  it('같은 item 복원 경쟁은 한 번만 소비하고 feed에는 삭제·생성만 남긴다', async () => {
    const id = await createNamespace(`trash-race-${randomUUID()}`);
    const base = namespace(id);
    const nodes = getApp().get(VfsNodeRepository);
    const root = await nodes.getRoot(id);
    await nodes.createChangeFeedCheckpoint(id, root!.id);
    await http().post(`${base}/content`).query({ path: '/race' }).set('Content-Type', 'text/plain')
      .send('race').expect(201);
    const trashId = (await http().post(`${base}/rm`).query({ path: '/race' }).expect(204))
      .headers['x-trash-id'] as string;
    const route = `${base}/trash/${trashId}/restore`;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const attempt = async () => {
      await barrier;
      return http().post(route).set('X-Mutation-Scope', 'trash-race')
        .set('Idempotency-Key', randomUUID()).send({});
    };
    const pair = [attempt(), attempt()];
    release();
    const outcomes = await Promise.all(pair);
    expect(outcomes.map((result) => result.status).sort()).toEqual([200, 404]);
    expect(outcomes.find((result) => result.status === 404)?.body.code).toBe('VFS_TRASH_ITEM_NOT_FOUND');
    const ds = getApp().get(DataSource);
    expect(await ds.getRepository(VfsNodeEntity).countBy({ namespaceId: id, name: 'race' })).toBe(1);
    expect(await ds.getRepository(VfsTrashEntity).countBy({ id: trashId })).toBe(0);
    const counters = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
    expect([String(counters.liveFileByteCount), String(counters.retainedTrashByteCount), String(counters.retainedTrashNodeCount)])
      .toEqual(['4', '0', '0']);
    const events = await nodes.listChangeFeedEvents(id, '0', 100);
    expect(events.filter((event) => event.path === '/race').map((event) => event.kind))
      .toEqual(['created', 'deleted', 'created']);
  });
}
