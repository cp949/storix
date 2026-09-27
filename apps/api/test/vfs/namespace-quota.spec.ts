import {
  assertNamespaceQuotaWithinGlobalLimit,
  resolveGlobalTotalLogicalByteLimit,
  resolveNamespaceQuota,
  resolveTotalLogicalBytes,
} from '../../src/vfs/namespace-quota.js';

describe('namespace quota', () => {
  it('uses namespace override unless the service cap is lower', () => {
    expect(resolveNamespaceQuota('20', 30n)).toBe(20n);
    expect(resolveNamespaceQuota('40', 30n)).toBe(30n);
  });

  it('uses the configured service cap when namespace override is absent', () => {
    expect(resolveNamespaceQuota(null, 30n)).toBe(30n);
  });

  it('uses the 50 GiB default when the service cap is unset or empty', () => {
    expect(resolveGlobalTotalLogicalByteLimit(undefined)).toBe(53687091200n);
    expect(resolveGlobalTotalLogicalByteLimit('')).toBe(53687091200n);
  });

  it('parses decimal byte values without number precision loss', () => {
    expect(resolveTotalLogicalBytes('9007199254740993', '9007199254740994')).toBe(18014398509481987n);
  });

  it.each(['0', '-1', '1.5', '1e6', '9223372036854775808'])('rejects invalid byte limit %s', (value) => {
    expect(() => resolveGlobalTotalLogicalByteLimit(value)).toThrow('Invalid total logical byte limit');
  });

  it('rejects namespace override above the resolved service cap', () => {
    expect(() => assertNamespaceQuotaWithinGlobalLimit('31', 30n)).toThrow(
      'Namespace total logical byte limit exceeds the global limit',
    );
    expect(() => assertNamespaceQuotaWithinGlobalLimit('30', 30n)).not.toThrow();
  });

  it('rejects negative or non-decimal usage counters', () => {
    expect(() => resolveTotalLogicalBytes('-1', '100')).toThrow('Invalid total logical byte count');
    expect(() => resolveTotalLogicalBytes('1', '1.2')).toThrow('Invalid total logical byte count');
  });
});
