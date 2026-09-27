import { parseUpdateNamespaceTrashPolicyRequest } from '../../../src/namespace/dto/update-namespace-trash-policy.dto.js';
import { NamespaceInvalidTrashPolicyError } from '../../../src/namespace/namespace.errors.js';

describe('parseUpdateNamespaceTrashPolicyRequest', () => {
  it.each([true, false])('enabled=%s 요청을 수락한다', (enabled) => {
    expect(parseUpdateNamespaceTrashPolicyRequest({ enabled })).toEqual({ enabled });
  });

  it.each([undefined, null, [], {}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, extra: 1 }])(
    '잘못된 정책 요청 %p를 거부한다',
    (body) => {
      expect(() => parseUpdateNamespaceTrashPolicyRequest(body)).toThrow(NamespaceInvalidTrashPolicyError);
    },
  );
});
