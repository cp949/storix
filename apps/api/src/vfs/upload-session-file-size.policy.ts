import { DomainError } from '../common/domain-error.js';

/** 업로드 세션 생성 시 적용할 staging 파일 크기 한도를 검사한다. */
export function assertUploadSessionFileFitsStaging(
  sizeBytes: bigint,
  globalMaxStagedBytes: bigint,
  namespaceMaxStagedBytes: bigint,
): void {
  const maxStagedBytes =
    globalMaxStagedBytes < namespaceMaxStagedBytes ? globalMaxStagedBytes : namespaceMaxStagedBytes;
  if (sizeBytes > maxStagedBytes) throw new UploadSessionStagingFileTooLargeError(sizeBytes, maxStagedBytes);
}

/** staging 한도를 넘는 파일의 세션 생성을 나타낸다. */
export class UploadSessionStagingFileTooLargeError extends DomainError {
  readonly code = 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE';
  readonly status = 413;

  constructor(
    readonly sizeBytes: bigint,
    readonly maxStagedBytes: bigint,
  ) {
    super(`파일 크기(${sizeBytes} bytes)가 staging 상한(${maxStagedBytes} bytes)을 초과함`);
  }
}
