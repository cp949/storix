import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { toPreconditionCurrent } from '../vfs/dto/node-response.dto.js';
import { decodeRevision } from '../vfs/revision.js';
import { encodeRevision } from '../vfs/revision.js';
import {
  VfsAlreadyExistsError,
  VfsCopyLimitExceededError,
  VfsDeleteLimitExceededError,
  VfsDirectoryNotEmptyError,
  VfsInvalidCursorError,
  VfsInvalidOperationError,
  VfsInvalidPathError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsRevisionExhaustedError,
  VfsPreconditionFailedError,
  VfsVersionConflictError,
  VfsQuotaExceededError,
} from '../vfs/vfs.errors.js';

export interface VfsNodeRepositoryTestContext {
  readonly dataSource: DataSource;
  readonly repository: VfsNodeRepository;
}

// Postgres/SQLite 공용 테스트 본문. 드라이버별 실행 파일(*.integration-spec.ts,
// *.sqlite.integration-spec.ts)이 이 함수를 호출해 같은 테스트를 두 드라이버에
// 대해 반복한다 — 테스트 로직 중복 없이 드라이버별 실행만 분리한다.
// getContext()는 매 호출마다 다시 불러온다 — beforeAll이 끝난 뒤에야
// dataSource/repository가 실제로 준비되므로, 이 함수 몸체(describe 등록 시점)가
// 아니라 각 it()/헬퍼 실행 시점에 값을 가져와야 한다.
export function runVfsNodeRepositorySharedTests(getContext: () => VfsNodeRepositoryTestContext): void {
  function getDs(): DataSource {
    return getContext().dataSource;
  }

  function getRepo(): VfsNodeRepository {
    return getContext().repository;
  }

  async function createNamespace(name: string) {
    return new NamespaceProvisioningRepository(getDs()).createWithRoot(name);
  }

  async function createFile(namespaceId: string, parentId: string, name: string) {
    const blobRepo = getDs().getRepository(BlobEntity);
    const nodeRepo = getDs().getRepository(VfsNodeEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/00/${randomUUID()}`,
        size: '0',
        mimeType: 'application/octet-stream',
        sha256: '0'.repeat(64),
        referenceCount: 1,
      }),
    );
    return nodeRepo.save(
      nodeRepo.create({
        namespaceId,
        parentId,
        type: 'FILE',
        name,
        blobId: blob.id,
        size: '0',
        mimeType: 'application/octet-stream',
      }),
    );
  }

  async function captureState(namespaceId: string) {
    const nodes = await getDs()
      .getRepository(VfsNodeEntity)
      .find({
        where: { namespaceId },
        order: { id: 'ASC' },
      });
    const blobs = await getDs()
      .getRepository(BlobEntity)
      .find({
        where: { namespaceId },
        order: { id: 'ASC' },
      });
    return {
      nodes: nodes.map(({ id, parentId, name, type, blobId, version }) => ({
        id,
        parentId,
        name,
        type,
        blobId,
        version,
      })),
      blobs: blobs.map(({ id, referenceCount }) => ({ id, referenceCount })),
    };
  }

  async function runSameConditionAttempts<T>(namespaceId: string, attempt: () => Promise<T>) {
    if (getDs().options.type === 'better-sqlite3') {
      // SQLite는 root row 잠금이 없다. 쿼리 게이트가 두 시도를 한 줄로 세워, 동일한 조건을
      // 순서대로 재평가하는 계약을 실제 동시 시도로 확인한다.
      return Promise.allSettled([attempt(), attempt()]);
    }

    const holder = getDs().createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      const [{ pid }] = (await holder.query('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
      const lockedRoots = (await holder.query(
        'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
        [namespaceId],
      )) as { id: string }[];
      expect(lockedRoots).toHaveLength(1);
      pending = Promise.allSettled([attempt(), attempt()]);
      const deadline = Date.now() + 5000;
      let blocked = 0;
      while (Date.now() < deadline) {
        // pg_stat_activity.query에는 bind 값이 표시되지 않는다. 위에서 이 namespace의
        // root row 하나를 잠근 holder PID로 차단 연쇄를 묶고, root 조회 SQL만 센다.
        const [{ count }] = (await getDs().query(
          `WITH RECURSIVE blocked AS (
             SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker_pid
             FROM pg_stat_activity WHERE datname = current_database()
           ), root_waiters(pid) AS (
             SELECT pid FROM blocked WHERE blocker_pid = $1
             UNION
             SELECT b.pid FROM blocked b JOIN root_waiters w ON b.blocker_pid = w.pid
           )
           SELECT COUNT(DISTINCT a.pid)::int AS count
           FROM root_waiters w JOIN pg_stat_activity a ON a.pid = w.pid
           WHERE a.query LIKE '%vfs_node%'
             AND a.query LIKE '%namespace_id%'
             AND a.query LIKE '%parent_id%IS NULL%'
             AND a.query LIKE '%FOR UPDATE%'`,
          [pid],
        )) as { count: number }[];
        blocked = count;
        if (blocked >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(2);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      if (pending) await pending;
    }
    return pending!;
  }

  describe('mutation revisions', () => {
    it('increments root and existing ancestors once for create and overwrite', async () => {
      const namespace = await createNamespace('mutation-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const directory = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      const rootAfterDirectory = (await getRepo().getRoot(namespace.id))!;
      expect(rootAfterDirectory.version).toBe(root.version + 1);

      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      expect(created.node.version).toBe(1);
      const aAfterCreate = (await getRepo().resolvePath(namespace.id, root.id, ['a']))!;
      expect(aAfterCreate.version).toBe(directory.node.version + 1);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootAfterDirectory.version + 1);

      const replaced = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        created.node.version,
        false,
      );
      expect(replaced.node.version).toBe(created.node.version + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version).toBe(
        aAfterCreate.version + 1,
      );
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootAfterDirectory.version + 2);
    });

    it('does not change revisions or blob references after a failed numeric condition', async () => {
      const namespace = await createNamespace('mutation-conflict-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      const blobBefore = await getDs().getRepository(BlobEntity).find();
      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['x'],
          false,
          makeBlobData(),
          created.node.version + 1,
          false,
        ),
      ).rejects.toThrow(VfsVersionConflictError);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(created.node.version);
      expect(
        (await getDs().getRepository(BlobEntity).find()).map((blob) => [blob.id, blob.referenceCount]),
      ).toEqual(blobBefore.map((blob) => [blob.id, blob.referenceCount]));
    });

    it('changes a moved subtree and old and new ancestors once', async () => {
      const namespace = await createNamespace('mutation-move-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'sub'], true);
      await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'sub', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const before = {
        root: (await getRepo().getRoot(namespace.id))!.version,
        a: (await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version,
        b: (await getRepo().resolvePath(namespace.id, root.id, ['b']))!.version,
        sub: (await getRepo().resolvePath(namespace.id, root.id, ['a', 'sub']))!.version,
        x: (await getRepo().resolvePath(namespace.id, root.id, ['a', 'sub', 'x']))!.version,
      };
      await getRepo().moveNode(namespace.id, root.id, ['a', 'sub'], ['b'], false);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(before.root + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version).toBe(before.a + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b']))!.version).toBe(before.b + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b', 'sub']))!.version).toBe(
        before.sub + 1,
      );
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b', 'sub', 'x']))!.version).toBe(
        before.x + 1,
      );
    });

    it('reports surviving affected paths in canonical order', async () => {
      const namespace = await createNamespace('mutation-affected-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const result = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().ensureDirectory(namespace.id, root.id, ['a', 'b'], true, tx),
      );
      expect(result.affectedRevisions.map((item) => item.path)).toEqual(['/', '/a', '/a/b']);
      for (const item of result.affectedRevisions) {
        expect(decodeRevision(item.revision).version).toBe(1 + Number(item.path === '/'));
      }
    });

    it('copies nodes without changing source revisions', async () => {
      const namespace = await createNamespace('mutation-copy-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['src'], false);
      await getRepo().putFileContent(namespace.id, root.id, ['src', 'x'], false, makeBlobData(), null, false);
      const source = (await getRepo().resolvePath(namespace.id, root.id, ['src']))!;
      const file = (await getRepo().resolvePath(namespace.id, root.id, ['src', 'x']))!;
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      await getRepo().copyNode(namespace.id, root.id, ['src'], ['copy'], false, 100);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['src']))!.version).toBe(source.version);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['src', 'x']))!.version).toBe(file.version);
      const copied = (await getRepo().resolvePath(namespace.id, root.id, ['copy']))!;
      const copiedFile = (await getRepo().resolvePath(namespace.id, root.id, ['copy', 'x']))!;
      expect(copied.id).not.toBe(source.id);
      expect(copied.version).toBe(1);
      expect(copiedFile.id).not.toBe(file.id);
      expect(copiedFile.version).toBe(1);
    });

    it('rolls back mutation when an ancestor version reaches the database ceiling', async () => {
      const namespace = await createNamespace('mutation-ceiling-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getDs().getRepository(VfsNodeEntity).update(root.id, { version: 2147483647 });
      await expect(getRepo().ensureDirectory(namespace.id, root.id, ['a'], false)).rejects.toThrow(
        VfsRevisionExhaustedError,
      );
      expect(await getRepo().resolvePath(namespace.id, root.id, ['a'])).toBeNull();
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(2147483647);
    });

    it('rejects an exhausted target version with the domain error', async () => {
      const namespace = await createNamespace('mutation-target-ceiling-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().touchFile(namespace.id, root.id, ['x'], false, makeBlobData());
      await getDs().getRepository(VfsNodeEntity).update(created.node.id, { version: 2147483647 });
      await expect(getRepo().touchFile(namespace.id, root.id, ['x'], false, makeBlobData())).rejects.toThrow(
        VfsRevisionExhaustedError,
      );
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(2147483647);
    });

    it('rolls back metadata and revisions if the commit hook fails', async () => {
      const namespace = await createNamespace('mutation-hook-rollback-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await expect(
        getRepo().withMutation(
          namespace.id,
          root.id,
          (tx) => getRepo().ensureDirectory(namespace.id, root.id, ['a'], false, tx),
          async () => {
            throw new Error('receipt write failed');
          },
        ),
      ).rejects.toThrow('receipt write failed');
      expect(await getRepo().resolvePath(namespace.id, root.id, ['a'])).toBeNull();
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(root.version);
    });
  });

  describe('conditional mutations', () => {
    it.each(['create', 'update', 'delete', 'move', 'copy'] as const)(
      '%s precondition failure preserves the tree, blob references, and all revisions',
      async (kind) => {
        const namespace = await createNamespace(`atomic-stale-${kind}-ns`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
        await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
        const initial = await getRepo().putFileContent(
          namespace.id,
          root.id,
          ['a', 'source'],
          false,
          makeBlobData(),
          null,
          false,
        );
        const staleRevision = encodeRevision(initial.node);
        if (kind !== 'create') {
          await getRepo().withMutation(namespace.id, root.id, (tx) =>
            getRepo().putConditionalContent(
              tx,
              ['a', 'source'],
              { ifRevision: staleRevision },
              makeBlobData(),
            ),
          );
        }
        const before = await captureState(namespace.id);
        const attempt = () =>
          getRepo().withMutation(namespace.id, root.id, (tx) => {
            if (kind === 'create') {
              return getRepo().applyConditionalMutation(tx, {
                kind: 'mkdir',
                path: '/a/source',
                segments: ['a', 'source'],
                ifAbsent: true,
              });
            }
            if (kind === 'update') {
              return getRepo().putConditionalContent(
                tx,
                ['a', 'source'],
                { ifRevision: staleRevision },
                makeBlobData(),
              );
            }
            if (kind === 'delete') {
              return getRepo().applyConditionalMutation(tx, {
                kind: 'delete',
                path: '/a/source',
                segments: ['a', 'source'],
                ifRevision: staleRevision,
                recursive: false,
              });
            }
            return getRepo().applyConditionalMutation(tx, {
              kind,
              source: '/a/source',
              sourceSegments: ['a', 'source'],
              destination: '/b',
              destinationSegments: ['b'],
              sourceRevision: staleRevision,
              destinationAbsent: true,
            });
          });
        await expect(attempt()).rejects.toThrow(VfsPreconditionFailedError);
        expect(await captureState(namespace.id)).toEqual(before);
      },
    );

    it.each(['copy', 'delete'] as const)(
      '%s rolls back tree, blob references, and revisions when commit preparation fails',
      async (kind) => {
        const namespace = await createNamespace(`atomic-rollback-${kind}-ns`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
        await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
        const source = await getRepo().putFileContent(
          namespace.id,
          root.id,
          ['a', 'source'],
          false,
          makeBlobData(),
          null,
          false,
        );
        const before = await captureState(namespace.id);
        await expect(
          getRepo().withMutation(
            namespace.id,
            root.id,
            (tx) =>
              kind === 'copy'
                ? getRepo().applyConditionalMutation(tx, {
                    kind: 'copy',
                    source: '/a/source',
                    sourceSegments: ['a', 'source'],
                    destination: '/b',
                    destinationSegments: ['b'],
                    sourceRevision: encodeRevision(source.node),
                    destinationAbsent: true,
                  })
                : getRepo().applyConditionalMutation(tx, {
                    kind: 'delete',
                    path: '/a/source',
                    segments: ['a', 'source'],
                    ifRevision: encodeRevision(source.node),
                    recursive: false,
                  }),
            async () => {
              throw new Error('commit preparation failed');
            },
          ),
        ).rejects.toThrow('commit preparation failed');
        expect(await captureState(namespace.id)).toEqual(before);
      },
    );

    it.each(['create', 'update', 'delete', 'move'] as const)(
      '%s with the same condition has exactly one winner',
      async (kind) => {
        const namespace = await createNamespace(`atomic-race-${kind}-ns`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
        await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
        const source =
          kind === 'create'
            ? null
            : await getRepo().putFileContent(
                namespace.id,
                root.id,
                ['a', 'source'],
                false,
                makeBlobData(),
                null,
                false,
              );
        const revision = source ? encodeRevision(source.node) : null;
        const rootBefore = (await getRepo().getRoot(namespace.id))!;
        const aBefore = (await getRepo().resolvePath(namespace.id, root.id, ['a']))!;
        const bBefore = (await getRepo().resolvePath(namespace.id, root.id, ['b']))!;
        const attempt = () =>
          getRepo().withMutation(namespace.id, root.id, (tx) => {
            if (kind === 'create')
              return getRepo().applyConditionalMutation(tx, {
                kind: 'mkdir',
                path: '/a/new',
                segments: ['a', 'new'],
                ifAbsent: true,
              });
            if (kind === 'update')
              return getRepo().putConditionalContent(
                tx,
                ['a', 'source'],
                { ifRevision: revision! },
                makeBlobData(),
              );
            if (kind === 'delete')
              return getRepo().applyConditionalMutation(tx, {
                kind: 'delete',
                path: '/a/source',
                segments: ['a', 'source'],
                ifRevision: revision!,
                recursive: false,
              });
            return getRepo().applyConditionalMutation(tx, {
              kind: 'move',
              source: '/a/source',
              sourceSegments: ['a', 'source'],
              destination: '/b',
              destinationSegments: ['b'],
              sourceRevision: revision!,
              destinationAbsent: true,
            });
          });
        const results = await runSameConditionAttempts(namespace.id, attempt);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected?.reason).toBeInstanceOf(
          kind === 'delete' || kind === 'move' ? VfsNodeNotFoundError : VfsPreconditionFailedError,
        );
        expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version + 1);
        expect((await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version).toBe(
          aBefore.version + 1,
        );
        expect((await getRepo().resolvePath(namespace.id, root.id, ['b']))!.version).toBe(
          bBefore.version + Number(kind === 'move'),
        );
        const atSource = await getRepo().resolvePath(namespace.id, root.id, ['a', 'source']);
        const blobs = await getDs()
          .getRepository(BlobEntity)
          .find({ where: { namespaceId: namespace.id } });
        if (kind === 'create') {
          expect(await getRepo().resolvePath(namespace.id, root.id, ['a', 'new'])).toMatchObject({
            version: 1,
          });
          expect(blobs).toHaveLength(0);
        } else if (kind === 'update') {
          expect(atSource?.version).toBe(source!.node.version + 1);
          expect(blobs.map((blob) => blob.referenceCount).sort()).toEqual([0, 1]);
        } else if (kind === 'delete') {
          expect(atSource).toBeNull();
          expect(blobs.map((blob) => blob.referenceCount)).toEqual([0]);
        } else {
          expect(atSource).toBeNull();
          expect(await getRepo().resolvePath(namespace.id, root.id, ['b', 'source'])).toMatchObject({
            version: source!.node.version + 1,
          });
          expect(blobs.map((blob) => blob.referenceCount)).toEqual([1]);
        }
      },
    );

    it('requires absence for create and an exact revision for overwrite', async () => {
      const namespace = await createNamespace('conditional-content-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const first = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(tx, ['x'], { ifAbsent: true }, makeBlobData()),
      );
      expect(first.value).toMatchObject({ status: 201, resource: { path: '/x' } });
      const created = (await getRepo().resolvePath(namespace.id, root.id, ['x']))!;
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().putConditionalContent(tx, ['x'], { ifAbsent: true }, makeBlobData()),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().putConditionalContent(tx, ['x'], { ifRevision: encodeRevision(root) }, makeBlobData()),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(created.version);
      const second = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(tx, ['x'], { ifRevision: encodeRevision(created) }, makeBlobData()),
      );
      expect(second.value).toMatchObject({ status: 200, resource: { path: '/x' } });
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(created.version + 1);
    });
    it('creates only when absent and rejects a second create with 412', async () => {
      const namespace = await createNamespace('conditional-mkdir-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const command = { kind: 'mkdir' as const, path: '/a', segments: ['a'], ifAbsent: true as const };
      const first = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().applyConditionalMutation(tx, command),
      );
      expect(first.value).toMatchObject({ status: 201, resource: { path: '/a' } });
      expect(first.affectedRevisions.map((item) => item.path)).toEqual(['/', '/a']);
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, command),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version);
    });

    it('rejects a move into a directory with a child collision before changing the source', async () => {
      const namespace = await createNamespace('conditional-move-collision-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['source'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['dest'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['dest', 'source'], false);
      const source = (await getRepo().resolvePath(namespace.id, root.id, ['source']))!;
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind: 'move',
            source: '/source',
            sourceSegments: ['source'],
            destination: '/dest',
            destinationSegments: ['dest'],
            sourceRevision: encodeRevision(source),
            destinationAbsent: true,
          }),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['source']))!.id).toBe(source.id);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version);
    });

    it('rejects a stale revision after delete and recreate of the same path', async () => {
      const namespace = await createNamespace('conditional-recreate-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const old = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      const oldRevision = encodeRevision(old.node);
      const deleted = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().applyConditionalMutation(tx, {
          kind: 'delete',
          path: '/a',
          segments: ['a'],
          ifRevision: oldRevision,
          recursive: false,
        }),
      );
      expect(deleted.value).toEqual({ status: 200, resource: null });
      expect(deleted.affectedRevisions.map((item) => item.path)).toEqual(['/']);
      const recreated = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      expect(encodeRevision(recreated.node)).not.toBe(oldRevision);
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind: 'delete',
            path: '/a',
            segments: ['a'],
            ifRevision: oldRevision,
            recursive: false,
          }),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
    });

    it('does not copy when the source revision is stale', async () => {
      const namespace = await createNamespace('conditional-copy-stale-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().ensureDirectory(namespace.id, root.id, ['source'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['source', 'child'], false);
      await expect(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind: 'copy',
            source: '/source',
            sourceSegments: ['source'],
            destination: '/copy',
            destinationSegments: ['copy'],
            sourceRevision: encodeRevision(source.node),
            destinationAbsent: true,
          }),
        ),
      ).rejects.toThrow(VfsPreconditionFailedError);
      expect(await getRepo().resolvePath(namespace.id, root.id, ['copy'])).toBeNull();
    });
  });

  describe('412 오류의 current', () => {
    async function rejection(promise: Promise<unknown>): Promise<VfsPreconditionFailedError> {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(VfsPreconditionFailedError);
      return error as VfsPreconditionFailedError;
    }

    // current는 stat 필드에 충돌 시점의 revision(r1.)을 더한 형태다.
    // 412 트랜잭션은 롤백되므로 거부 뒤 다시 읽은 레코드가 충돌 시점 상태다. 충돌 전에 잡아 둔
    // 노드와 id·version이 같은지 먼저 확인해 충돌 시점 레코드임을 고정하고, size·mimeType·
    // createdAt·updatedAt을 포함한 current 전체를 toEqual로 비교할 기댓값을 만든다.
    async function currentAt(
      namespaceId: string,
      rootId: string,
      segments: string[],
      path: string,
      conflicted: { id: string; version: number },
    ) {
      const record = await getRepo().resolvePath(namespaceId, rootId, segments);
      expect(record).toMatchObject({ id: conflicted.id, version: conflicted.version });
      return toPreconditionCurrent(record!, path);
    }

    it('mkdir 대상이 이미 있으면 기존 노드 metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-mkdir-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const existing = (await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false)).node;
      const error = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind: 'mkdir',
            path: '/a',
            segments: ['a'],
            ifAbsent: true,
          }),
        ),
      );
      expect(error.current).toEqual({
        id: existing.id,
        path: '/a',
        name: 'a',
        type: 'DIRECTORY',
        size: null,
        mimeType: null,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
        version: existing.version,
        revision: encodeRevision(existing),
      });
    });

    it('delete revision 불일치 시 현재 노드 metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-delete-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const old = (await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false)).node;
      await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().applyConditionalMutation(tx, {
          kind: 'delete',
          path: '/a',
          segments: ['a'],
          ifRevision: encodeRevision(old),
          recursive: false,
        }),
      );
      const recreated = (await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false)).node;
      const error = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind: 'delete',
            path: '/a',
            segments: ['a'],
            ifRevision: encodeRevision(old),
            recursive: false,
          }),
        ),
      );
      expect(error.current).toEqual(await currentAt(namespace.id, root.id, ['a'], '/a', recreated));
    });

    it('move과 copy의 source revision 불일치 시 source metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-source-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = (await getRepo().ensureDirectory(namespace.id, root.id, ['source'], false)).node;
      const stale = encodeRevision({ id: source.id, version: source.version + 5 });
      for (const kind of ['move', 'copy'] as const) {
        const error = await rejection(
          getRepo().withMutation(namespace.id, root.id, (tx) =>
            getRepo().applyConditionalMutation(tx, {
              kind,
              source: '/source',
              sourceSegments: ['source'],
              destination: '/dest',
              destinationSegments: ['dest'],
              sourceRevision: stale,
              destinationAbsent: true,
            }),
          ),
        );
        expect(error.current).toEqual(await currentAt(namespace.id, root.id, ['source'], '/source', source));
      }
    });

    it('move과 copy의 목적지가 이미 있으면 충돌한 목적지 노드를 current로 담는다', async () => {
      const namespace = await createNamespace('current-destination-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = (await getRepo().ensureDirectory(namespace.id, root.id, ['source'], false)).node;
      await getRepo().ensureDirectory(namespace.id, root.id, ['dest'], false);
      const nested = (await getRepo().ensureDirectory(namespace.id, root.id, ['dest', 'source'], false)).node;
      const rootFile = await createFile(namespace.id, root.id, 'file.txt');
      for (const kind of ['move', 'copy'] as const) {
        // 디렉터리 목적지 아래에 같은 이름이 있는 충돌
        const nestedError = await rejection(
          getRepo().withMutation(namespace.id, root.id, (tx) =>
            getRepo().applyConditionalMutation(tx, {
              kind,
              source: '/source',
              sourceSegments: ['source'],
              destination: '/dest',
              destinationSegments: ['dest'],
              sourceRevision: encodeRevision(source),
              destinationAbsent: true,
            }),
          ),
        );
        expect(nestedError.path).toBe('/dest/source');
        expect(nestedError.current).toEqual(
          await currentAt(namespace.id, root.id, ['dest', 'source'], '/dest/source', nested),
        );
        // 파일 목적지와의 충돌
        const fileError = await rejection(
          getRepo().withMutation(namespace.id, root.id, (tx) =>
            getRepo().applyConditionalMutation(tx, {
              kind,
              source: '/source',
              sourceSegments: ['source'],
              destination: '/file.txt',
              destinationSegments: ['file.txt'],
              sourceRevision: encodeRevision(source),
              destinationAbsent: true,
            }),
          ),
        );
        expect(fileError.current).toEqual(
          await currentAt(namespace.id, root.id, ['file.txt'], '/file.txt', rootFile),
        );
      }
    });

    it('content 생성 조건과 revision 조건 위반 시 현재 파일 metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-content-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(tx, ['x'], { ifAbsent: true }, makeBlobData()),
      );
      const file = (await getRepo().resolvePath(namespace.id, root.id, ['x']))!;
      const absentError = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().putConditionalContent(tx, ['x'], { ifAbsent: true }, makeBlobData()),
        ),
      );
      expect(absentError.current).toEqual(await currentAt(namespace.id, root.id, ['x'], '/x', file));
      const staleError = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().putConditionalContent(
            tx,
            ['x'],
            { ifRevision: encodeRevision({ id: file.id, version: file.version + 3 }) },
            makeBlobData(),
          ),
        ),
      );
      expect(staleError.current).toEqual(await currentAt(namespace.id, root.id, ['x'], '/x', file));
    });

    it('restore 조건 위반 시 현재 파일 metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-restore-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const file = await createFile(namespace.id, root.id, 'x');
      const blob = { blobId: randomUUID(), size: '0', mimeType: 'application/octet-stream' };
      const absentError = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().restoreBlob(tx, ['x'], { ifAbsent: true }, blob),
        ),
      );
      expect(absentError.current).toEqual(await currentAt(namespace.id, root.id, ['x'], '/x', file));
      const staleError = await rejection(
        getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().restoreBlob(
            tx,
            ['x'],
            { ifRevision: encodeRevision({ id: file.id, version: file.version + 3 }) },
            blob,
          ),
        ),
      );
      expect(staleError.current).toEqual(await currentAt(namespace.id, root.id, ['x'], '/x', file));
    });

    it('만료된 목록 cursor의 412는 현재 directory metadata를 current로 담는다', async () => {
      const namespace = await createNamespace('current-cursor-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'x'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'y'], false);
      const first = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 1);
      const cursor = {
        directoryId: first.directory.id,
        directoryRevision: encodeRevision(first.directory),
        name: first.rows[0].name,
        id: first.rows[0].id,
      };
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'z'], false);
      const directory = (await getRepo().resolvePath(namespace.id, root.id, ['a']))!;
      const error = await rejection(
        getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1),
      );
      expect(error.current).toEqual(await currentAt(namespace.id, root.id, ['a'], '/a', directory));
    });
  });

  describe('revision snapshot reads', () => {
    it('invalidates a cursor after a descendant changes but not after an independent branch changes', async () => {
      const namespace = await createNamespace('revision-snapshot-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'x'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'y'], false);
      const first = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 1);
      const cursor = {
        directoryId: first.directory.id,
        directoryRevision: encodeRevision(first.directory),
        name: first.rows[0].name,
        id: first.rows[0].id,
      };
      await getRepo().ensureDirectory(namespace.id, root.id, ['b', 'other'], false);
      expect(
        (await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1)).rows[0].name,
      ).toBe('y');
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x', 'code.py'],
        false,
        makeBlobData(),
        null,
        false,
      );
      await expect(
        getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1),
      ).rejects.toThrow(VfsPreconditionFailedError);
      await expect(
        getRepo().listRevisionChildren(namespace.id, root.id, ['b'], '/b', cursor, 1),
      ).rejects.toThrow(VfsInvalidCursorError);
    });

    it('reads directory and child revisions from one transaction during a concurrent content change', async () => {
      const namespace = await createNamespace('revision-read-write-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      const first = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const before = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10);
      const [read] = await Promise.all([
        getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10),
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['a', 'x'],
          false,
          makeBlobData(),
          first.node.version,
          false,
        ),
      ]);
      const after = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10);
      expect([
        [before.directory.version, before.rows[0].version],
        [after.directory.version, after.rows[0].version],
      ]).toContainEqual([read.directory.version, read.rows[0].version]);
    });
  });

  describe('getRoot', () => {
    it('존재하는 namespace의 root node를 반환한다', async () => {
      const namespace = await createNamespace('get-root-ns');

      const root = await getRepo().getRoot(namespace.id);

      expect(root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const root = await getRepo().getRoot(randomUUID());

      expect(root).toBeNull();
    });
  });

  describe('namespace total logical quota', () => {
    it('denies an over-limit create and overwrite without persisting node, blob, revision, or usage', async () => {
      const namespace = await createNamespace('logical-quota-node-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '3' });
      const root = (await getRepo().getRoot(namespace.id))!;

      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['too-large'],
          false,
          makeBlobData({ size: '4' }),
          null,
          false,
        ),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(await getRepo().resolvePath(namespace.id, root.id, ['too-large'])).toBeNull();
      expect(await getDs().getRepository(BlobEntity).countBy({ namespaceId: namespace.id })).toBe(0);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('0');

      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );
      const revisionBeforeDeniedOverwrite = (await getRepo().getRoot(namespace.id))!.version;
      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['file'],
          false,
          makeBlobData({ size: '4' }),
          created.node.version,
          false,
        ),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(String((await getRepo().resolvePath(namespace.id, root.id, ['file']))?.size)).toBe('3');
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(revisionBeforeDeniedOverwrite);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
    });

    it('subtracts live bytes on delete and permits zero or negative deltas while over quota', async () => {
      const namespace = await createNamespace('logical-quota-delete-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '3' });
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '2' });

      await getRepo().touchFile(namespace.id, root.id, ['file'], false, makeBlobData());
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
      await getRepo().removeNode(namespace.id, root.id, ['file'], false, 100);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('0');
    });

    it('move keeps usage unchanged while COW copy adds logical bytes and is rolled back over limit', async () => {
      const namespace = await createNamespace('logical-quota-copy-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '5' });
      const root = (await getRepo().getRoot(namespace.id))!;
      const file = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );

      await getRepo().moveNode(namespace.id, root.id, ['file'], ['moved'], false);
      await expect(
        getRepo().copyNode(namespace.id, root.id, ['moved'], ['copy'], false, 100),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(await getRepo().resolvePath(namespace.id, root.id, ['copy'])).toBeNull();
      expect((await getRepo().resolvePath(namespace.id, root.id, ['moved']))?.id).toBe(file.node.id);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
    });

    it('serializes concurrent positive deltas at the namespace root lock', async () => {
      const namespace = await createNamespace('logical-quota-race-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '5' });
      const root = (await getRepo().getRoot(namespace.id))!;
      const write = (name: string) =>
        getRepo().putFileContent(
          namespace.id,
          root.id,
          [name],
          false,
          makeBlobData({ size: '4' }),
          null,
          false,
        );

      const outcomes = await Promise.allSettled([write('first'), write('second')]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const error = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(error.reason).toBeInstanceOf(VfsQuotaExceededError);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('4');
    });
  });

  describe('getRootWithLimits', () => {
    it('namespace 상한 값이 NULL이면 limits도 모두 null이다', async () => {
      const namespace = await createNamespace('root-limits-null-ns');

      const result = await getRepo().getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: null,
        maxSyncDeleteNodes: null,
        maxSyncCopyNodes: null,
        encryptionPolicy: 'NONE',
        accessPolicy: 'PRIVATE',
      });
      expect(result?.root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('namespace에 설정된 상한 값을 함께 반환한다', async () => {
      const namespace = await createNamespace('root-limits-set-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, {
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
      });

      const result = await getRepo().getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
        encryptionPolicy: 'NONE',
        accessPolicy: 'PRIVATE',
      });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const result = await getRepo().getRootWithLimits(randomUUID());

      expect(result).toBeNull();
    });
  });

  describe('resolvePath', () => {
    it('중첩된 디렉터리 경로를 순서대로 resolve한다', async () => {
      const namespace = await createNamespace('resolve-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, a.node.id, ['b'], false);

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['a', 'b']);

      expect(resolved).toMatchObject({ name: 'b', type: 'DIRECTORY' });
    });

    it('존재하지 않는 segment면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['nope']);

      expect(resolved).toBeNull();
    });

    it('중간 segment가 FILE이면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-file-blocks-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a-file');

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['a-file', 'child']);

      expect(resolved).toBeNull();
      expect(file.type).toBe('FILE');
    });
  });

  describe('ensureDirectory', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성한다', async () => {
      const namespace = await createNamespace('mkdir-simple-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      expect(result).toMatchObject({ created: true, node: { name: 'a', type: 'DIRECTORY' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-no-parent-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], false)).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });

    it('parents=true면 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('mkdir-p-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b', 'c'], true);

      expect(result).toMatchObject({ created: true, node: { name: 'c', type: 'DIRECTORY' } });

      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const a = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: root!.id, name: 'a' });
      const b = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: a.id, name: 'b' });
      expect(b.name).toBe('b');
    });

    it('parents=false로 이미 존재하는 디렉터리를 만들면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], false);

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('parents=true로 이미 존재하는 디렉터리를 만들면 성공하되 created=false다', async () => {
      const namespace = await createNamespace('mkdir-idempotent-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], true);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], true);

      expect(result.created).toBe(false);
      expect(result.node.name).toBe('dup');
    });

    it('대상 경로에 이미 FILE이 있으면 parents 여부와 무관하게 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-over-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocked');

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['blocked'], true)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('중간 경로에 FILE이 있으면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-through-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocker');

      await expect(
        getRepo().ensureDirectory(namespace.id, root!.id, ['blocker', 'child'], true),
      ).rejects.toThrow(VfsNotDirectoryError);
    });
  });

  describe('listChildren', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespace = await createNamespace('ls-order-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['b'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['c'], false);

      const items = await getRepo().listChildren(namespace.id, root!.id, null, 100);

      expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    });

    it('limit보다 항목이 많으면 limit+1개를 반환해 다음 페이지 존재를 알 수 있게 한다', async () => {
      const namespace = await createNamespace('ls-page-ns');
      const root = await getRepo().getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await getRepo().ensureDirectory(namespace.id, root!.id, [name], false);
      }

      const items = await getRepo().listChildren(namespace.id, root!.id, null, 2);

      expect(items).toHaveLength(3);
    });

    it('cursor 이후의 항목만 반환한다', async () => {
      const namespace = await createNamespace('ls-cursor-ns');
      const root = await getRepo().getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await getRepo().ensureDirectory(namespace.id, root!.id, [name], false);
      }
      const first = await getRepo().listChildren(namespace.id, root!.id, null, 1);

      const next = await getRepo().listChildren(
        namespace.id,
        root!.id,
        { name: first[0].name, id: first[0].id },
        100,
      );

      expect(next.map((i) => i.name)).toEqual(['b', 'c']);
    });
  });

  describe('findRecursive', () => {
    async function buildTree(namespace: { id: string }, root: { id: string }) {
      const a = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, a.node.id, ['b'], false);
      await createFile(namespace.id, a.node.id, 'report.pdf');
      await createFile(namespace.id, root.id, 'readme.md');
      return a.node;
    }

    it('시작 경로 하위를 재귀적으로 모두 반환한다', async () => {
      const namespace = await createNamespace('find-all-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['a', 'b', 'readme.md', 'report.pdf'].sort());
    });

    it('type 필터로 FILE만 반환한다', async () => {
      const namespace = await createNamespace('find-type-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, { type: 'FILE' }, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['readme.md', 'report.pdf']);
    });

    it('name exact 필터가 정확히 일치하는 항목만 반환한다', async () => {
      const namespace = await createNamespace('find-exact-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'exact', value: 'readme.md' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['readme.md']);
    });

    it('name contains 필터가 부분 일치하는 항목을 반환한다', async () => {
      const namespace = await createNamespace('find-contains-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: 'epor' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['report.pdf']);
    });

    it('name prefix/suffix 필터가 동작한다', async () => {
      const namespace = await createNamespace('find-prefix-suffix-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const prefixMatches = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'prefix', value: 'read' } },
        null,
        100,
      );
      const suffixMatches = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'suffix', value: '.pdf' } },
        null,
        100,
      );

      expect(prefixMatches.map((i) => i.name)).toEqual(['readme.md']);
      expect(suffixMatches.map((i) => i.name)).toEqual(['report.pdf']);
    });

    it('name 필터에 LIKE 특수문자가 있어도 리터럴로 취급한다', async () => {
      const namespace = await createNamespace('find-escape-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['100%_done'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['100xxdone'], false);

      const items = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: '%_' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['100%_done']);
    });

    it('각 결과는 시작 경로 기준 상대 segment 배열을 포함한다', async () => {
      const namespace = await createNamespace('find-segments-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      const report = items.find((i) => i.name === 'report.pdf');
      expect(report?.relativeSegments).toEqual(['a', 'report.pdf']);
    });

    it('createdAt/updatedAt을 Date 인스턴스로 반환한다', async () => {
      const namespace = await createNamespace('find-dates-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      for (const item of items) {
        expect(item.createdAt).toBeInstanceOf(Date);
        expect(item.updatedAt).toBeInstanceOf(Date);
        expect(Number.isNaN(item.createdAt.getTime())).toBe(false);
      }
    });

    it('cursor 이후의 항목만 반환한다', async () => {
      const namespace = await createNamespace('find-cursor-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const first = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 1);
      const next = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        {},
        { name: first[0].name, id: first[0].id },
        100,
      );

      expect(next.length).toBe(3);
      expect(next.some((i) => i.name === first[0].name && i.id === first[0].id)).toBe(false);
    });
  });

  function makeBlobData(
    overrides: Partial<{
      storageKey: string;
      size: string;
      mimeType: string;
      sha256: string;
      encryptionIv: Buffer | null;
    }> = {},
  ) {
    return {
      storageKey: `blobs/00/${randomUUID()}`,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: '0'.repeat(64),
      encryptionIv: null,
      ...overrides,
    };
  }

  describe('touchFile', () => {
    it('대상이 없으면 0-byte file을 생성하고 created를 반환한다', async () => {
      const namespace = await createNamespace('touch-create-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'a.txt', type: 'FILE', size: '0' } });
    });

    it('대상 file이 있으면 content는 유지한 채 version만 올린다', async () => {
      const namespace = await createNamespace('touch-existing-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result.kind).toBe('replaced');
      expect(result.node.blobId).toBe(file.blobId);
      expect(result.node.version).toBe(file.version + 1);
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('touch-dir-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['adir'], false, makeBlobData()),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('parents=true면 중간 디렉터리를 만들며 file을 생성한다', async () => {
      const namespace = await createNamespace('touch-parents-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a', 'b.txt'], true, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'b.txt', type: 'FILE' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('touch-no-parent-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['a', 'b.txt'], false, makeBlobData()),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('putFileContent', () => {
    it('대상이 없으면 새 file을 생성한다', async () => {
      const namespace = await createNamespace('put-create-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '5' }),
        null,
        false,
      );

      expect(result).toMatchObject({ kind: 'created', node: { name: 'a.txt', size: '5' } });
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('put-dir-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        getRepo().putFileContent(namespace.id, root!.id, ['adir'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('If-Match version이 일치하면 새 Blob으로 교체하고 이전 Blob 참조를 줄인다', async () => {
      const namespace = await createNamespace('put-match-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '9' }),
        file.version,
        false,
      );

      expect(result).toMatchObject({ kind: 'replaced', node: { size: '9' } });
      expect(result.node.blobId).not.toBe(file.blobId);

      const oldBlob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });
      expect(oldBlob.referenceCount).toBe(0);
      expect(oldBlob.zeroSince).not.toBeNull();
    });

    it('If-Match version이 불일치하면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().putFileContent(
          namespace.id,
          root!.id,
          ['a.txt'],
          false,
          makeBlobData(),
          file.version + 1,
          false,
        ),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('If-Match 없이 force=false면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-no-if-match-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().putFileContent(namespace.id, root!.id, ['a.txt'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespace = await createNamespace('put-force-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '3' }),
        null,
        true,
      );

      expect(result).toMatchObject({ kind: 'replaced', node: { size: '3' } });
    });
  });

  describe('moveNode', () => {
    it('같은 디렉터리 내에서 이름을 바꾼다', async () => {
      const namespace = await createNamespace('move-rename-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false);

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt' } });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('move-nest-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['dest'], false);

      expect(result.finalPath).toBe('/dest/a.txt');
      const moved = await getRepo().resolvePath(namespace.id, root!.id, ['dest', 'a.txt']);
      expect(moved).toMatchObject({ name: 'a.txt' });
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('move-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['x', 'y', 'a.txt'], true);

      expect(result.finalPath).toBe('/x/y/a.txt');
      const dir = await getRepo().resolvePath(namespace.id, root!.id, ['x', 'y']);
      expect(dir).toMatchObject({ type: 'DIRECTORY' });
    });

    it('destinationParents=false로 목적지 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-no-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 file이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('목적지 디렉터리 아래 동일 이름이 이미 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-nest-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dest = await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, dest.node.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['dest'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('디렉터리를 자기 자신 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(getRepo().moveNode(namespace.id, root!.id, ['a'], ['a'], false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
    });

    it('디렉터리를 자기 subtree 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-subtree-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(getRepo().moveNode(namespace.id, root!.id, ['a'], ['a', 'b'], false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
    });

    it('file을 정확히 같은 경로로 move하면 자신과 충돌해 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-file-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['a.txt'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-missing-source-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['missing.txt'], ['x.txt'], false),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('removeEmptyDirectory', () => {
    it('빈 디렉터리를 삭제한다', async () => {
      const namespace = await createNamespace('rmdir-empty-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a']);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
    });

    it('비어 있지 않은 디렉터리는 VfsDirectoryNotEmptyError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-nonempty-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await createFile(namespace.id, dir.node.id, 'x.txt');

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a'])).rejects.toThrow(
        VfsDirectoryNotEmptyError,
      );
    });

    it('FILE 대상이면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a.txt'])).rejects.toThrow(
        VfsNotDirectoryError,
      );
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['missing'])).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });
  });

  describe('removeNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('FILE을 삭제하면 Blob reference_count를 감소시킨다', async () => {
      const namespace = await createNamespace('rm-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await getRepo().removeNode(namespace.id, root!.id, ['a.txt'], false, UNLIMITED);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
      const blob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });
      expect(blob.referenceCount).toBe(0);
      expect(blob.zeroSince).not.toBeNull();
    });

    it('recursive=false로 directory를 삭제하려 하면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rm-dir-non-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(getRepo().removeNode(namespace.id, root!.id, ['a'], false, UNLIMITED)).rejects.toThrow(
        VfsIsDirectoryError,
      );
    });

    it('recursive=true면 하위 트리를 모두 삭제하고 각 file의 Blob 참조를 줄인다', async () => {
      const namespace = await createNamespace('rm-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      await getRepo().removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
      const blobRepo = getDs().getRepository(BlobEntity);
      const blobB = await blobRepo.findOneByOrFail({ id: fileB.blobId as string });
      const blobD = await blobRepo.findOneByOrFail({ id: fileD.blobId as string });
      expect(blobB.referenceCount).toBe(0);
      expect(blobB.zeroSince).not.toBeNull();
      expect(blobD.referenceCount).toBe(0);
      expect(blobD.zeroSince).not.toBeNull();
    });

    it('같은 Blob을 여러 Node가 참조하면 recursive delete가 감소량을 합산한다', async () => {
      const namespace = await createNamespace('rm-shared-blob-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const blobRepo = getDs().getRepository(BlobEntity);
      const sharedBlob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/00/${randomUUID()}`,
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '0'.repeat(64),
          referenceCount: 2,
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'x.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'y.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );

      await getRepo().removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(0);
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rm-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().removeNode(namespace.id, root!.id, ['missing.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('STORIX_MAX_SYNC_DELETE_NODES를 넘으면 작업 시작 전에 VfsDeleteLimitExceededError를 던지고 아무것도 삭제하지 않는다', async () => {
      const namespace = await createNamespace('rm-limit-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(getRepo().removeNode(namespace.id, root!.id, ['big'], true, 2)).rejects.toThrow(
        VfsDeleteLimitExceededError,
      );

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['big'])).not.toBeNull();
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['big', '1.txt'])).not.toBeNull();
    });
  });

  describe('copyNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('COW: source와 같은 blob을 참조하는 새 Node를 만들고 reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-cow-ns');
      const root = await getRepo().getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt', blobId: source.blobId } });
      const blob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: source.blobId as string });
      expect(blob.referenceCount).toBe(2);
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: source.blobId,
      });
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('cp-nest-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['dest'], false, UNLIMITED);

      expect(result.finalPath).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('cp-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(
        namespace.id,
        root!.id,
        ['a.txt'],
        ['x', 'y', 'a.txt'],
        true,
        UNLIMITED,
      );

      expect(result.finalPath).toBe('/x/y/a.txt');
    });

    it('destinationParents=false로 목적지 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('cp-no-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 파일이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('cp-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('디렉터리를 자기 자신 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a'], ['a'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-subtree-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a'], ['a', 'b'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('recursive: 하위 트리를 전부 복사하고 각 file의 Blob reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect(result.finalPath).toBe('/a2');
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a2', 'b.txt'])).toMatchObject({
        blobId: fileB.blobId,
      });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a2', 'c', 'd.txt'])).toMatchObject({
        blobId: fileD.blobId,
      });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a', 'b.txt'])).not.toBeNull();
      const blobRepo = getDs().getRepository(BlobEntity);
      expect((await blobRepo.findOneByOrFail({ id: fileB.blobId as string })).referenceCount).toBe(2);
      expect((await blobRepo.findOneByOrFail({ id: fileD.blobId as string })).referenceCount).toBe(2);
    });

    it('같은 Blob을 여러 Node가 참조하는 subtree를 복사하면 증가량을 합산한다', async () => {
      const namespace = await createNamespace('cp-shared-blob-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const blobRepo = getDs().getRepository(BlobEntity);
      const sharedBlob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/00/${randomUUID()}`,
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '0'.repeat(64),
          referenceCount: 2,
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'x.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'y.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );

      await getRepo().copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(4);
    });

    it('write-after-copy: 복사된 Node를 write하면 새 Blob으로 교체되고 원본은 영향받지 않는다', async () => {
      const namespace = await createNamespace('cp-detach-ns');
      const root = await getRepo().getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);
      const sharedBlobId = source.blobId as string;
      const copied = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);

      const outcome = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['b.txt'],
        false,
        makeBlobData({ size: '9' }),
        copied!.version,
        false,
      );

      expect(outcome).toMatchObject({ kind: 'replaced', node: { size: '9' } });
      const blobRepo = getDs().getRepository(BlobEntity);
      const shared = await blobRepo.findOneByOrFail({ id: sharedBlobId });
      expect(shared.referenceCount).toBe(1);
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: sharedBlobId,
      });
      const b = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(b!.blobId).not.toBe(sharedBlobId);
    });

    it('독립적으로 업로드한 동일 content는 deduplicate하지 않는다', async () => {
      const namespace = await createNamespace('cp-no-dedup-ns');
      const root = await getRepo().getRoot(namespace.id);
      const sha256 = '1'.repeat(64);

      const first = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ sha256 }),
        null,
        false,
      );
      const second = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['b.txt'],
        false,
        makeBlobData({ sha256 }),
        null,
        false,
      );

      expect(first.kind).toBe('created');
      expect(second.kind).toBe('created');
      const aNode = await getRepo().resolvePath(namespace.id, root!.id, ['a.txt']);
      const bNode = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(aNode!.blobId).not.toBe(bNode!.blobId);
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('cp-missing-source-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['missing.txt'], ['x.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('STORIX_MAX_SYNC_COPY_NODES를 넘으면 작업 시작 전에 VfsCopyLimitExceededError를 던지고 아무것도 만들지 않는다', async () => {
      const namespace = await createNamespace('cp-limit-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(getRepo().copyNode(namespace.id, root!.id, ['big'], ['copy'], false, 2)).rejects.toThrow(
        VfsCopyLimitExceededError,
      );

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['copy'])).toBeNull();
    });
  });

  describe('결과 경로 길이', () => {
    it('기존 디렉터리에 basename을 붙인 이동 결과가 4096바이트를 넘으면 무변경이다', async () => {
      const namespace = await createNamespace('move-result-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(254)] as string[];
      expect(Buffer.byteLength(`/${destination.join('/')}/a`, 'utf8')).toBe(4097);
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      await createFile(namespace.id, root.id, 'a');
      const before = await captureState(namespace.id);

      await expect(getRepo().moveNode(namespace.id, root.id, ['a'], destination, false)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('디렉터리 자식의 복사 결과만 한도를 넘고 부모를 자동 생성해도 전체가 무변경이다', async () => {
      const namespace = await createNamespace('copy-child-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().ensureDirectory(namespace.id, root.id, ['s'], false);
      await createFile(namespace.id, source.node.id, 'x');
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253), 's'] as string[];
      expect(Buffer.byteLength(`/${destination.join('/')}`, 'utf8')).toBe(4096);
      expect(Buffer.byteLength(`/${destination.join('/')}/x`, 'utf8')).toBe(4098);
      const before = await captureState(namespace.id);

      await expect(getRepo().copyNode(namespace.id, root.id, ['s'], destination, true, 1000)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('디렉터리 이동에서 자식 경로만 초과해도 무변경이다', async () => {
      const namespace = await createNamespace('move-child-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().ensureDirectory(namespace.id, root.id, ['s'], false);
      await createFile(namespace.id, source.node.id, 'x');
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253)] as string[];
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      const before = await captureState(namespace.id);

      await expect(getRepo().moveNode(namespace.id, root.id, ['s'], destination, false)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('결과 경로가 정확히 4096바이트인 이동은 허용한다', async () => {
      const namespace = await createNamespace('move-path-limit-boundary-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253)] as string[];
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      await createFile(namespace.id, root.id, 'a');

      const result = await getRepo().moveNode(namespace.id, root.id, ['a'], destination, false);
      expect(Buffer.byteLength(result.finalPath, 'utf8')).toBe(4096);
      expect(await getRepo().resolvePath(namespace.id, root.id, [...destination, 'a'])).not.toBeNull();
    });
  });

  describe('getBlobStorageInfo', () => {
    it('존재하는 blob의 storage key와 encryptionIv를 반환한다', async () => {
      const namespace = await createNamespace('blob-key-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');
      const expected = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });

      const info = await getRepo().getBlobStorageInfo(namespace.id, file.blobId as string);

      expect(info).toEqual({ storageKey: expected.storageKey, encryptionIv: expected.encryptionIv });
    });

    it('존재하지 않는 blobId는 null을 반환한다', async () => {
      const namespace = await createNamespace('blob-key-missing-ns');

      const info = await getRepo().getBlobStorageInfo(namespace.id, randomUUID());

      expect(info).toBeNull();
    });
  });
}
