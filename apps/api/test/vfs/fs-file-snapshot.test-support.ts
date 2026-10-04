import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { createHash, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsSnapshotRepository } from '../../src/persistence/vfs-snapshot.repository.js';
import { decodeRevision, encodeRevision } from '../../src/vfs/revision.js';
import { withoutStatHash } from './fs-http-fixture.test-support.js';
import { registerFsFileSnapshotRestContract } from './fs-file-snapshot-rest.test-support.js';

export type SnapshotPost = (
  base: string,
  suffix: string,
  key: string,
  body: string,
) => ReturnType<ReturnType<typeof request>['post']>;

export function registerFsFileSnapshotContract(ctx: FsHttpContext) {
  describe('FILE snapshots', () => {
    const scope = 'snapshot-http';
    function snapshotPost(base: string, suffix: string, key: string, body: string) {
      return request(ctx.httpServer)
        .post(`${base}/snapshots${suffix}`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .send(body);
    }

    it('snapshot 생성의 분류된 DB 일시·영구 실패는 HTTP 코드와 receipt 비저장 계약을 지킨다', async () => {
      const namespaceId = await ctx.createNamespace('snapshot-storage-failure-http');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/source' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('snapshot source'))
        .expect(201);
      const repository = ctx.app.get(VfsSnapshotRepository);
      const receipts = ctx.migrationDataSource.getRepository(VfsMutationReceiptEntity);
      const snapshots = ctx.app.get(DataSource).getRepository(VfsSnapshotEntity);
      const body = '{"kind":"file","path":"/source"}';
      const transientKey = randomUUID();
      const transientSpy = jest.spyOn(repository, 'capture').mockRejectedValueOnce({
        driverError: { code: '08006', message: 'private database endpoint' },
      });
      try {
        const unavailable = await snapshotPost(base, '', transientKey, body).expect(503);
        expect(unavailable.body.code).toBe('STORAGE_UNAVAILABLE');
        expect(JSON.stringify(unavailable.body)).not.toContain('private database endpoint');
        expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: transientKey })).toBeNull();
        expect(await snapshots.countBy({ namespaceId })).toBe(0);
      } finally {
        transientSpy.mockRestore();
      }

      const created = await snapshotPost(base, '', transientKey, body).expect(201);
      const replay = await snapshotPost(base, '', transientKey, body).expect(201);
      expect(replay.body).toEqual(created.body);
      expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: transientKey })).toMatchObject({
        state: 'COMPLETE',
      });
      expect(await snapshots.countBy({ namespaceId })).toBe(1);

      const permanentKey = randomUUID();
      const permanentSpy = jest.spyOn(repository, 'capture').mockRejectedValueOnce({
        driverError: { code: '53100', message: 'private disk path' },
      });
      try {
        const failure = await snapshotPost(base, '', permanentKey, body).expect(500);
        expect(failure.body.code).toBe('STORAGE_FAILURE');
        expect(JSON.stringify(failure.body)).not.toContain('private disk path');
        expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: permanentKey })).toBeNull();
        expect(await snapshots.countBy({ namespaceId })).toBe(1);
      } finally {
        permanentSpy.mockRestore();
      }
    });

    it('파일별 목록은 node ID에 묶이고 cursor를 검증한다', async () => {
      const ns = await ctx.createNamespace('file-snapshot-list');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from('snapshot-list');
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      const source = (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      const captured = await snapshotPost(
        base,
        '',
        randomUUID(),
        JSON.stringify({ kind: 'file', path: '/a' }),
      ).expect(201);
      const page = (
        await request(ctx.httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      expect(page.items).toEqual([
        expect.objectContaining({
          snapshotId: captured.body.snapshotId,
          sourceRevision: captured.body.sourceRevision,
          logicalBytes: String(bytes.length),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      ]);
      expect(page.nextCursor).toBeNull();
      await request(ctx.httpServer)
        .post(`${base}/mv`)
        .send({ source: '/a', destination: '/moved' })
        .expect(200);
      const movedStat = (
        await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/moved' }).expect(200)
      ).body;
      expect(movedStat.id).toBe(source.id);
      const afterMove = (
        await request(ctx.httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      expect(afterMove.items).toEqual(page.items);

      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('replacement'))
        .expect(201);
      const replacement = (
        await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200)
      ).body;
      expect(replacement.id).not.toBe(source.id);
      const originalNodeSnapshots = (
        await request(ctx.httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      const replacementNodeSnapshots = (
        await request(ctx.httpServer)
          .get(`${base}/snapshots`)
          .query({ rootNodeId: replacement.id })
          .expect(200)
      ).body;
      expect(originalNodeSnapshots.items).toEqual(page.items);
      expect(replacementNodeSnapshots.items).toEqual([]);
      await request(ctx.httpServer)
        .get(`${base}/snapshots`)
        .query({ rootNodeId: randomUUID(), cursor: 'sl1.bogus' })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VFS_INVALID_CURSOR'));
      for (const createdAtKey of ['2026-02-30T01:02:03.123456Z', '0000-01-01T00:00:00.123456Z']) {
        const rootNodeId = randomUUID();
        const cursor = `sl1.${Buffer.from(
          JSON.stringify({ namespaceId: ns, rootNodeId, createdAtKey, snapshotId: randomUUID() }),
        ).toString('base64url')}`;
        await request(ctx.httpServer)
          .get(`${base}/snapshots`)
          .query({ rootNodeId, cursor })
          .expect(400)
          .expect(({ body }) => expect(body.code).toBe('VFS_INVALID_CURSOR'));
      }
      await request(ctx.httpServer)
        .get(`${base}/snapshots`)
        .query({ rootNodeId: 'bad' })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VFS_INVALID_MUTATION_REQUEST'));
    });

    it('PostgreSQL 앱 재시작 후 TREE/FILE bytes, cursor, restore와 완료 receipt를 유지한다', async () => {
      const ns = await ctx.createNamespace('snapshot-pg-restart');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from([0, 255, 128, 65]);
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/dir/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/dir/b' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('other'))
        .expect(201);
      const treeKey = randomUUID();
      const treeBody = '{"kind":"tree","path":"/dir"}';
      const tree = await snapshotPost(base, '', treeKey, treeBody).expect(201);
      const firstPage = (
        await request(ctx.httpServer)
          .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
          .query({ limit: 2 })
          .expect(200)
      ).body;
      const secondPage = (
        await request(ctx.httpServer)
          .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
          .query({ limit: 2, cursor: firstPage.nextCursor })
          .expect(200)
      ).body;
      const fileKey = randomUUID();
      const fileBody = '{"kind":"file","path":"/dir/a"}';
      const file = await snapshotPost(base, '', fileKey, fileBody).expect(201);
      const restoreKey = randomUUID();
      const restoreBody = '{"path":"/restored","ifAbsent":true}';
      const restored = await snapshotPost(
        base,
        `/${file.body.snapshotId}/restore`,
        restoreKey,
        restoreBody,
      ).expect(201);
      const disposable = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/dir/b"}').expect(
        201,
      );
      const deleteKey = randomUUID();
      const deleteSuffix = `/${disposable.body.snapshotId}/delete`;
      const deleted = await snapshotPost(base, deleteSuffix, deleteKey, '{}').expect(200);
      await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204);

      const oldDataSource = ctx.app.get(DataSource);
      await ctx.app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await ctx.bootstrap();
      expect(ctx.app.get(DataSource)).not.toBe(oldDataSource);
      expect(
        (await request(ctx.httpServer).get(`${base}/snapshots/${tree.body.snapshotId}`).expect(200)).body,
      ).toEqual(tree.body);
      expect(
        (await request(ctx.httpServer).get(`${base}/snapshots/${file.body.snapshotId}`).expect(200)).body,
      ).toEqual(file.body);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
            .query({ limit: 2 })
            .expect(200)
        ).body,
      ).toEqual(firstPage);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
            .query({ limit: 2, cursor: firstPage.nextCursor })
            .expect(200)
        ).body,
      ).toEqual(secondPage);
      for (const url of [
        `${base}/snapshots/${file.body.snapshotId}/content`,
        `${base}/snapshots/${tree.body.snapshotId}/content?path=a`,
        `${base}/content?path=/restored`,
      ])
        expect((await request(ctx.httpServer).get(url).expect(200)).body).toEqual(bytes);
      for (const [suffix, body, key, original] of [
        ['', treeBody, treeKey, tree],
        ['', fileBody, fileKey, file],
        [`/${file.body.snapshotId}/restore`, restoreBody, restoreKey, restored],
        [deleteSuffix, '{}', deleteKey, deleted],
      ] as const) {
        const replay = await snapshotPost(base, suffix, key, body).expect(original.status);
        expect(replay.body).toEqual(original.body);
        expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
      }
      await snapshotPost(
        base,
        `/${file.body.snapshotId}/restore`,
        randomUUID(),
        '{"path":"/after-restart","ifAbsent":true}',
      ).expect(201);
      const restartedContent = await request(ctx.httpServer)
        .get(`${base}/content`)
        .query({ path: '/after-restart' })
        .expect(200);
      const restartedStat = await request(ctx.httpServer)
        .get(`${base}/stat`)
        .query({ path: '/after-restart' })
        .expect(200);
      expect(restartedContent.body).toEqual(bytes);
      expect(restartedContent.headers['x-storix-file-id']).toBe(restartedStat.body.id);
      expect(restartedContent.headers['x-storix-revision']).toBe(restartedStat.body.revision);
      expect(restartedContent.headers['x-storix-sha256']).toBe(restartedStat.body.sha256);
      expect(restartedContent.headers['x-storix-sha256']).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      await request(ctx.httpServer).get(`${base}/snapshots/${disposable.body.snapshotId}`).expect(404);
    });

    it('조건부 JSON mutation과 raw upload receipt를 PostgreSQL 앱 재시작 후 재생한다', async () => {
      const ns = await ctx.createNamespace('conditional-mutation-pg-restart');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const jsonKey = randomUUID();
      const jsonBody = '{"kind":"mkdir","path":"/receipt-dir","ifAbsent":true}';
      const sendJson = () =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', jsonKey)
          .set('X-Mutation-Scope', 'restart-contract')
          .send(jsonBody);
      const jsonResult = await sendJson().expect(201);
      const uploadKey = randomUUID();
      const uploadBytes = Buffer.from([0, 255, 128, 65]);
      const sendUpload = () =>
        request(ctx.httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/receipt-dir/file.bin' })
          .set('Content-Type', 'application/octet-stream')
          .set('Idempotency-Key', uploadKey)
          .set('X-Mutation-Scope', 'restart-contract')
          .set('X-If-Absent', 'true')
          .send(uploadBytes);
      const uploadResult = await sendUpload().expect(201);
      const blobCount = await ctx.migrationDataSource
        .getRepository(BlobEntity)
        .count({ where: { namespaceId: ns } });

      const oldDataSource = ctx.app.get(DataSource);
      await ctx.app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await ctx.bootstrap();
      expect(ctx.app.get(DataSource)).not.toBe(oldDataSource);

      const replayedJson = await sendJson().expect(201);
      expect(replayedJson.body).toEqual(jsonResult.body);
      expect(replayedJson.headers['x-request-id']).toBe(jsonResult.headers['x-request-id']);
      const replayedUpload = await sendUpload().expect(201);
      expect(replayedUpload.body).toEqual(uploadResult.body);
      expect(replayedUpload.headers['x-request-id']).toBe(uploadResult.headers['x-request-id']);
      expect(
        await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId: ns } }),
      ).toBe(blobCount);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/content`)
            .query({ path: '/receipt-dir/file.bin' })
            .expect(200)
        ).body,
      ).toEqual(uploadBytes);
    });

    it('FILE metadata 읽기 중 snapshot 삭제가 끝나도 캡처된 해시를 반환한다', async () => {
      const ns = await ctx.createNamespace('snapshot-file-metadata-delete-race');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from('metadata-race');
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/source' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/source"}').expect(
        201,
      );
      const repository = ctx.app.get(VfsSnapshotRepository);
      type HashReader = (manager: EntityManager, snapshot: VfsSnapshotEntity) => Promise<string | null>;
      const original = (Reflect.get(repository, 'fileSha256') as HashReader).bind(repository);
      let entered!: () => void;
      let release!: () => void;
      const readEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = jest
        .spyOn(repository as unknown as { fileSha256: HashReader }, 'fileSha256')
        .mockImplementation(async (manager, snapshot) => {
          entered();
          await held;
          return original(manager, snapshot);
        });
      const pending = repository.get(ns, captured.body.snapshotId as string);
      try {
        await readEntered;
        await snapshotPost(base, `/${captured.body.snapshotId}/delete`, randomUUID(), '{}').expect(200);
        release();
        await expect(pending).resolves.toMatchObject({
          id: captured.body.snapshotId,
          rootNodeId: captured.body.rootNodeId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it.each([
      { writer: 'overwrite', first: 'snapshot' },
      { writer: 'overwrite', first: 'writer' },
      { writer: 'delete', first: 'snapshot' },
      { writer: 'delete', first: 'writer' },
    ] as const)(
      'FILE capture vs $writer: PostgreSQL $first 선행은 한 시점만 고정한다',
      async ({ writer, first }) => {
        const ns = await ctx.createNamespace(`snapshot-file-race-${writer}-${first}`);
        const base = `/api/v2/namespaces/${ns}/fs`;
        const oldBytes = Buffer.from([0, 255, 65]);
        const newBytes = Buffer.from([128, 66, 67]);
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path: '/race' })
          .set('Content-Type', 'application/octet-stream')
          .send(oldBytes)
          .expect(201);
        const before = (
          await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/race' }).expect(200)
        ).body;
        const holder = ctx.migrationDataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
        await holder.query(
          'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
          [ns],
        );
        const pending: Promise<request.Response>[] = [];
        let completed = 0;
        const start = (operation: 'snapshot' | 'writer') => {
          const req =
            operation === 'snapshot'
              ? snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/race"}')
              : writer === 'overwrite'
                ? request(ctx.httpServer)
                    .post(`${base}/content`)
                    .query({ path: '/race', force: true })
                    .set('Content-Type', 'application/octet-stream')
                    .send(newBytes)
                : request(ctx.httpServer).post(`${base}/rm`).query({ path: '/race' });
          pending.push(
            req.then((response) => {
              completed++;
              return response;
            }),
          );
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
            if (completed) throw new Error('operation completed before root lock release');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`expected ${count} separate PostgreSQL waiters`);
        };
        try {
          start(first);
          await blocked(1);
          start(first === 'snapshot' ? 'writer' : 'snapshot');
          await blocked(2);
        } finally {
          await holder.commitTransaction();
          await holder.release();
          await Promise.all(pending);
        }
        const [firstResult, secondResult] = await Promise.all(pending);
        const snapshot = first === 'snapshot' ? firstResult : secondResult;
        const changed = first === 'writer' ? firstResult : secondResult;
        expect(changed.status).toBe(writer === 'overwrite' ? 200 : 204);
        if (writer === 'delete' && first === 'writer') {
          expect(snapshot.status).toBe(404);
          expect(
            await ctx.app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns }),
          ).toBe(0);
          return;
        }
        expect(snapshot.status).toBe(201);
        const expectedBytes = writer === 'overwrite' && first === 'writer' ? newBytes : oldBytes;
        expect(snapshot.body.sha256).toBe(createHash('sha256').update(expectedBytes).digest('hex'));
        expect(snapshot.body.rootNodeId).toBe(decodeRevision(snapshot.body.sourceRevision).id);
        expect(
          (
            await request(ctx.httpServer)
              .get(`${base}/snapshots/${snapshot.body.snapshotId}/content`)
              .expect(200)
          ).body,
        ).toEqual(expectedBytes);
        expect(snapshot.body.sourceRevision).toBe(
          first === 'snapshot'
            ? before.revision
            : (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/race' }).expect(200))
                .body.revision,
        );
      },
    );

    describe('sourceRevision 조건', () => {
      async function seedFile(name: string, path = '/doc') {
        const ns = await ctx.createNamespace(name);
        const base = `/api/v2/namespaces/${ns}/fs`;
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path })
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from([1, 2, 3]))
          .expect(201);
        const revision = async (target = path) =>
          (await request(ctx.httpServer).get(`${base}/revision`).query({ path: target }).expect(200)).body
            .revision as string;
        const stat = async (target = path) =>
          (await request(ctx.httpServer).get(`${base}/stat`).query({ path: target }).expect(200)).body;
        const overwrite = (bytes: Buffer) =>
          request(ctx.httpServer)
            .post(`${base}/content`)
            .query({ path, force: true })
            .set('Content-Type', 'application/octet-stream')
            .send(bytes);
        return { ns, base, revision, stat, overwrite };
      }

      // snapshot·manifest·Blob ref·retained usage 행을 한 번에 비교하기 위한 요약
      async function rowCounts(ns: string) {
        const ds = ctx.app.get(DataSource);
        const blobs = await ds.getRepository(BlobEntity).findBy({ namespaceId: ns });
        const namespace = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
        return {
          snapshots: await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns }),
          entries: await ds.getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId: ns }),
          blobRefs: blobs.map((blob) => `${blob.id}:${blob.referenceCount}`).sort(),
          retainedNodes: namespace.retainedSnapshotNodeCount,
          retainedBytes: String(namespace.retainedSnapshotByteCount),
        };
      }

      const fileBody = (sourceRevision?: string, path = '/doc') =>
        JSON.stringify({ kind: 'file', path, ...(sourceRevision ? { sourceRevision } : {}) });

      it('현재 revision과 일치하면 snapshot을 만들고 그 revision을 고정한다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-match');
        const current = await revision();
        const before = await rowCounts(ns);
        const created = await snapshotPost(base, '', randomUUID(), fileBody(current)).expect(201);
        expect(created.body).toMatchObject({ kind: 'file', sourcePath: '/doc', sourceRevision: current });
        const after = await rowCounts(ns);
        expect(after.snapshots).toBe(before.snapshots + 1);
        expect(after.entries).toBe(before.entries + 1);
        expect(after.retainedNodes).toBe(before.retainedNodes + 1);
      });

      it('오래된 revision은 current를 담은 412를 반환하고 snapshot·manifest·Blob ref·usage 행을 만들지 않는다', async () => {
        const { ns, base, revision, stat, overwrite } = await seedFile('snapshot-source-stale');
        const stale = await revision();
        await overwrite(Buffer.from([9, 9])).expect(200);
        const before = await rowCounts(ns);
        const currentStat = await stat();
        const currentRevision = await revision();
        expect(currentRevision).not.toBe(stale);
        const failed = await snapshotPost(base, '', randomUUID(), fileBody(stale)).expect(412);
        expect(failed.body).toMatchObject({
          code: 'VFS_PRECONDITION_FAILED',
          path: '/doc',
          current: { ...withoutStatHash(currentStat), revision: currentRevision },
        });
        expect(await rowCounts(ns)).toEqual(before);
      });

      it.each(['snapshot', 'writer'] as const)(
        '동시 overwrite와의 순서가 sourceRevision 판정과 일치한다: PostgreSQL %s 선행',
        async (first) => {
          const { ns, base, revision, stat, overwrite } = await seedFile(`snapshot-source-race-${first}`);
          const oldRevision = await revision();
          const oldStat = await stat();
          const before = await rowCounts(ns);
          const holder = ctx.migrationDataSource.createQueryRunner();
          await holder.connect();
          await holder.startTransaction();
          const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
          await holder.query(
            'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
            [ns],
          );
          const pending: Promise<request.Response>[] = [];
          let completed = 0;
          const start = (operation: 'snapshot' | 'writer') => {
            const req =
              operation === 'snapshot'
                ? snapshotPost(base, '', randomUUID(), fileBody(oldRevision))
                : overwrite(Buffer.from([7, 7, 7, 7]));
            pending.push(
              req.then((response) => {
                completed++;
                return response;
              }),
            );
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
              if (completed) throw new Error('operation completed before root lock release');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`expected ${count} separate PostgreSQL waiters`);
          };
          try {
            start(first);
            await blocked(1);
            start(first === 'snapshot' ? 'writer' : 'snapshot');
            await blocked(2);
          } finally {
            await holder.commitTransaction();
            await holder.release();
            await Promise.all(pending);
          }
          const results = await Promise.all(pending);
          const snapshot = results[first === 'snapshot' ? 0 : 1];
          const writer = results[first === 'writer' ? 0 : 1];
          expect(writer.status).toBe(200);
          if (first === 'snapshot') {
            // capture가 먼저 root 잠금을 얻으면 옛 revision과 옛 bytes를 고정한다.
            expect(snapshot.status).toBe(201);
            expect(snapshot.body.sourceRevision).toBe(oldRevision);
            expect(
              (
                await request(ctx.httpServer)
                  .get(`${base}/snapshots/${snapshot.body.snapshotId}/content`)
                  .expect(200)
              ).body,
            ).toEqual(Buffer.from([1, 2, 3]));
            expect((await rowCounts(ns)).snapshots).toBe(before.snapshots + 1);
          } else {
            // writer가 먼저 커밋되면 옛 revision은 412이고 current는 writer 결과다.
            expect(snapshot.status).toBe(412);
            const after = await stat();
            const afterRevision = await revision();
            expect(after).not.toEqual(oldStat);
            expect(afterRevision).not.toBe(oldRevision);
            expect(snapshot.body).toMatchObject({
              code: 'VFS_PRECONDITION_FAILED',
              current: { ...withoutStatHash(after), revision: afterRevision },
            });
            // writer가 Blob을 교체하므로 ref는 새 Blob의 노드 참조 1개만 남아야 한다(snapshot ref 없음).
            const after412 = await rowCounts(ns);
            expect({ ...after412, blobRefs: undefined }).toEqual({ ...before, blobRefs: undefined });
            expect(after412.blobRefs.map((ref) => Number(ref.split(':')[1])).sort()).toEqual([0, 1]);
          }
        },
      );

      it('같은 key와 같은 요청 재시도는 원본이 바뀐 뒤에도 최초 snapshot ID를 재생한다', async () => {
        const { ns, base, revision, overwrite } = await seedFile('snapshot-source-lost-response');
        const key = randomUUID();
        const raw = fileBody(await revision());
        const first = await snapshotPost(base, '', key, raw).expect(201);
        // 응답이 유실된 클라이언트가 원본 변경 뒤 같은 요청을 다시 보내는 상황이다.
        await overwrite(Buffer.from([5])).expect(200);
        const replay = await snapshotPost(base, '', key, raw).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(1);
      });

      it('같은 key에서 sourceRevision만 바뀌거나 추가·제거되면 MUTATION_KEY_REUSED이다', async () => {
        const { base, revision, overwrite } = await seedFile('snapshot-source-key-reuse');
        const first = await revision();
        await overwrite(Buffer.from([4, 4])).expect(200);
        const second = await revision();
        const key = randomUUID();
        await snapshotPost(base, '', key, fileBody(second)).expect(201);
        for (const changed of [fileBody(first), fileBody()]) {
          expect((await snapshotPost(base, '', key, changed).expect(409)).body.code).toBe(
            'MUTATION_KEY_REUSED',
          );
        }
        const noCondition = randomUUID();
        await snapshotPost(base, '', noCondition, fileBody()).expect(201);
        expect((await snapshotPost(base, '', noCondition, fileBody(second)).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      });

      it('최초 412를 원본이 다시 바뀐 뒤와 앱 재시작 뒤에도 최초 body와 X-Request-Id로 재생한다', async () => {
        const { ns, base, revision, stat, overwrite } = await seedFile('snapshot-source-412-replay');
        const stale = await revision();
        await overwrite(Buffer.from([8, 8])).expect(200);
        const statAtConflict = await stat();
        const revisionAtConflict = await revision();
        const key = randomUUID();
        const raw = fileBody(stale);
        const first = await snapshotPost(base, '', key, raw).expect(412);
        expect(first.body.current).toEqual(withoutStatHash(statAtConflict));
        await overwrite(Buffer.from([6, 6, 6])).expect(200);
        // 원본이 다시 바뀌어 현재 revision은 충돌 시점과 다르다.
        expect(await revision()).not.toBe(revisionAtConflict);
        const replay = await snapshotPost(base, '', key, raw).expect(412);
        expect(replay.body).toEqual(first.body);
        expect(replay.body.current.revision).toBe(revisionAtConflict);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);

        const oldDataSource = ctx.app.get(DataSource);
        await ctx.app.close();
        expect(oldDataSource.isInitialized).toBe(false);
        await ctx.bootstrap();
        const afterRestart = await snapshotPost(base, '', key, raw).expect(412);
        expect(afterRestart.body).toEqual(first.body);
        expect(afterRestart.body.current.revision).toBe(revisionAtConflict);
        expect(afterRestart.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(0);
        // 같은 revision으로 새 key를 쓰면 여전히 최신 상태를 평가한다.
        const latestRevision = await revision();
        const fresh = await snapshotPost(base, '', randomUUID(), raw).expect(412);
        expect(fresh.body.current.revision).toBe(latestRevision);
        expect(fresh.body.current.revision).not.toBe(revisionAtConflict);
        expect(fresh.body.current).toEqual(withoutStatHash(await stat()));
      });

      it('성공한 snapshot 응답도 앱 재시작 뒤 같은 ID로 재생한다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-success-restart');
        const key = randomUUID();
        const raw = fileBody(await revision());
        const first = await snapshotPost(base, '', key, raw).expect(201);
        const oldDataSource = ctx.app.get(DataSource);
        await ctx.app.close();
        expect(oldDataSource.isInitialized).toBe(false);
        await ctx.bootstrap();
        const replay = await snapshotPost(base, '', key, raw).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(1);
      });

      it('원본 부재 404와 디렉터리 409가 revision 불일치 412보다 먼저이고 잘못된 요청은 400이다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-precedence');
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
        const stale = encodeRevision({ id: randomUUID(), version: 1 });
        const before = await rowCounts(ns);
        const missing = await snapshotPost(base, '', randomUUID(), fileBody(stale, '/missing')).expect(404);
        expect(missing.body.code).toBe('VFS_NODE_NOT_FOUND');
        for (const sourceRevision of [stale, await revision('/dir')]) {
          const directory = await snapshotPost(
            base,
            '',
            randomUUID(),
            fileBody(sourceRevision, '/dir'),
          ).expect(409);
          expect(directory.body.code).toBe('VFS_IS_DIRECTORY');
        }
        const malformed = await snapshotPost(base, '', randomUUID(), fileBody('r1.bad')).expect(400);
        expect(malformed.body.code).toBe('VFS_INVALID_REVISION');
        const tree = await snapshotPost(
          base,
          '',
          randomUUID(),
          JSON.stringify({ kind: 'tree', path: '/dir', sourceRevision: await revision('/dir') }),
        ).expect(400);
        expect(tree.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
        expect(await rowCounts(ns)).toEqual(before);
        // 404·409도 receipt로 재생된다.
        const key = randomUUID();
        const first = await snapshotPost(base, '', key, fileBody(stale, '/dir')).expect(409);
        const replay = await snapshotPost(base, '', key, fileBody(stale, '/dir')).expect(409);
        expect(replay.body).toEqual(first.body);
      });
    });

    registerFsFileSnapshotRestContract(ctx, scope, snapshotPost);
  });
}
