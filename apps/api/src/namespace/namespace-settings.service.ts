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
import type { UpdateNamespaceSettingsRequest } from './dto/update-namespace-settings.dto.js';
import { toNamespaceResponse, type NamespaceResponseDto } from './dto/namespace-response.dto.js';
import { readNamespaceGlobalLimits, type NamespaceGlobalLimits } from './namespace-global-limits.js';
import {
  IdempotencyKeyReusedError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
  NamespaceSettingExceedsCeilingError,
} from './namespace.errors.js';

@Injectable()
export class NamespaceSettingsService {
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
    settings: UpdateNamespaceSettingsRequest,
  ): Promise<{ status: 200; body: NamespaceResponseDto }> {
    if (!isNamespaceId(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const root = await this.nodes.getRoot(namespaceId);
    if (!root) throw new NamespaceNotFoundError(namespaceId);
    const storageKey = createHash('sha256')
      .update(`${namespaceId}\0namespace-settings\0${idempotencyKey}`, 'utf8')
      .digest('hex');
    const requestHash = canonicalJsonHash({ namespaceId, ...settings });

    const { value } = await this.nodes.withMutation(namespaceId, root.id, async (tx) => {
      const keys = tx.manager.getRepository(IdempotencyKeyEntity);
      const existing = await keys.findOneBy({ key: storageKey });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyKeyReusedError(idempotencyKey);
        return { status: 200 as const, body: existing.responseBody as unknown as NamespaceResponseDto };
      }

      this.assertSettingsWithinCeilings(settings);
      const updates: Partial<NamespaceEntity> = {};
      if (Object.hasOwn(settings, 'maxTotalLogicalBytes'))
        updates.maxTotalLogicalBytes = settings.maxTotalLogicalBytes ?? null;
      if (Object.hasOwn(settings, 'maxFileSizeBytes'))
        updates.maxFileSizeBytes = settings.maxFileSizeBytes ?? null;
      if (Object.hasOwn(settings, 'maxFilesPerFolder'))
        updates.maxFilesPerFolder = settings.maxFilesPerFolder ?? null;
      if (Object.hasOwn(settings, 'maxNodes')) updates.maxLiveNodes = settings.maxNodes ?? null;
      if (Object.hasOwn(settings, 'maxRetainedTrashBytes'))
        updates.maxRetainedTrashBytes = settings.maxRetainedTrashBytes ?? null;
      if (Object.hasOwn(settings, 'excludeTrashFromQuota'))
        updates.excludeTrashFromQuota = settings.excludeTrashFromQuota!;
      if (Object.hasOwn(settings, 'excludeSnapshotsFromQuota'))
        updates.excludeSnapshotsFromQuota = settings.excludeSnapshotsFromQuota!;
      if (Object.hasOwn(settings, 'trashEnabled')) updates.trashEnabled = settings.trashEnabled!;

      const namespaces = tx.manager.getRepository(NamespaceEntity);
      await namespaces.update({ id: namespaceId }, updates);
      const saved = await namespaces.findOneByOrFail({ id: namespaceId });
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
      return { status: 200 as const, body };
    });
    return value;
  }

  private assertSettingsWithinCeilings(settings: UpdateNamespaceSettingsRequest): void {
    if (Object.hasOwn(settings, 'maxTotalLogicalBytes')) {
      try {
        assertNamespaceQuotaWithinGlobalLimit(
          settings.maxTotalLogicalBytes ?? null,
          this.globalLimits.maxTotalLogicalBytes,
        );
      } catch {
        throw new NamespaceQuotaLimitExceedsGlobalError();
      }
    }

    const checks = [
      ['maxFileSizeBytes', settings.maxFileSizeBytes, BigInt(this.globalLimits.maxFileSizeBytes)],
      ['maxFilesPerFolder', settings.maxFilesPerFolder, BigInt(this.globalLimits.maxFilesPerFolder)],
      ['maxNodes', settings.maxNodes, BigInt(this.globalLimits.maxLiveNodes)],
      ['maxRetainedTrashBytes', settings.maxRetainedTrashBytes, this.globalLimits.maxTotalLogicalBytes],
    ] as const;
    for (const [field, value, ceiling] of checks) {
      if (value !== undefined && value !== null && BigInt(value) > ceiling)
        throw new NamespaceSettingExceedsCeilingError(field, value, ceiling.toString());
    }
  }
}
