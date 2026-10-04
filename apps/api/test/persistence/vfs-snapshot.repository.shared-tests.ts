import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../../src/persistence/vfs-snapshot.repository.js';
import { VfsQuotaExceededError } from '../../src/vfs/vfs.errors.js';

export function runSnapshotRepositoryTests(
  context: () => {
    dataSource: DataSource;
    nodes: VfsNodeRepository;
    snapshots: VfsSnapshotRepository;
  },
): void {
  const ds = () => context().dataSource;
  async function fixture() {
    const namespace = await new NamespaceProvisioningRepository(ds()).createWithRoot(
      randomUUID(),
      randomUUID(),
    );
    const root = (await context().nodes.getRoot(namespace.id))!;
    return { namespace, root };
  }
  async function file(namespaceId: string, parentId: string, name: string, existingBlob?: BlobEntity) {
    const blob =
      existingBlob ??
      (await ds()
        .getRepository(BlobEntity)
        .save({
          namespaceId,
          storageKey: `blobs/${randomUUID()}`,
          size: '7',
          mimeType: 'text/plain',
          sha256: '0'.repeat(64),
          referenceCount: 1,
        }));
    const node = await ds().getRepository(VfsNodeEntity).save({
      namespaceId,
      parentId,
      name,
      type: 'FILE',
      blobId: blob.id,
      size: '7',
      mimeType: 'text/plain',
    });
    await ds().getRepository(NamespaceEntity).increment({ id: namespaceId }, 'liveFileByteCount', 7);
    await ds().getRepository(NamespaceEntity).increment({ id: namespaceId }, 'liveNodeCount', 1);
    await ds()
      .getRepository(VfsNodeEntity)
      .createQueryBuilder()
      .update(VfsNodeEntity)
      .set({
        childFileCount: () => 'child_file_count + 1',
        version: () => 'version',
        updatedAt: () => 'updated_at',
      })
      .where('id = :parentId', { parentId })
      .execute();
    return { node, blob };
  }
  async function capture(
    namespaceId: string,
    rootId: string,
    segments: string[],
    kind: 'FILE' | 'TREE' = 'FILE',
    maxNodes = 1000,
  ) {
    return (
      await context().nodes.withMutation(namespaceId, rootId, async (tx) => {
        const rows = await context().nodes.captureSnapshotRows(tx, segments, maxNodes);
        return context().snapshots.capture(tx, { kind, sourcePath: `/${segments.join('/')}`, rows });
      })
    ).value;
  }
  async function usage(namespaceId: string) {
    const ns = await ds().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
    return [ns.retainedSnapshotNodeCount, String(ns.retainedSnapshotByteCount)];
  }
  async function empty(namespaceId: string, blobId: string, refs = 1) {
    expect(await ds().getRepository(VfsSnapshotEntity).countBy({ namespaceId })).toBe(0);
    expect(await ds().getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId })).toBe(0);
    expect(await usage(namespaceId)).toEqual([0, '0']);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blobId })).referenceCount).toBe(refs);
  }
  it('FILE capture pins one immutable manifest entry and accounts logical usage', async () => {
    const { namespace, root } = await fixture();
    const { node, blob } = await file(namespace.id, root.id, 'a');
    const snapshot = await capture(namespace.id, root.id, ['a']);
    expect(snapshot).toMatchObject({
      kind: 'FILE',
      rootNodeId: node.id,
      sha256: blob.sha256,
      nodeCount: 1,
      logicalBytes: '7',
    });
    expect(await context().snapshots.get(namespace.id, snapshot.id)).toEqual(snapshot);
    expect(await usage(namespace.id)).toEqual([1, '7']);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount).toBe(2);
    await context().nodes.withMutation(namespace.id, root.id, async (tx) => {
      expect(await context().snapshots.findForUpdate(tx, namespace.id, snapshot.id)).toMatchObject({
        id: snapshot.id,
      });
      expect(await context().snapshots.getFileEntry(tx, snapshot.id)).toMatchObject({
        relativePath: '.',
        pathKey: '2e',
        blobId: blob.id,
        sourceNodeId: node.id,
        size: '7',
        mimeType: 'text/plain',
      });
    });
    expect((await context().nodes.getRoot(namespace.id))!.version).toBe(root.version);
  });
  it('lists only immutable FILE snapshots by root node with one page query and stable keyset boundaries', async () => {
    const { namespace, root } = await fixture();
    const { node, blob } = await file(namespace.id, root.id, 'listed');
    const first = await capture(namespace.id, root.id, ['listed']);
    const second = await capture(namespace.id, root.id, ['listed']);
    const tree = await capture(namespace.id, root.id, [], 'TREE');
    const otherNamespace = await fixture();
    const foreign = await file(otherNamespace.namespace.id, otherNamespace.root.id, 'listed');
    await capture(otherNamespace.namespace.id, otherNamespace.root.id, ['listed']);
    if (ds().options.type === 'postgres') {
      await ds().query(`UPDATE vfs_snapshot SET created_at = $1::timestamptz WHERE id = $2::uuid`, [
        '2026-09-26T01:02:03.123456Z',
        first.id,
      ]);
      await ds().query(`UPDATE vfs_snapshot SET created_at = $1::timestamptz WHERE id = $2::uuid`, [
        '2026-09-26T01:02:03.123789Z',
        second.id,
      ]);
      await ds().query(`UPDATE vfs_snapshot SET created_at = $1::timestamptz WHERE id = $2::uuid`, [
        '2026-09-26T01:02:03.123789Z',
        tree.id,
      ]);
    } else {
      const same = new Date('2026-09-26T01:02:03.004Z');
      await ds().getRepository(VfsSnapshotEntity).update([first.id, second.id, tree.id], { createdAt: same });
    }
    await ds().getRepository(NamespaceEntity).update(namespace.id, { trashEnabled: true });
    await context().nodes.removeNode(namespace.id, root.id, ['listed'], false, 1000);

    const p1 = await context().snapshots.listFileSnapshots(namespace.id, node.id, null, 1);
    expect(p1.items).toHaveLength(1);
    expect(p1.nextBoundary).not.toBeNull();
    const p2 = await context().snapshots.listFileSnapshots(namespace.id, node.id, p1.nextBoundary, 1);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextBoundary).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((item) => item.snapshotId))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(
      [...p1.items, ...p2.items].every((item) => item.sha256 === blob.sha256 && item.logicalBytes === '7'),
    ).toBe(true);
    expect(
      (await context().snapshots.listFileSnapshots(namespace.id, foreign.node.id, null, 10)).items,
    ).toEqual([]);
    expect((await context().snapshots.listFileSnapshots(namespace.id, randomUUID(), null, 10)).items).toEqual(
      [],
    );
    expect(
      (await context().snapshots.listFileSnapshots(otherNamespace.namespace.id, node.id, null, 10)).items,
    ).toEqual([]);
  });
  it('호스트 시간대가 UTC가 아니어도 FILE snapshot 목록의 createdAt은 저장된 UTC 시각이다', async () => {
    const { namespace, root } = await fixture();
    const { node } = await file(namespace.id, root.id, 'tz-listed');
    const snapshot = await capture(namespace.id, root.id, ['tz-listed']);
    const stored = new Date('2026-09-26T01:02:03.004Z');
    await ds().getRepository(VfsSnapshotEntity).update(snapshot.id, { createdAt: stored });

    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Seoul';
    try {
      const page = await context().snapshots.listFileSnapshots(namespace.id, node.id, null, 10);
      expect(page.items.map((item) => item.createdAt.toISOString())).toEqual([stored.toISOString()]);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
  it('rejects kind/source mismatches and missing capture paths', async () => {
    const { namespace, root } = await fixture();
    const { blob } = await file(namespace.id, root.id, 'a');
    await expect(capture(namespace.id, root.id, ['a'], 'TREE')).rejects.toThrow();
    await expect(capture(namespace.id, root.id, [], 'FILE')).rejects.toThrow();
    await expect(capture(namespace.id, root.id, ['missing'])).rejects.toMatchObject({ status: 404 });
    await empty(namespace.id, blob.id);
  });
  it('rejects duplicate manifest paths before persisting entries or pinning Blobs', async () => {
    const { namespace, root } = await fixture();
    const dir = await context().nodes.ensureDirectory(namespace.id, root.id, ['dir'], false);
    const { blob } = await file(namespace.id, dir.node.id, 'a');
    await expect(
      context().nodes.withMutation(namespace.id, root.id, async (tx) => {
        const rows = await context().nodes.captureSnapshotRows(tx, ['dir'], 1000);
        return context().snapshots.capture(tx, {
          kind: 'TREE',
          sourcePath: '/dir',
          rows: [rows[0], rows[1], rows[1]],
        });
      }),
    ).rejects.toThrow();
    await empty(namespace.id, blob.id);
  });
  it('TREE includes dot and nested paths; repeated Blob IDs charge every occurrence', async () => {
    const { namespace, root } = await fixture();
    const dir = await context().nodes.ensureDirectory(namespace.id, root.id, ['dir'], false);
    const { blob } = await file(namespace.id, dir.node.id, 'a');
    await file(namespace.id, dir.node.id, 'b', blob);
    await ds().getRepository(BlobEntity).update(blob.id, { referenceCount: 2 });
    const snapshot = await capture(namespace.id, root.id, [], 'TREE');
    expect(snapshot).toMatchObject({ nodeCount: 4, logicalBytes: '14' });
    expect(
      (await context().snapshots.listEntries(namespace.id, snapshot.id, null, 10)).entries.map(
        (x) => x.relativePath,
      ),
    ).toEqual(['.', 'dir', 'dir/a', 'dir/b']);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount).toBe(4);
    expect(await usage(namespace.id)).toEqual([4, '14']);
    await context().nodes.withMutation(namespace.id, root.id, async (tx) => {
      expect(await context().snapshots.getFileEntry(tx, snapshot.id)).toBeNull();
    });
  });
  it('recursive traversal returns at most maxNodes plus one before any writes', async () => {
    const { namespace, root } = await fixture();
    for (let i = 0; i < 12; i++) await file(namespace.id, root.id, `file${i}`);
    await context().nodes.withMutation(namespace.id, root.id, async (tx) => {
      expect(await context().nodes.captureSnapshotRows(tx, [], 2)).toHaveLength(3);
    });
    expect(await usage(namespace.id)).toEqual([0, '0']);
  });
  it.each([
    { maxSyncSnapshotNodes: 1 },
    { maxSnapshotBytes: '6' },
    { maxRetainedSnapshotNodes: 1 },
    { maxRetainedSnapshotBytes: '6' },
  ])('limit overrun %j leaves no metadata, manifests, references or usage', async (override) => {
    const { namespace, root } = await fixture();
    const { blob } = await file(namespace.id, root.id, 'a');
    await ds().getRepository(NamespaceEntity).update(namespace.id, override);
    await expect(capture(namespace.id, root.id, [], 'TREE')).rejects.toMatchObject({ status: 413 });
    await empty(namespace.id, blob.id);
  });
  it('global ceiling remains effective when namespace overrides are higher', async () => {
    const { namespace, root } = await fixture();
    const { blob } = await file(namespace.id, root.id, 'a');
    await ds().getRepository(NamespaceEntity).update(namespace.id, { maxSnapshotBytes: '100' });
    const previous = process.env.STORIX_MAX_SNAPSHOT_BYTES;
    process.env.STORIX_MAX_SNAPSHOT_BYTES = '6';
    try {
      await expect(capture(namespace.id, root.id, ['a'])).rejects.toMatchObject({ status: 413 });
    } finally {
      if (previous === undefined) delete process.env.STORIX_MAX_SNAPSHOT_BYTES;
      else process.env.STORIX_MAX_SNAPSHOT_BYTES = previous;
    }
    await empty(namespace.id, blob.id);
  });
  it('a zero-reference Blob cannot be revived and earlier grouped increments roll back', async () => {
    const { namespace, root } = await fixture();
    const first = await file(namespace.id, root.id, 'a');
    const dead = await file(namespace.id, root.id, 'b');
    await ds().getRepository(BlobEntity).update(dead.blob.id, { referenceCount: 0, zeroSince: new Date() });
    await expect(capture(namespace.id, root.id, [], 'TREE')).rejects.toThrow();
    await empty(namespace.id, first.blob.id);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: dead.blob.id })).referenceCount).toBe(
      0,
    );
  });
  it('cross-namespace Blob input is rejected without side effects', async () => {
    const { namespace, root } = await fixture();
    const own = await file(namespace.id, root.id, 'a');
    const other = await fixture();
    const foreign = await file(other.namespace.id, other.root.id, 'b');
    await expect(
      context().nodes.withMutation(namespace.id, root.id, async (tx) => {
        const rows = await context().nodes.captureSnapshotRows(tx, ['a'], 1000);
        return context().snapshots.capture(tx, {
          kind: 'FILE',
          sourcePath: '/a',
          rows: rows.map((row) => ({ ...row, blobId: foreign.blob.id })),
        });
      }),
    ).rejects.toThrow();
    await empty(namespace.id, own.blob.id);
    expect(
      (await ds().getRepository(BlobEntity).findOneByOrFail({ id: foreign.blob.id })).referenceCount,
    ).toBe(1);
  });
  it('namespace-scoped metadata, locks and listings conceal other snapshots', async () => {
    const own = await fixture();
    const other = await fixture();
    await file(own.namespace.id, own.root.id, 'a');
    const snapshot = await capture(own.namespace.id, own.root.id, ['a']);
    expect(await context().snapshots.get(other.namespace.id, snapshot.id)).toBeNull();
    expect(
      (await context().snapshots.listEntries(other.namespace.id, snapshot.id, null, 10)).entries,
    ).toEqual([]);
    await context().nodes.withMutation(other.namespace.id, other.root.id, async (tx) => {
      expect(await context().snapshots.findForUpdate(tx, other.namespace.id, snapshot.id)).toBeNull();
      expect(await context().snapshots.findForUpdate(tx, own.namespace.id, snapshot.id)).toBeNull();
      expect(await context().snapshots.getFileEntry(tx, snapshot.id)).toBeNull();
    });
  });
  it('delete releases grouped occurrences once and timestamps the transition to zero', async () => {
    const { namespace, root } = await fixture();
    await ds().getRepository(NamespaceEntity).update(namespace.id, { trashEnabled: true });
    const { blob } = await file(namespace.id, root.id, 'a');
    await file(namespace.id, root.id, 'b', blob);
    await ds().getRepository(BlobEntity).update(blob.id, { referenceCount: 2 });
    const snapshot = await capture(namespace.id, root.id, [], 'TREE');
    const trashedA = await context().nodes.removeNode(namespace.id, root.id, ['a'], false, 1000);
    const trashedB = await context().nodes.removeNode(namespace.id, root.id, ['b'], false, 1000);
    if (!trashedA || !trashedB) throw new Error('Trash must be enabled for purge coverage');
    await context().nodes.withMutation(namespace.id, root.id, async (tx) => {
      const locked = (await context().snapshots.findForUpdate(tx, namespace.id, snapshot.id))!;
      await context().snapshots.remove(tx, locked);
      await context().snapshots.remove(tx, locked);
    });
    await empty(namespace.id, blob.id, 2);
    await context().nodes.purgeTrashItem(namespace.id, trashedA);
    await context().nodes.purgeTrashItem(namespace.id, trashedB);
    await empty(namespace.id, blob.id, 0);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).zeroSince).toBeInstanceOf(
      Date,
    );
  });

  it('counts each retained snapshot in the namespace total and rolls back an over-limit capture', async () => {
    const { namespace, root } = await fixture();
    await ds().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '13' });
    const live = await context().nodes.putFileContent(
      namespace.id,
      root.id,
      ['a'],
      false,
      {
        storageKey: `blobs/${randomUUID()}`,
        size: '7',
        mimeType: 'text/plain',
        sha256: '0'.repeat(64),
        encryptionIv: null,
      },
      null,
      false,
    );

    await expect(capture(namespace.id, root.id, ['a'])).rejects.toThrow(VfsQuotaExceededError);
    expect(await ds().getRepository(VfsSnapshotEntity).countBy({ namespaceId: namespace.id })).toBe(0);
    expect(
      String(
        (await ds().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
          .retainedSnapshotByteCount,
      ),
    ).toBe('0');
    expect(
      String(
        (await ds().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id })).liveFileByteCount,
      ),
    ).toBe('7');
    expect(
      (await ds().getRepository(BlobEntity).findOneByOrFail({ id: live.node.blobId! })).referenceCount,
    ).toBe(1);
  });

  it('snapshot quota 제외 시 snapshot 생성으로 quota가 초과되어도 manifest를 보존한다', async () => {
    const { namespace, root } = await fixture();
    await ds()
      .getRepository(NamespaceEntity)
      .update({ id: namespace.id }, { maxTotalLogicalBytes: '13', excludeSnapshotsFromQuota: true });
    await file(namespace.id, root.id, 'a');

    const snapshot = await capture(namespace.id, root.id, ['a']);

    expect(snapshot.logicalBytes).toBe('7');
    expect(await ds().getRepository(VfsSnapshotEntity).countBy({ namespaceId: namespace.id })).toBe(1);
    expect(
      String(
        (await ds().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
          .retainedSnapshotByteCount,
      ),
    ).toBe('7');
  });
  it('receipt-stage failure rolls back snapshot accounting, manifest and Blob pin', async () => {
    const { namespace, root } = await fixture();
    const { blob } = await file(namespace.id, root.id, 'a');
    await expect(
      context().nodes.withMutation(
        namespace.id,
        root.id,
        async (tx) => {
          const rows = await context().nodes.captureSnapshotRows(tx, ['a'], 1000);
          return context().snapshots.capture(tx, { kind: 'FILE', sourcePath: '/a', rows });
        },
        async () => {
          throw new Error('receipt failure');
        },
      ),
    ).rejects.toThrow('receipt failure');
    await empty(namespace.id, blob.id);
  });
  it('bytewise pagination covers ASCII, prefixes, and multibyte paths exactly once', async () => {
    const { namespace, root } = await fixture();
    for (const name of ['한', 'é', 'é', 'a.b', 'a', 'Z', '😀'])
      await context().nodes.ensureDirectory(namespace.id, root.id, [name], false);
    await context().nodes.ensureDirectory(namespace.id, root.id, ['a', 'z'], false);
    const snapshot = await capture(namespace.id, root.id, [], 'TREE');
    const paths: string[] = [];
    let after: string | null = null;
    do {
      const page = await context().snapshots.listEntries(namespace.id, snapshot.id, after, 2);
      paths.push(...page.entries.map((entry) => entry.relativePath));
      after = page.nextPathKey;
    } while (after);
    expect(paths).toEqual(['.', 'Z', 'a', 'a.b', 'a/z', 'é', 'é', '한', '😀']);
  });
  it.each([{ maxRetainedSnapshotNodes: 1 }, { maxRetainedSnapshotBytes: '7' }])(
    'captures respect retained ceilings (parallel attempts) %j',
    async (limits) => {
      const { namespace, root } = await fixture();
      const { blob } = await file(namespace.id, root.id, 'a');
      await ds().getRepository(NamespaceEntity).update(namespace.id, limits);
      // PostgreSQL은 root lock, SQLite는 쿼리 게이트가 두 capture를 직렬화한다.
      const results = await Promise.allSettled([
        capture(namespace.id, root.id, ['a']),
        capture(namespace.id, root.id, ['a']),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { status: 413 } });
      expect(await usage(namespace.id)).toEqual([1, '7']);
      expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount).toBe(2);
    },
  );
}
