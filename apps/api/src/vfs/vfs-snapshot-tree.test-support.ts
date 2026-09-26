import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { decodeRevision } from './revision.js';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsSnapshotEntity } from '../persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../persistence/entities/vfs-snapshot-entry.entity.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import { GcJob } from '../jobs/gc.job.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';

export function snapshotPost(
  app: INestApplication,
  base: string,
  suffix: string,
  body: object,
  key = randomUUID(),
) {
  return request(app.getHttpServer())
    .post(`${base}/snapshots${suffix}`)
    .set('X-Mutation-Scope', 'tree-http')
    .set('Idempotency-Key', key)
    .send(body);
}

// 동일한 HTTP 계약을 PostgreSQL 및 SQLite의 실제 Blob adapter에서 실행한다.
export function treeSnapshotContract(getApp: () => INestApplication) {
  describe('TREE snapshot HTTP contract', () => {
    async function fixture(encrypted = false) {
      const app = getApp();
      const ns = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', randomUUID())
        .send({ name: randomUUID(), ...(encrypted ? { encryptionPolicy: 'ENCRYPTED' } : {}) })
        .expect(201);
      const base = `/api/v2/namespaces/${ns.body.id}/fs`;
      const http = () => request(app.getHttpServer());
      const upload = (path: string, bytes: Buffer) =>
        http()
          .post(`${base}/content`)
          .query({ path, force: true })
          .set('Content-Type', 'Application/Octet-Stream; ignored=yes')
          .send(bytes);
      return { app, http, base, namespaceId: ns.body.id as string, upload };
    }

    it('bounded recursive capture는 root와 정렬된 하위 경로를 반환하고 maxNodes+1에서 중단한다', async () => {
      const { app, http, base, namespaceId, upload } = await fixture();
      await http().post(`${base}/mkdir`).send({ path: '/a' }).expect(201);
      await upload('/z', Buffer.from('z')).expect(201);
      await upload('/a/x', Buffer.from('x')).expect(201);
      const nodes = app.get(VfsNodeRepository);
      const root = (await nodes.getRoot(namespaceId))!;
      await nodes.withMutation(namespaceId, root.id, async (tx) => {
        expect((await nodes.captureSnapshotRows(tx, [], 100)).map((row) => row.relativePath)).toEqual([
          '.',
          'a',
          'a/x',
          'z',
        ]);
        expect(await nodes.captureSnapshotRows(tx, [], 1)).toHaveLength(2);
      });
    });

    it('nested/root manifest와 revision, Unicode/prefix pagination은 원본의 혼합 변경 뒤에도 불변이다', async () => {
      const { app, http, base, upload } = await fixture();
      await http().post(`${base}/mkdir`).send({ path: '/tree/a', parents: true }).expect(201);
      const bytes = Buffer.from([0, 255, 128, 32, 65]);
      for (const path of ['A', 'a-', 'a/b', 'a0', 'e-', '\u00e9', '한', '😀']) {
        await upload(`/tree/${path}`, bytes).expect(201);
      }
      const source = (await http().get(`${base}/revision`).query({ path: '/tree' }).expect(200)).body;
      const captured = await snapshotPost(app, base, '', { kind: 'tree', path: '/tree//.' }).expect(201);
      const id = captured.body.snapshotId;
      expect(captured.body).toMatchObject({
        kind: 'tree',
        sourcePath: '/tree',
        sourceRevision: source.revision,
        rootNodeId: decodeRevision(source.revision).id,
        rootType: 'DIRECTORY',
        nodeCount: 10,
        logicalBytes: '40',
      });
      const initial = (await http().get(`${base}/snapshots/${id}/entries`).expect(200)).body;
      expect(Object.keys(initial).sort()).toEqual(['items', 'nextCursor']);
      expect(initial.nextCursor).toBeNull();
      expect(initial.items.map((x: { relativePath: string }) => x.relativePath)).toEqual([
        '.',
        'A',
        'a',
        'a-',
        'a/b',
        'a0',
        'e-',
        '\u00e9',
        '한',
        '😀',
      ]);
      expect(initial.items[0]).toMatchObject({
        type: 'DIRECTORY',
        sourceNodeId: decodeRevision(source.revision).id,
        sourceRevision: source.revision,
        size: null,
        mimeType: null,
        contentPath: null,
      });
      for (const item of initial.items) {
        const path = item.relativePath === '.' ? '/tree' : `/tree/${item.relativePath}`;
        const stat = (await http().get(`${base}/revision`).query({ path }).expect(200)).body;
        expect(item.sourceRevision).toBe(stat.revision);
        expect(item.sourceNodeId).toBe(decodeRevision(stat.revision).id);
        expect(item).not.toHaveProperty('blobId');
        expect(item).not.toHaveProperty('pathKey');
      }
      const root = await snapshotPost(app, base, '', { kind: 'tree', path: '/' }).expect(201);
      expect(root.body.nodeCount).toBe(11);
      expect(
        (await http().get(`${base}/snapshots/${root.body.snapshotId}/entries`).expect(200)).body.items[0]
          .relativePath,
      ).toBe('.');
      const first = (await http().get(`${base}/snapshots/${id}/entries`).query({ limit: 3 }).expect(200))
        .body;
      expect(first.items).toEqual(initial.items.slice(0, 3));
      expect(first.nextCursor).toMatch(/^sc1\./);
      await http()
        .post(`${base}/mv`)
        .send({ source: '/tree/a', destination: '/tree/renamed-dir' })
        .expect(200);
      await http().post(`${base}/mv`).send({ source: '/tree/A', destination: '/renamed-file' }).expect(200);
      await http().post(`${base}/rm`).query({ path: '/tree/a-' }).expect(204);
      await upload('/tree/a0', Buffer.from('new')).expect(200);
      await upload('/tree/new', Buffer.from('created')).expect(201);
      const items = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = (
          await http().get(`${base}/snapshots/${id}/entries`).query({ limit: 3, cursor }).expect(200)
        ).body;
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(items).toEqual(initial.items);
      expect((await http().get(`${base}/snapshots/${id}`).expect(200)).body).toEqual(captured.body);
      const file = items.find((item) => item.relativePath === 'a/b');
      expect(file.contentPath).toContain('/api/v2/namespaces/');
      expect((await http().get(file.contentPath).expect(200)).body).toEqual(bytes);
      expect(
        (await http().get(`${base}/snapshots/${id}/entries`).query({ cursor: 'bad' }).expect(400)).body.code,
      ).toBe('VFS_INVALID_CURSOR');
      await http()
        .get(`${base}/snapshots/${root.body.snapshotId}/entries`)
        .query({ cursor: first.nextCursor })
        .expect(400);
      const foreign = await fixture();
      await foreign.http().get(`${foreign.base}/snapshots/${id}/entries`).expect(404);
      await foreign.http().get(`${foreign.base}/snapshots/${id}/content`).query({ path: 'a/b' }).expect(404);
      await snapshotPost(app, base, `/${id}/restore`, { path: '/restore', ifAbsent: true }).expect(404);
      await snapshotPost(app, base, `/${id}/delete`, {}).expect(200);
      await http().get(`${base}/snapshots/${id}/entries`).expect(404);
    });

    it('원본과 snapshot을 모두 삭제한 뒤 grace period가 지나면 GC가 Blob row와 object를 회수한다', async () => {
      const { app, http, base, namespaceId, upload } = await fixture();
      const bytes = Buffer.from([0, 255, 128, 65]);
      await upload('/source', bytes).expect(201);
      const captured = await snapshotPost(app, base, '', { kind: 'file', path: '/source' }).expect(201);
      const ds = app.get(DataSource);
      const blobs = ds.getRepository(BlobEntity);
      const blob = await blobs.findOneByOrFail({ namespaceId });
      await http().post(`${base}/rm`).query({ path: '/source' }).expect(204);
      expect((await blobs.findOneByOrFail({ id: blob.id })).referenceCount).toBe(1);
      const gc = new GcJob(
        app.get<BlobStorage>(BLOB_STORAGE),
        app.get(BlobRepository),
        app.get(ConfigService),
      );
      await gc.run();
      expect(await blobs.findOneBy({ id: blob.id })).not.toBeNull();
      expect(
        (await http().get(`${base}/snapshots/${captured.body.snapshotId}/content`).expect(200)).body,
      ).toEqual(bytes);

      await snapshotPost(app, base, `/${captured.body.snapshotId}/delete`, {}).expect(200);
      expect((await blobs.findOneByOrFail({ id: blob.id })).referenceCount).toBe(0);
      await blobs.update(blob.id, { zeroSince: new Date(Date.now() - 2 * 86400_000) });
      await gc.run();
      expect(await blobs.findOneBy({ id: blob.id })).toBeNull();
      await expect(app.get<BlobStorage>(BLOB_STORAGE).get(blob.storageKey)).rejects.toThrow();
    });

    it.each([false, true])(
      'TREE 경로는 한 번만 decode하며 정확한 binary 및 Range bytes를 반환한다 (encrypted=%s)',
      async (encrypted) => {
        const { app, http, base, upload } = await fixture(encrypted);
        await http().post(`${base}/mkdir`).send({ path: '/dir/a', parents: true }).expect(201);
        const bytes = Buffer.from([0, 255, 128, 65, 66, 67]);
        for (const path of ['a/b', '%2e%2e', 'a%2Fb', '\u00e9'])
          await upload(`/dir/${path}`, bytes).expect(201);
        const file = await snapshotPost(app, base, '', { kind: 'file', path: '/dir/a/b' }).expect(201);
        await http().get(`${base}/snapshots/${file.body.snapshotId}/entries`).expect(409);
        await snapshotPost(app, base, '', { kind: 'tree', path: '/dir/a/b' }).expect(409);
        const captured = await snapshotPost(app, base, '', { kind: 'tree', path: '/dir' }).expect(201);
        const url = `${base}/snapshots/${captured.body.snapshotId}/content`;
        await upload('/dir/a/b', Buffer.from('changed')).expect(200);
        for (const path of ['a/b', 'a//./b', '%2e%2e', 'a%2Fb', '\u00e9']) {
          const response = await http().get(url).query({ path }).expect(200);
          expect(response.body).toEqual(bytes);
          expect(response.headers['content-type']).toBe('application/octet-stream');
        }
        expect((await http().get(`${url}?path=a%2Fb`).expect(200)).body).toEqual(bytes);
        const range = await http().get(url).query({ path: 'a/b' }).set('Range', 'bytes=1-3').expect(206);
        expect(range.body).toEqual(Buffer.from([255, 128, 65]));
        expect(range.headers['content-range']).toBe('bytes 1-3/6');
        await http().get(url).query({ path: 'a/b' }).set('Range', 'bytes=99-').expect(416);
        await http().get(url).expect(400);
        for (const path of ['', '.', '././', 'a'])
          expect((await http().get(url).query({ path }).expect(409)).body.code).toBe('VFS_IS_DIRECTORY');
        for (const path of ['/a/b', '..', 'a/../b', 'a\\b', 'a\u0000b', 'a\u007fb'])
          await http().get(url).query({ path }).expect(400);
        await http().get(`${url}?path=%2e%2e%2fb`).expect(400);
        await http().get(`${url}?path=a&path=b`).expect(400);
        await http().get(`${url}?path[x]=a`).expect(400);
        expect((await http().get(url).query({ path: 'missing' }).expect(404)).body.code).toBe(
          'VFS_NODE_NOT_FOUND',
        );
        expect((await http().get(url).query({ path: 'e\u0301' }).expect(400)).body.code).toBe(
          'VFS_INVALID_PATH',
        );
      },
    );

    it('TREE node/byte 및 retained 상한 실패는 metadata/entry/refcount/usage를 남기지 않는다', async () => {
      const { app, http, base, upload, namespaceId } = await fixture();
      await http().post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      await upload('/dir/a', Buffer.from('123')).expect(201);
      await upload('/dir/b', Buffer.from('456')).expect(201);
      const ds = app.get(DataSource);
      const namespaces = ds.getRepository(NamespaceEntity);
      for (const overrides of [
        { maxSyncSnapshotNodes: 2 },
        { maxSnapshotBytes: '5' },
        { maxRetainedSnapshotNodes: 2 },
        { maxRetainedSnapshotBytes: '5' },
      ]) {
        await namespaces.update(namespaceId, {
          maxSyncSnapshotNodes: null,
          maxSnapshotBytes: null,
          maxRetainedSnapshotNodes: null,
          maxRetainedSnapshotBytes: null,
          ...overrides,
        });
        expect(
          (await snapshotPost(app, base, '', { kind: 'tree', path: '/dir' }).expect(413)).body.code,
        ).toBe('VFS_SNAPSHOT_LIMIT_EXCEEDED');
        expect(await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId })).toBe(0);
        expect(await ds.getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId })).toBe(0);
        expect(
          (await ds.getRepository(BlobEntity).findBy({ namespaceId })).map((b) => b.referenceCount),
        ).toEqual([1, 1]);
        const ns = await namespaces.findOneByOrFail({ id: namespaceId });
        expect(ns.retainedSnapshotNodeCount).toBe(0);
        expect(String(ns.retainedSnapshotByteCount)).toBe('0');
      }
    });
  });
}
