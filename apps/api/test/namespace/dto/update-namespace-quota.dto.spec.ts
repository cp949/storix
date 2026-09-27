import { NamespaceInvalidTotalLogicalBytesError } from '../../../src/namespace/namespace.errors.js';
import { parseUpdateNamespaceQuotaRequest } from '../../../src/namespace/dto/update-namespace-quota.dto.js';

describe('parseUpdateNamespaceQuotaRequest', () => {
  it('양수 decimal string quota를 반환한다', () => {
    expect(parseUpdateNamespaceQuotaRequest({ maxTotalLogicalBytes: '4096' })).toEqual({
      maxTotalLogicalBytes: '4096',
    });
  });

  it('null은 namespace override를 지우고 global quota를 사용한다', () => {
    expect(parseUpdateNamespaceQuotaRequest({ maxTotalLogicalBytes: null })).toEqual({
      maxTotalLogicalBytes: null,
    });
  });

  it.each([undefined, 1, '0', '-1', '1.0', '9223372036854775808'])(
    '잘못된 quota 값 %s를 거부한다',
    (value) => {
      expect(() => parseUpdateNamespaceQuotaRequest({ maxTotalLogicalBytes: value })).toThrow(
        NamespaceInvalidTotalLogicalBytesError,
      );
    },
  );
});
