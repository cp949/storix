import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { isNamespaceId } from '../common/namespace-id.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { withExactNamespaceBigints } from '../persistence/namespace-bigint-read.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { assertNamespaceQuotaWithinGlobalLimit } from '../vfs/namespace-quota.js';
import { toNamespaceResponse } from './dto/namespace-response.dto.js';
import { NamespaceGlobalLimits, readNamespaceGlobalLimits } from './namespace-global-limits.js';
import {
  IdempotencyKeyReusedError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from './namespace.errors.js';

@Injectable()
export class NamespaceQuotaService {
  private readonly globalLimits: NamespaceGlobalLimits;

  constructor(
    private readonly nodes: VfsNodeRepository,
    config: ConfigService,
  ) {
    this.globalLimits = readNamespaceGlobalLimits(config);
  }

  async update(
    namespaceId: string,
    idempotencyKey: string,
    maxTotalLogicalBytes: string | null,
  ): Promise<{ status: number; body: unknown }> {
    if (!isNamespaceId(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const root = await this.nodes.getRoot(namespaceId);
    if (!root) throw new NamespaceNotFoundError(namespaceId);
    const storageKey = createHash('sha256')
      .update(`${namespaceId}\0namespace-quota\0${idempotencyKey}`, 'utf8')
      .digest('hex');
    const requestHash = canonicalJsonHash({ namespaceId, maxTotalLogicalBytes });

    const { value } = await this.nodes.withMutation(namespaceId, root.id, async (tx) => {
      const keys = tx.manager.getRepository(IdempotencyKeyEntity);
      const existing = await keys.findOneBy({ key: storageKey });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyKeyReusedError(idempotencyKey);
        return { status: existing.responseStatus, body: existing.responseBody };
      }

      // 전역 상한 검사는 영수증 재생 뒤에 한다. 상한이 낮아진 뒤에도 완료된 요청의 재시도는 최초 응답을 받아야 한다.
      try {
        assertNamespaceQuotaWithinGlobalLimit(maxTotalLogicalBytes, this.globalLimits.maxTotalLogicalBytes);
      } catch {
        throw new NamespaceQuotaLimitExceedsGlobalError();
      }

      const namespaces = tx.manager.getRepository(NamespaceEntity);
      const namespace = await namespaces.findOneBy({ id: namespaceId });
      if (!namespace) throw new NamespaceNotFoundError(namespaceId);

      namespace.maxTotalLogicalBytes = maxTotalLogicalBytes;
      const saved = await namespaces.save(namespace);
      const body = toNamespaceResponse(
        (await withExactNamespaceBigints(tx.manager, [saved]))[0],
        this.globalLimits,
      );
      await keys.insert({
        key: storageKey,
        requestHash,
        responseStatus: 200,
        responseBody: { ...body },
      } as QueryDeepPartialEntity<IdempotencyKeyEntity>);
      return { status: 200, body };
    });

    return value;
  }
}
