import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';

const RECEIPT_MS = 30 * 86400_000;

async function expireLease(dataSource: DataSource, identity: { namespaceId: string; scope: string; key: string }) {
  await dataSource.getRepository(VfsMutationReceiptEntity).update(
    {
      namespaceId: identity.namespaceId,
      scope: identity.scope,
      idempotencyKey: identity.key,
    },
    { leaseExpiresAt: new Date(Date.now() - 1000) },
  );
}

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
    const now = new Date();
    expect(await receiptRepository.claim(identity, now)).toEqual({ kind: 'owner', generation: 1 });
    const busy = await receiptRepository.claim(identity, now);
    expect(busy.kind).toBe('busy');
    if (busy.kind !== 'busy') throw new Error('Expected busy receipt claim');
    // DB에서 60초 lease를 시작한 시각은 위의 앱 now보다 조금 늦을 수 있다.
    // 올림한 Retry-After는 그 차이에 따라 60 또는 61초다.
    expect(busy.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect(busy.retryAfterSeconds).toBeLessThanOrEqual(61);
    await expireLease(dataSource, identity);
    const later = new Date();
    expect(await receiptRepository.claim(identity, later)).toEqual({ kind: 'owner', generation: 2 });
    expect(await receiptRepository.renew(identity, 1)).toBe(false);
    expect(await receiptRepository.renew(identity, 2)).toBe(true);
    await receiptRepository.release(identity, 1);
    expect((await receiptRepository.claim(identity, later)).kind).toBe('busy');
  });

  it('renews a lease using database time when the application clock jumps ahead', async () => {
    const { dataSource, receiptRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      'receipt-clock-jump-ns',
    );
    const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
    expect(await receiptRepository.claim(identity, new Date())).toEqual({ kind: 'owner', generation: 1 });

    await expireLease(dataSource, identity);
    const jumpedAhead = new Date(Date.now() + 60_000);
    expect(await receiptRepository.renew(identity, 1)).toBe(true);
    expect(await receiptRepository.claim(identity, jumpedAhead)).toMatchObject({ kind: 'busy' });
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
    const now = new Date();
    expect(await receiptRepository.claim(identity, now)).toEqual({ kind: 'owner', generation: 1 });
    await expireLease(dataSource, identity);
    expect(await receiptRepository.claim(identity, new Date())).toEqual({
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

  describe('롤백 뒤 독립 트랜잭션 완료(completeAfterRollback)', () => {
    const errorResponse = {
      status: 412,
      body: { code: 'VFS_PRECONDITION_FAILED', path: '/a', current: null, requestId: 'req-first' },
      headers: { 'x-request-id': 'req-first' },
    };

    it('오류 응답을 그대로 저장하고 보존 기한을 claim이 아닌 완료 시점부터 30일로 잡는다', async () => {
      const { dataSource, receiptRepository } = getContext();
      const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
        'receipt-error-complete-ns',
      );
      const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
      const claimedAt = new Date(Date.now() - 30_000);
      expect(await receiptRepository.claim(identity, claimedAt)).toEqual({ kind: 'owner', generation: 1 });
      const before = Date.now();
      await receiptRepository.completeAfterRollback(identity, 1, 'f'.repeat(64), 'POST', errorResponse, 9);
      const after = Date.now();

      const row = await dataSource.getRepository(VfsMutationReceiptEntity).findOneByOrFail({
        namespaceId: identity.namespaceId,
        scope: identity.scope,
        idempotencyKey: identity.key,
      });
      expect(row).toMatchObject({
        state: 'COMPLETE',
        generation: 1,
        leaseExpiresAt: null,
        method: 'POST',
        fingerprint: 'f'.repeat(64),
        responseStatus: 412,
      });
      expect(JSON.parse(row.responseBody!)).toEqual(errorResponse.body);
      expect(JSON.parse(row.responseHeaders!)).toEqual(errorResponse.headers);
      expect(Number(row.requestBodyBytes)).toBe(9);
      // 초 단위 저장 정밀도를 감안해 1초 여유를 둔다.
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + RECEIPT_MS - 1000);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + RECEIPT_MS + 1000);
      expect(row.expiresAt.getTime()).toBeGreaterThan(claimedAt.getTime() + RECEIPT_MS + 20_000);

      const replay = await receiptRepository.claim(identity, new Date(before + RECEIPT_MS - 60_000));
      expect(replay).toMatchObject({ kind: 'complete', receipt: { responseStatus: 412 } });
      expect((await receiptRepository.claim(identity, new Date(after + RECEIPT_MS + 2000))).kind).toBe(
        'owner',
      );
    });

    it('takeover 뒤의 stale generation은 완료하지 못하고 새 owner의 claim을 유지한다', async () => {
      const { dataSource, receiptRepository } = getContext();
      const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
        'receipt-error-fence-ns',
      );
      const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
      const claimedAt = new Date(Date.now() - 61_000);
      expect(await receiptRepository.claim(identity, claimedAt)).toEqual({ kind: 'owner', generation: 1 });
      await expireLease(dataSource, identity);
      expect(await receiptRepository.claim(identity, new Date())).toEqual({ kind: 'owner', generation: 2 });

      await expect(
        receiptRepository.completeAfterRollback(identity, 1, 'f'.repeat(64), 'POST', errorResponse),
      ).rejects.toThrow('VFS mutation claim lost');
      const row = await dataSource.getRepository(VfsMutationReceiptEntity).findOneByOrFail({
        namespaceId: identity.namespaceId,
        scope: identity.scope,
        idempotencyKey: identity.key,
      });
      expect(row).toMatchObject({ state: 'RESERVED', generation: 2, responseStatus: null });
    });

    it('lease가 만료된 owner는 takeover가 없어도 완료하지 못한다', async () => {
      const { dataSource, receiptRepository } = getContext();
      const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
        'receipt-error-expired-ns',
      );
      const identity = { namespaceId: namespace.id, scope: 'caller-1', key: randomUUID() };
      expect(await receiptRepository.claim(identity, new Date())).toEqual({
        kind: 'owner',
        generation: 1,
      });
      await expireLease(dataSource, identity);

      await expect(
        receiptRepository.completeAfterRollback(identity, 1, 'f'.repeat(64), 'POST', errorResponse),
      ).rejects.toThrow('VFS mutation claim lost');
      expect((await receiptRepository.claim(identity, new Date())).kind).toBe('owner');
    });
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
