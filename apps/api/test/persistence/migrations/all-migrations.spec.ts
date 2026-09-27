import { ALL_MIGRATIONS } from '../../../src/persistence/migrations/all-migrations.js';

describe('ALL_MIGRATIONS', () => {
  it('마이그레이션을 타임스탬프 오름차순으로 나열한다', () => {
    const names = ALL_MIGRATIONS.map((Migration) => new Migration().name);

    expect(names).toEqual([
      'InitSchema1788637362016',
      'AddIdempotencyKey1788700000000',
      'AddBlobZeroSince1788800000000',
      'AddAuditLog1789200000000',
      'AddGcState1789300000000',
      'AddVfsMutationReceipt1789400000000',
      'AddVfsSnapshots1790400000000',
      'AddNamespaceLogicalQuota1791400000000',
      'AddVfsSnapshotListIndex1791500000000',
      'AddAuditLogSnapshotId1791600000000',
      'AddVfsUploadSessions1791700000000',
      'AddUploadCreationExpiry1791700000001',
      'AddUploadFinalizeLeaseToken1791700000002',
      'AddUploadCreationRequestId1791700000003',
      'AddUploadPartLease1791700000004',
      'AddUploadChecksumFailure1791700000005',
      'AddVfsChangeFeed1791700000006',
      'AddVfsTrash1791700000007',
      'AddAuditLogTrashId1791700000008',
    ]);
  });
});
