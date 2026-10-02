import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { isNamespaceId } from '../common/namespace-id.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { withExactNamespaceBigints } from '../persistence/namespace-bigint-read.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { toNamespaceResponse, NamespaceResponseDto } from './dto/namespace-response.dto.js';
import { NamespaceGlobalLimits, readNamespaceGlobalLimits } from './namespace-global-limits.js';
import { IdempotencyKeyReusedError, NamespaceNotFoundError } from './namespace.errors.js';

@Injectable()
export class NamespaceTrashPolicyService {
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
    enabled: boolean,
  ): Promise<{ status: 200; body: NamespaceResponseDto }> {
    if (!isNamespaceId(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const root = await this.nodes.getRoot(namespaceId);
    if (!root) throw new NamespaceNotFoundError(namespaceId);
    const storageKey = createHash('sha256')
      .update(`${namespaceId}\0namespace-trash-policy\0${idempotencyKey}`, 'utf8')
      .digest('hex');
    const requestHash = canonicalJsonHash({ namespaceId, enabled });

    const { value } = await this.nodes.withMutation(namespaceId, root.id, async (tx) => {
      const keys = tx.manager.getRepository(IdempotencyKeyEntity);
      const existing = await keys.findOneBy({ key: storageKey });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyKeyReusedError(idempotencyKey);
        return { status: 200 as const, body: existing.responseBody as unknown as NamespaceResponseDto };
      }

      const namespaces = tx.manager.getRepository(NamespaceEntity);
      const namespace = await namespaces.findOneBy({ id: namespaceId });
      if (!namespace) throw new NamespaceNotFoundError(namespaceId);
      namespace.trashEnabled = enabled;
      const saved = await namespaces.save(namespace);
      const body = toNamespaceResponse(
        (await withExactNamespaceBigints(tx.manager, [saved]))[0],
        this.globalLimits,
      );
      await keys.insert({ key: storageKey, requestHash, responseStatus: 200, responseBody: { ...body } });
      return { status: 200 as const, body };
    });
    return value;
  }
}
