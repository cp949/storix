import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_MAX_LIVE_NODES,
  resolveCountLimits,
  resolveFileSizeLimits,
} from '../common/resource-limit.js';
import { resolveGlobalTotalLogicalByteLimits } from '../vfs/namespace-quota.js';
import { resolveTrashRetentionNodeLimit } from '../vfs/trash-policy.js';

// namespace 응답·quota 검증이 쓰는 전역 상한. 업로드·VFS 강제 경로와 같은 ConfigService 값을 부팅 시 한 번 해석한다.
export interface NamespaceGlobalLimits {
  readonly defaultMaxFileSizeBytes: number;
  readonly maxFileSizeBytes: number;
  readonly defaultMaxTotalLogicalBytes: bigint;
  readonly maxTotalLogicalBytes: bigint;
  readonly maxRetainedTrashNodes: number;
  readonly defaultMaxFilesPerFolder: number;
  readonly maxFilesPerFolder: number;
  readonly defaultMaxLiveNodes: number;
  readonly maxLiveNodes: number;
}

export function readNamespaceGlobalLimits(config: ConfigService): NamespaceGlobalLimits {
  const fileSizeLimits = resolveFileSizeLimits(
    config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
    config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
  );
  const totalLogicalByteLimits = resolveGlobalTotalLogicalByteLimits(
    config.get<string>('STORIX_DEFAULT_TOTAL_LOGICAL_BYTES'),
    config.get<string>('STORIX_MAX_TOTAL_LOGICAL_BYTES'),
  );
  const folderFileLimits = resolveCountLimits(
    config.get<string>('STORIX_DEFAULT_MAX_FILES_PER_FOLDER'),
    config.get<string>('STORIX_MAX_FILES_PER_FOLDER'),
  );
  const liveNodeLimits = resolveCountLimits(
    config.get<string>('STORIX_DEFAULT_MAX_LIVE_NODES'),
    config.get<string>('STORIX_MAX_LIVE_NODES'),
    DEFAULT_MAX_LIVE_NODES,
  );
  return {
    defaultMaxFileSizeBytes: fileSizeLimits.defaultBytes,
    maxFileSizeBytes: fileSizeLimits.ceilingBytes,
    defaultMaxTotalLogicalBytes: totalLogicalByteLimits.defaultBytes,
    maxTotalLogicalBytes: totalLogicalByteLimits.ceilingBytes,
    maxRetainedTrashNodes: resolveTrashRetentionNodeLimit(
      config.get<string>('STORIX_MAX_RETAINED_TRASH_NODES'),
    ),
    defaultMaxFilesPerFolder: folderFileLimits.defaultValue,
    maxFilesPerFolder: folderFileLimits.ceilingValue,
    defaultMaxLiveNodes: liveNodeLimits.defaultValue,
    maxLiveNodes: liveNodeLimits.ceilingValue,
  };
}
