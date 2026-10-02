import {
  AccessPolicy,
  EncryptionPolicy,
  NamespaceEntity,
  NamespaceStatus,
} from '../../persistence/entities/namespace.entity.js';
import { resolveMaxFileSizeBytes } from '../../common/resource-limit.js';
import {
  resolveEnforcedLogicalBytes,
  resolveNamespaceQuota,
  resolveTotalLogicalBytes,
} from '../../vfs/namespace-quota.js';
import type { NamespaceGlobalLimits } from '../namespace-global-limits.js';

export interface NamespaceResponseDto {
  readonly id: string;
  readonly name: string | null;
  readonly encryptionPolicy: EncryptionPolicy;
  readonly accessPolicy: AccessPolicy;
  readonly status: NamespaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly limits: {
    readonly maxFileSizeBytes: string;
    readonly maxFilesPerFolder: string;
    readonly maxNodes: string;
  };
  readonly quota: NamespaceQuotaDto;
}

export interface NamespaceQuotaDto {
  readonly limitBytes: string;
  readonly usedBytes: string;
  readonly liveBytes: string;
  readonly trashBytes: string;
  readonly snapshotBytes: string;
  readonly enforcedBytes: string;
  readonly excludeTrash: boolean;
  readonly excludeSnapshots: boolean;
  readonly trash: {
    readonly enabled: boolean;
    readonly retainedNodeCount: number;
    readonly maxRetainedNodes: number;
    readonly maxRetainedBytes: string;
  };
}

function toSafeRetainedNodeCount(value: string | undefined): number {
  const decimal = value ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(decimal)) throw new Error('Invalid retained trash node count');
  const count = BigInt(decimal);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid retained trash node count');
  return Number(count);
}

function resolveCountOverride(value: string | null | undefined, fallback: number, ceiling: number): string {
  if (value === null || value === undefined) return String(fallback);
  const override = BigInt(String(value));
  const max = BigInt(ceiling);
  return (override < max ? override : max).toString();
}

// globalLimits는 강제 경로와 같은 값을 쓰도록 호출 서비스가 ConfigService에서 해석해 넘긴다
export function toNamespaceResponse(
  entity: NamespaceEntity,
  globalLimits: NamespaceGlobalLimits,
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
          globalLimits.maxFileSizeBytes,
          globalLimits.defaultMaxFileSizeBytes,
        ),
      ),
      maxFilesPerFolder: resolveCountOverride(
        entity.maxFilesPerFolder,
        globalLimits.defaultMaxFilesPerFolder,
        globalLimits.maxFilesPerFolder,
      ),
      maxNodes: resolveCountOverride(
        entity.maxLiveNodes,
        globalLimits.defaultMaxLiveNodes,
        globalLimits.maxLiveNodes,
      ),
    },
    quota: {
      limitBytes: resolveNamespaceQuota(
        entity.maxTotalLogicalBytes ?? null,
        globalLimits.maxTotalLogicalBytes,
        globalLimits.defaultMaxTotalLogicalBytes,
      ).toString(),
      usedBytes: resolveTotalLogicalBytes(
        String(entity.liveFileByteCount ?? '0'),
        String(entity.retainedSnapshotByteCount ?? '0'),
        String(entity.retainedTrashByteCount ?? '0'),
      ).toString(),
      liveBytes: String(entity.liveFileByteCount ?? '0'),
      trashBytes: String(entity.retainedTrashByteCount ?? '0'),
      snapshotBytes: String(entity.retainedSnapshotByteCount ?? '0'),
      enforcedBytes: resolveEnforcedLogicalBytes(
        String(entity.liveFileByteCount ?? '0'),
        String(entity.retainedTrashByteCount ?? '0'),
        String(entity.retainedSnapshotByteCount ?? '0'),
        entity.excludeTrashFromQuota ?? false,
        entity.excludeSnapshotsFromQuota ?? false,
      ).toString(),
      excludeTrash: entity.excludeTrashFromQuota ?? false,
      excludeSnapshots: entity.excludeSnapshotsFromQuota ?? false,
      trash: {
        enabled: entity.trashEnabled ?? false,
        retainedNodeCount: toSafeRetainedNodeCount(entity.retainedTrashNodeCount),
        maxRetainedNodes: globalLimits.maxRetainedTrashNodes,
        maxRetainedBytes: (entity.maxRetainedTrashBytes === null || entity.maxRetainedTrashBytes === undefined
          ? resolveNamespaceQuota(
              entity.maxTotalLogicalBytes ?? null,
              globalLimits.maxTotalLogicalBytes,
              globalLimits.defaultMaxTotalLogicalBytes,
            )
          : BigInt(String(entity.maxRetainedTrashBytes)) < globalLimits.maxTotalLogicalBytes
            ? BigInt(String(entity.maxRetainedTrashBytes))
            : globalLimits.maxTotalLogicalBytes
        ).toString(),
      },
    },
  };
}
