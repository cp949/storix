import { jest } from '@jest/globals';
import type { Response } from 'express';
import { requireIdempotencyKey } from '../../src/namespace/idempotency-key.js';
import { IdempotencyKeyRequiredError } from '../../src/namespace/namespace.errors.js';
import { NamespaceQuotaController } from '../../src/namespace/namespace-quota.controller.js';
import type { NamespaceQuotaService } from '../../src/namespace/namespace-quota.service.js';
import { NamespaceTrashPolicyController } from '../../src/namespace/namespace-trash-policy.controller.js';
import type { NamespaceTrashPolicyService } from '../../src/namespace/namespace-trash-policy.service.js';

describe('관리자 PATCH Idempotency-Key 길이', () => {
  it('255 byte 키는 그대로 돌려준다', () => {
    expect(requireIdempotencyKey('k'.repeat(255))).toBe('k'.repeat(255));
  });

  it.each([undefined, '', 'k'.repeat(256)])('없거나 255 byte를 넘는 키를 거절한다: %#', (key) => {
    expect(() => requireIdempotencyKey(key)).toThrow(IdempotencyKeyRequiredError);
  });

  it('256 byte 키의 메시지에 255 byte 상한을 안내한다', () => {
    expect(() => requireIdempotencyKey('k'.repeat(256))).toThrow('255 byte');
  });

  describe.each([
    [
      'quota',
      (update: jest.Mock) => new NamespaceQuotaController({ update } as unknown as NamespaceQuotaService),
      { maxTotalLogicalBytes: null },
    ],
    [
      'trash',
      (update: jest.Mock) =>
        new NamespaceTrashPolicyController({ update } as unknown as NamespaceTrashPolicyService),
      { enabled: true },
    ],
  ] as const)('PATCH %s', (_label, build, body) => {
    const res = { status: jest.fn() } as unknown as Response;

    it('255 byte 키는 service로 전달한다', async () => {
      const update = jest.fn().mockResolvedValue({ status: 200, body: {} } as never);
      await build(update).update('ns', 'k'.repeat(255), body, res);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('256 byte 키는 IDEMPOTENCY_KEY_REQUIRED로 거절하고 service를 호출하지 않는다', () => {
      const update = jest.fn();
      expect(() => build(update).update('ns', 'k'.repeat(256), body, res)).toThrow(
        IdempotencyKeyRequiredError,
      );
      expect(update).not.toHaveBeenCalled();
    });
  });
});
