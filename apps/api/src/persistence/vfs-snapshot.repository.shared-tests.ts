import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsSnapshotEntity } from './entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from './entities/vfs-snapshot-entry.entity.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { VfsSnapshotRepository } from './vfs-snapshot.repository.js';

export function runSnapshotRepositoryTests(
  context: () => {
    dataSource: DataSource;
    nodes: VfsNodeRepository;
    snapshots: VfsSnapshotRepository;
  },
): void {
  const ds = () => context().dataSource;
  async function fixture() {
    const namespace = await new NamespaceProvisioningRepository(ds()).createWithRoot(randomUUID());
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
    expect(snapshot).toMatchObject({ kind: 'FILE', rootNodeId: node.id, nodeCount: 1, logicalBytes: '7' });
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
    const { blob } = await file(namespace.id, root.id, 'a');
    await file(namespace.id, root.id, 'b', blob);
    await ds().getRepository(BlobEntity).update(blob.id, { referenceCount: 2 });
    const snapshot = await capture(namespace.id, root.id, [], 'TREE');
    await context().nodes.removeNode(namespace.id, root.id, ['a'], false, 1000);
    await context().nodes.removeNode(namespace.id, root.id, ['b'], false, 1000);
    await context().nodes.withMutation(namespace.id, root.id, async (tx) => {
      const locked = (await context().snapshots.findForUpdate(tx, namespace.id, snapshot.id))!;
      await context().snapshots.remove(tx, locked);
      await context().snapshots.remove(tx, locked);
    });
    await empty(namespace.id, blob.id, 0);
    expect((await ds().getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).zeroSince).toBeInstanceOf(
      Date,
    );
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
