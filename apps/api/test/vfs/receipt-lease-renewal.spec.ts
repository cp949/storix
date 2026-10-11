// receipt lease 갱신 실패를 가짜 repository로 확인한다.
// 검증 규칙은 docs/design/02-receipt-error-replay.md의 범위와 용어를 따른다.
import { jest } from '@jest/globals';
import { startLeaseRenewal } from '../../src/vfs/receipt-lease-renewal.js';
import type {
  ReceiptIdentity,
  VfsMutationReceiptRepository,
} from '../../src/persistence/vfs-mutation-receipt.repository.js';

// 짧은 lease 갱신 간격으로 소유권 상실 관측과 timer 정리를 검증한다.
describe('receipt lease 갱신', () => {
  const identity: ReceiptIdentity = { namespaceId: 'ns', scope: 'scope', key: 'key' };

  it('갱신 실패를 owner 소유권 상실로 표시한다', async () => {
    const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
    process.env.STORIX_MUTATION_LEASE_SECONDS = '1';
    const receipts = { renew: jest.fn(async () => false) } as unknown as VfsMutationReceiptRepository;
    const lease = startLeaseRenewal(receipts, identity, 1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await lease.stop();
    if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
    else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
    expect(lease.lost).toBe(true);
  });
});
