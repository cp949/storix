import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { VfsMutationReceiptRepository } from './vfs-mutation-receipt.repository.js';

export function runVfsMutationReceiptSharedTests(
  getContext: () => {
    dataSource: DataSource;
    receiptRepository: VfsMutationReceiptRepository;
    nodeRepository: VfsNodeRepository;
  },
): void {
  it('allows exactly one concurrent claim owner', async () => {
    const { dataSource, receiptRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-concurrent-ns',
    );
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    const now = new Date();
    const claims = await Promise.all([
      receiptRepository.claim(identity, now),
      receiptRepository.claim(identity, now),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(['busy', 'owner']);
  });

  it('grants one owner, reports busy, and fences an expired owner', async () => {
    const { dataSource, receiptRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-lease-ns',
    );
    const key = randomUUID();
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key };
    const now = new Date('2026-09-25T00:00:00Z');
    expect(await receiptRepository.claim(identity, now)).toEqual({ kind: 'owner', generation: 1 });
    expect(await receiptRepository.claim(identity, now)).toMatchObject({
      kind: 'busy',
      retryAfterSeconds: 60,
    });
    const later = new Date(now.getTime() + 61_000);
    expect(await receiptRepository.claim(identity, later)).toEqual({ kind: 'owner', generation: 2 });
    expect(await receiptRepository.renew(identity, 1, later)).toBe(false);
    expect(await receiptRepository.renew(identity, 2, later)).toBe(true);
    await receiptRepository.release(identity, 1);
    expect((await receiptRepository.claim(identity, later)).kind).toBe('busy');
  });

  it('commits a receipt and metadata together and keeps it at least 30 days', async () => {
    const { dataSource, receiptRepository, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-commit-ns',
    );
    const root = (await nodeRepository.getRoot(namespace.id))!;
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    const now = new Date();
    expect(await receiptRepository.claim(identity, now)).toEqual({ kind: 'owner', generation: 1 });
    const response = {
      status: 201,
      body: { resource: { path: '/a' } },
      headers: { 'x-request-id': 'original' },
    };
    await nodeRepository.withMutation(
      namespace.id,
      root.id,
      (tx) => nodeRepository.ensureDirectory(namespace.id, root.id, ['a'], false, tx),
      async (tx) => receiptRepository.complete(tx, identity, 1, 'a'.repeat(64), 'POST', response, 123),
    );
    const replay = await receiptRepository.claim(identity, new Date(now.getTime() + 29 * 86400_000));
    expect(replay).toMatchObject({
      kind: 'complete',
      receipt: { responseStatus: 201, fingerprint: 'a'.repeat(64) },
    });
    if (replay.kind !== 'complete') throw new Error('expected a complete receipt');
    expect(Number(replay.receipt.requestBodyBytes)).toBe(123);
    expect(await nodeRepository.resolvePath(namespace.id, root.id, ['a'])).not.toBeNull();
  });

  it('rolls back receipt completion when the VFS transaction aborts', async () => {
    const { dataSource, receiptRepository, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-rollback-ns',
    );
    const root = (await nodeRepository.getRoot(namespace.id))!;
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    await receiptRepository.claim(identity, new Date());
    await expect(
      nodeRepository.withMutation(
        namespace.id,
        root.id,
        (tx) => nodeRepository.ensureDirectory(namespace.id, root.id, ['a'], false, tx),
        async (tx) => {
          await receiptRepository.complete(tx, identity, 1, 'b'.repeat(64), 'POST', {
            status: 201,
            body: {},
            headers: {},
          });
          throw new Error('db failure');
        },
      ),
    ).rejects.toThrow('db failure');
    expect(await nodeRepository.resolvePath(namespace.id, root.id, ['a'])).toBeNull();
    expect((await receiptRepository.claim(identity, new Date())).kind).toBe('busy');
  });

  it('prevents a stale generation from completing after takeover', async () => {
    const { dataSource, receiptRepository, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-fence-ns',
    );
    const root = (await nodeRepository.getRoot(namespace.id))!;
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    const now = new Date('2026-09-25T00:00:00Z');
    expect(await receiptRepository.claim(identity, now)).toEqual({ kind: 'owner', generation: 1 });
    expect(await receiptRepository.claim(identity, new Date(now.getTime() + 61_000))).toEqual({
      kind: 'owner',
      generation: 2,
    });
    await expect(
      nodeRepository.withMutation(
        namespace.id,
        root.id,
        (tx) => nodeRepository.ensureDirectory(namespace.id, root.id, ['a'], false, tx),
        (tx) =>
          receiptRepository.complete(tx, identity, 1, 'c'.repeat(64), 'POST', {
            status: 201,
            body: {},
            headers: {},
          }),
      ),
    ).rejects.toThrow('VFS mutation claim lost');
    expect(await nodeRepository.resolvePath(namespace.id, root.id, ['a'])).toBeNull();
  });

  it('prunes expired completed receipts and permits key reuse', async () => {
    const { dataSource, receiptRepository, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-prune-ns',
    );
    const root = (await nodeRepository.getRoot(namespace.id))!;
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    await receiptRepository.claim(identity, new Date());
    await nodeRepository.withMutation(
      namespace.id,
      root.id,
      async () => null,
      (tx) =>
        receiptRepository.complete(tx, identity, 1, 'd'.repeat(64), 'POST', {
          status: 200,
          body: {},
          headers: {},
        }),
    );
    const future = new Date(Date.now() + 31 * 86400_000);
    expect(await receiptRepository.pruneExpired(future)).toBeGreaterThanOrEqual(1);
    expect(await receiptRepository.claim(identity, future)).toEqual({ kind: 'owner', generation: 1 });
  });

  it('does not delete a new owner while two workers reclaim an expired completed key', async () => {
    const { dataSource, receiptRepository, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-reclaim-ns',
    );
    const root = (await nodeRepository.getRoot(namespace.id))!;
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    await receiptRepository.claim(identity, new Date());
    await nodeRepository.withMutation(
      namespace.id,
      root.id,
      async () => null,
      (tx) =>
        receiptRepository.complete(tx, identity, 1, 'e'.repeat(64), 'POST', {
          status: 200,
          body: {},
          headers: {},
        }),
    );
    const future = new Date(Date.now() + 31 * 86400_000);
    const claims = await Promise.all([
      receiptRepository.claim(identity, future),
      receiptRepository.claim(identity, future),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(['busy', 'owner']);
    expect((await receiptRepository.claim(identity, future)).kind).toBe('busy');
  });
}
