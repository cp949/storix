import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { randomUUID } from 'node:crypto';
import { BlobEntity } from '../../../src/persistence/entities/blob.entity.js';
import { toPreconditionCurrent } from '../../../src/vfs/dto/node-response.dto.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import { VfsNodeNotFoundError, VfsPreconditionFailedError } from '../../../src/vfs/vfs.errors.js';

export function runConditionalMutationsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const {
    getDs,
    getRepo,
    createNamespace,
    createFile,
    captureState,
    runSameConditionAttempts,
    makeBlobData,
  } = helpers;
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
          expect(blobs.map((blob) => blob.referenceCount)).toEqual([1]);
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

    it.each(['move', 'copy'] as const)(
      '%s exact 목적지가 이미 있으면 412로 거절하고 상태를 바꾸지 않는다',
      async (kind) => {
        const namespace = await createNamespace(`exact-${kind}-${randomUUID()}`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await createFile(namespace.id, root.id, 'source');
        await createFile(namespace.id, root.id, 'file');
        await getRepo().ensureDirectory(namespace.id, root.id, ['directory'], false);
        const source = (await getRepo().resolvePath(namespace.id, root.id, ['source']))!;
        for (const path of ['/', '/file', '/directory']) {
          const segments = path.split('/').filter(Boolean);
          const occupied = segments.length
            ? (await getRepo().resolvePath(namespace.id, root.id, segments))!
            : (await getRepo().getRoot(namespace.id))!;
          const before = await captureState(namespace.id);
          await expect(
            getRepo().withMutation(namespace.id, root.id, (tx) =>
              getRepo().applyConditionalMutation(tx, {
                kind,
                source: '/source',
                sourceSegments: ['source'],
                destination: path,
                destinationSegments: segments,
                sourceRevision: encodeRevision(source),
                destinationAbsent: true,
                destinationResolution: 'exact',
              }),
            ),
          ).rejects.toMatchObject({
            status: 412,
            path,
            current: toPreconditionCurrent(occupied, path),
          });
          expect(await captureState(namespace.id)).toEqual(before);
        }
        const beforeMissingParent = await captureState(namespace.id);
        await expect(
          getRepo().withMutation(namespace.id, root.id, (tx) =>
            getRepo().applyConditionalMutation(tx, {
              kind,
              source: '/source',
              sourceSegments: ['source'],
              destination: '/missing/leaf',
              destinationSegments: ['missing', 'leaf'],
              sourceRevision: encodeRevision(source),
              destinationAbsent: true,
              destinationResolution: 'exact',
            }),
          ),
        ).rejects.toMatchObject({ status: 404 });
        expect(await captureState(namespace.id)).toEqual(beforeMissingParent);
        const beforeSuccess = await captureState(namespace.id);
        expect(beforeSuccess.nodes.some((node) => node.name === 'leaf')).toBe(false);
        const created = await getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind,
            source: '/source',
            sourceSegments: ['source'],
            destination: '/directory/leaf',
            destinationSegments: ['directory', 'leaf'],
            sourceRevision: encodeRevision(source),
            destinationAbsent: true,
            destinationResolution: 'exact',
          }),
        );
        expect(created.value.resource?.path).toBe('/directory/leaf');
      },
    );

    it.each(['move', 'copy'] as const)(
      '%s selector를 생략하면 기존 디렉터리 배치를 유지한다',
      async (kind) => {
        const namespace = await createNamespace(`legacy-${kind}-${randomUUID()}`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await createFile(namespace.id, root.id, 'source');
        await getRepo().ensureDirectory(namespace.id, root.id, ['directory'], false);
        const source = (await getRepo().resolvePath(namespace.id, root.id, ['source']))!;
        const result = await getRepo().withMutation(namespace.id, root.id, (tx) =>
          getRepo().applyConditionalMutation(tx, {
            kind,
            source: '/source',
            sourceSegments: ['source'],
            destination: '/directory',
            destinationSegments: ['directory'],
            sourceRevision: encodeRevision(source),
            destinationAbsent: true,
          }),
        );
        expect(result.value.resource?.path).toBe('/directory/source');
      },
    );

    it.each(['move', 'copy'] as const)(
      '%s exact 목적지가 자기 subtree면 412보다 409 VFS_INVALID_OPERATION이 우선한다',
      async (kind) => {
        const namespace = await createNamespace(`exact-subtree-${kind}-${randomUUID()}`);
        const root = (await getRepo().getRoot(namespace.id))!;
        await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'b'], true);
        const source = (await getRepo().resolvePath(namespace.id, root.id, ['a']))!;
        // 자기 자신과 이미 있는 하위 노드 모두 subtree 이동이므로 기존 placement와 같은 409다.
        for (const segments of [['a'], ['a', 'b']]) {
          const before = await captureState(namespace.id);
          await expect(
            getRepo().withMutation(namespace.id, root.id, (tx) =>
              getRepo().applyConditionalMutation(tx, {
                kind,
                source: '/a',
                sourceSegments: ['a'],
                destination: `/${segments.join('/')}`,
                destinationSegments: segments,
                sourceRevision: encodeRevision(source),
                destinationAbsent: true,
                destinationResolution: 'exact',
              }),
            ),
          ).rejects.toMatchObject({ status: 409, code: 'VFS_INVALID_OPERATION' });
          expect(await captureState(namespace.id)).toEqual(before);
        }
      },
    );

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
      expect(deleted.value).toMatchObject({ status: 200, resource: null, trashId: expect.any(String) });
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
}
