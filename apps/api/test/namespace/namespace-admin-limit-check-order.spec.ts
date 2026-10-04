import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { canonicalJsonHash } from '../../src/common/canonical-json-hash.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import {
  IdempotencyKeyReusedError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from '../../src/namespace/namespace.errors.js';
import { NamespaceQuotaService } from '../../src/namespace/namespace-quota.service.js';
import { NamespaceSettingsService } from '../../src/namespace/namespace-settings.service.js';

const NAMESPACE_ID = 'a'.repeat(32);
const KEY = 'key-1';
const STORED_BODY = { id: NAMESPACE_ID, name: 'acme' };

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function storageKey(scope: string): string {
  return createHash('sha256').update(`${NAMESPACE_ID}\0${scope}\0${KEY}`, 'utf8').digest('hex');
}

// withMutation은 fake tx로 work를 그대로 실행한다. 저장된 영수증만 돌려주고 namespace 갱신 경로는 쓰지 않는다.
function makeNodes(
  receipt: Partial<IdempotencyKeyEntity> | null,
  root: { id: string } | null = { id: 'root' },
) {
  const keys = { findOneBy: jest.fn(async () => (receipt as IdempotencyKeyEntity | null) ?? null) };
  const nodes = {
    getRoot: jest.fn(async () => root),
    withMutation: jest.fn(async (_ns: string, _root: string, work: (tx: unknown) => Promise<unknown>) => ({
      value: await work({
        manager: {
          getRepository: (entity: unknown) => {
            if (entity === IdempotencyKeyEntity) return keys;
            throw new Error('영수증 재생 경로에서 다른 repository를 쓰면 안 된다');
          },
        },
      }),
    })),
  };
  return { nodes: nodes as unknown as VfsNodeRepository, keys };
}

describe('관리자 변경 API의 영수증 재생과 전역 상한 검사 순서', () => {
  const lowered = makeConfig({ STORIX_MAX_TOTAL_LOGICAL_BYTES: '100' });

  describe('NamespaceQuotaService', () => {
    it('전역 상한이 낮아진 뒤에도 저장된 200 영수증은 재생한다', async () => {
      const { nodes } = makeNodes({
        key: storageKey('namespace-quota'),
        requestHash: canonicalJsonHash({ namespaceId: NAMESPACE_ID, maxTotalLogicalBytes: '101' }),
        responseStatus: 200,
        responseBody: STORED_BODY,
      });
      const service = new NamespaceQuotaService(nodes, lowered);

      await expect(service.update(NAMESPACE_ID, KEY, '101')).resolves.toEqual({
        status: 200,
        body: STORED_BODY,
      });
    });

    it('같은 key에 다른 body면 전역 상한 초과보다 IdempotencyKeyReusedError가 먼저다', async () => {
      const { nodes } = makeNodes({
        key: storageKey('namespace-quota'),
        requestHash: canonicalJsonHash({ namespaceId: NAMESPACE_ID, maxTotalLogicalBytes: '50' }),
        responseStatus: 200,
        responseBody: STORED_BODY,
      });
      const service = new NamespaceQuotaService(nodes, lowered);

      await expect(service.update(NAMESPACE_ID, KEY, '101')).rejects.toThrow(IdempotencyKeyReusedError);
    });

    it('영수증이 없는 최초 요청이 전역 상한을 넘으면 NamespaceQuotaLimitExceedsGlobalError를 던진다', async () => {
      const { nodes } = makeNodes(null);
      const service = new NamespaceQuotaService(nodes, lowered);

      await expect(service.update(NAMESPACE_ID, KEY, '101')).rejects.toThrow(
        NamespaceQuotaLimitExceedsGlobalError,
      );
    });

    it('없는 namespace는 전역 상한 초과보다 NamespaceNotFoundError가 먼저다', async () => {
      const { nodes } = makeNodes(null, null);
      const service = new NamespaceQuotaService(nodes, lowered);

      await expect(service.update(NAMESPACE_ID, KEY, '101')).rejects.toThrow(NamespaceNotFoundError);
    });
  });

  describe('NamespaceSettingsService', () => {
    it('전역 상한이 낮아진 뒤에도 저장된 200 영수증은 재생한다', async () => {
      const settings = { maxTotalLogicalBytes: '101' };
      const { nodes } = makeNodes({
        key: storageKey('namespace-settings'),
        requestHash: canonicalJsonHash({ namespaceId: NAMESPACE_ID, ...settings }),
        responseStatus: 200,
        responseBody: STORED_BODY,
      });
      const service = new NamespaceSettingsService(nodes, lowered);

      await expect(service.update(NAMESPACE_ID, KEY, settings)).resolves.toEqual({
        status: 200,
        body: STORED_BODY,
      });
    });
  });
});
