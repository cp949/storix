import {
  AccessPolicy,
  EncryptionPolicy,
  NamespaceEntity,
  NamespaceStatus,
} from '../../persistence/entities/namespace.entity.js';
import { resolveGlobalMaxFileSizeBytes, resolveMaxFileSizeBytes } from '../../common/resource-limit.js';
import { resolveNamespaceQuota, resolveTotalLogicalBytes } from '../../vfs/namespace-quota.js';

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

export function toNamespaceResponse(
  entity: NamespaceEntity,
  globalLimit?: string,
): NamespaceResponseDto {
  return {
    id: entity.id,
    name: entity.name,
    encryptionPolicy: entity.encryptionPolicy,
    accessPolicy: entity.accessPolicy,
    status: entity.status,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    limits: {
      maxFileSizeBytes: String(
        resolveMaxFileSizeBytes(
          entity.maxFileSizeBytes,
          resolveGlobalMaxFileSizeBytes(process.env.STORIX_MAX_FILE_SIZE_BYTES),
        ),
      ),
    },
    quota: {
      limitBytes: resolveNamespaceQuota(entity.maxTotalLogicalBytes ?? null, globalLimit).toString(),
      usedBytes: resolveTotalLogicalBytes(
        String(entity.liveFileByteCount ?? '0'),
        String(entity.retainedSnapshotByteCount ?? '0'),
      ).toString(),
    },
  };
}
