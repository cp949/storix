import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { assertNamespaceQuotaWithinGlobalLimit } from '../vfs/namespace-quota.js';
import { toNamespaceResponse } from './dto/namespace-response.dto.js';
import {
  IdempotencyKeyReusedError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from './namespace.errors.js';

@Injectable()
export class NamespaceQuotaService {
  constructor(private readonly nodes: VfsNodeRepository) {}

  async update(
    namespaceId: string,
    idempotencyKey: string,
    maxTotalLogicalBytes: string | null,
  ): Promise<{ status: number; body: unknown }> {
    try {
      assertNamespaceQuotaWithinGlobalLimit(maxTotalLogicalBytes);
    } catch {
      throw new NamespaceQuotaLimitExceedsGlobalError();
    }

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

      const namespaces = tx.manager.getRepository(NamespaceEntity);
      const namespace = await namespaces.findOneBy({ id: namespaceId });
      if (!namespace) throw new NamespaceNotFoundError(namespaceId);

      namespace.maxTotalLogicalBytes = maxTotalLogicalBytes;
      const saved = await namespaces.save(namespace);
      const body = toNamespaceResponse(saved);
      await keys.insert({
        key: storageKey,
        requestHash,
        responseStatus: 200,
        responseBody: { ...body },
      });
      return { status: 200, body };
    });

    return value;
  }
}
