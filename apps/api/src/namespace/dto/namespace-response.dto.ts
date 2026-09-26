import {
  AccessPolicy,
  EncryptionPolicy,
  NamespaceEntity,
  NamespaceStatus,
} from '../../persistence/entities/namespace.entity.js';
import { resolveMaxFileSizeBytes } from '../../common/resource-limit.js';
import { resolveNamespaceQuota, resolveTotalLogicalBytes } from '../../vfs/namespace-quota.js';
import type { NamespaceGlobalLimits } from '../namespace-global-limits.js';

export interface NamespaceResponseDto {
  readonly id: string;
  readonly name: string;
  readonly encryptionPolicy: EncryptionPolicy;
  readonly accessPolicy: AccessPolicy;
  readonly status: NamespaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: { readonly maxFileSizeBytes: string };
  readonly quota: { readonly limitBytes: string; readonly usedBytes: string };
}

// globalLimits는 강제 경로와 같은 값을 쓰도록 호출 서비스가 ConfigService에서 해석해 넘긴다
export function toNamespaceResponse(entity: NamespaceEntity, globalLimits: NamespaceGlobalLimits): NamespaceResponseDto {
  return {
    id: entity.id,
    name: entity.name,
    encryptionPolicy: entity.encryptionPolicy,
    accessPolicy: entity.accessPolicy,
    status: entity.status,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    limits: {
      maxFileSizeBytes: String(resolveMaxFileSizeBytes(entity.maxFileSizeBytes, globalLimits.maxFileSizeBytes)),
    },
    quota: {
      limitBytes: resolveNamespaceQuota(entity.maxTotalLogicalBytes ?? null, globalLimits.maxTotalLogicalBytes).toString(),
      usedBytes: resolveTotalLogicalBytes(
        String(entity.liveFileByteCount ?? '0'),
        String(entity.retainedSnapshotByteCount ?? '0'),
      ).toString(),
    },
  };
}
