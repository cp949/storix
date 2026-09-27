import type { ConfigService } from '@nestjs/config';
import { resolveGlobalMaxFileSizeBytes } from '../common/resource-limit.js';
import { resolveGlobalTotalLogicalByteLimit } from '../vfs/namespace-quota.js';
import { resolveTrashRetentionNodeLimit } from '../vfs/trash-policy.js';

// namespace 응답·quota 검증이 쓰는 전역 상한. 업로드·VFS 강제 경로와 같은 ConfigService 값을 부팅 시 한 번 해석한다.
export interface NamespaceGlobalLimits {
  readonly maxFileSizeBytes: number;
  readonly maxTotalLogicalBytes: bigint;
  readonly maxRetainedTrashNodes: number;
}

export function readNamespaceGlobalLimits(config: ConfigService): NamespaceGlobalLimits {
  return {
    maxFileSizeBytes: resolveGlobalMaxFileSizeBytes(config.get<string>('STORIX_MAX_FILE_SIZE_BYTES')),
    maxTotalLogicalBytes: resolveGlobalTotalLogicalByteLimit(config.get<string>('STORIX_MAX_TOTAL_LOGICAL_BYTES')),
    maxRetainedTrashNodes: resolveTrashRetentionNodeLimit(config.get<string>('STORIX_MAX_RETAINED_TRASH_NODES')),
  };
}
