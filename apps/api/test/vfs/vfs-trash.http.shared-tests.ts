import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';

export function registerVfsTrashHttpContract(
  getApp: () => INestApplication,
  createNamespace: (name: string) => Promise<string>,
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
    const after = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id });
    expect([after.liveFileByteCount, after.retainedTrashByteCount, after.retainedTrashNodeCount])
      .toEqual([before.liveFileByteCount, before.retainedTrashByteCount, before.retainedTrashNodeCount]);
    expect(await ds.getRepository(VfsTrashEntity).countBy({ namespaceId: id })).toBe(2);
    } finally {
      if (previousLimit === undefined) delete process.env.STORIX_MAX_RETAINED_TRASH_NODES;
      else process.env.STORIX_MAX_RETAINED_TRASH_NODES = previousLimit;
    }
  });
}
