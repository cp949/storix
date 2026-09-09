import { ALL_MIGRATIONS } from './all-migrations.js';

describe('ALL_MIGRATIONS', () => {
  it('마이그레이션을 타임스탬프 오름차순으로 나열한다', () => {
    const names = ALL_MIGRATIONS.map((Migration) => new Migration().name);

    expect(names).toEqual([
      'InitSchema1788637362016',
      'AddIdempotencyKey1788700000000',
      'AddBlobZeroSince1788800000000',
      'AddNamespaceResourceLimits1789000000000',
      'AddEncryptionSupport1789100000000',
      'AddAuditLog1789200000000',
      'AddGcState1789300000000',
    ]);
  });
});
