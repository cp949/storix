import { DomainError } from '../common/domain-error.js';
import type { CapabilityId } from '../capability/capability-registry.js';
import type { VfsPreconditionCurrentDto } from './dto/node-response.dto.js';

export class VfsFeatureDisabledError extends DomainError {
  readonly code = 'VFS_FEATURE_DISABLED';
  readonly status = 409;

  constructor(capabilityId: CapabilityId) {
    super(`Capability disabled: ${capabilityId}`);
  }
}

export class VfsInvalidRevisionError extends DomainError {
  readonly code = 'VFS_INVALID_REVISION';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 revision');
  }
}

export class VfsInvalidMutationRequestError extends DomainError {
  readonly code = 'VFS_INVALID_MUTATION_REQUEST';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 mutation 요청');
  }
}

export class VfsInvalidChecksumError extends DomainError {
  readonly code = 'VFS_INVALID_CHECKSUM';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 checksum');
  }
}

export class VfsInvalidExpiryError extends DomainError {
  readonly code = 'VFS_INVALID_EXPIRY';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 만료 입력');
  }
}

export class VfsChecksumMismatchError extends DomainError {
  readonly code = 'VFS_CHECKSUM_MISMATCH';
  readonly status = 422;

  constructor() {
    super('콘텐츠 checksum 불일치');
  }
}

/** 재개 업로드 조각 PUT의 `X-Content-Sha256`이 본문 평문 해시와 다르다. 완료 시 전체 해시 불일치(`VFS_CHECKSUM_MISMATCH`)와 구분한다. */
export class VfsPartChecksumMismatchError extends DomainError {
  readonly code = 'VFS_PART_CHECKSUM_MISMATCH';
  readonly status = 422;

  constructor() {
    super('조각 checksum 불일치');
  }
}

/** staging 한도를 넘는 새 업로드 세션을 나타낸다. */
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

export class VfsPreconditionRequiredError extends DomainError {
  readonly code = 'VFS_PRECONDITION_REQUIRED';
  readonly status = 428;

  constructor() {
    super('mutation 전제조건이 필요함');
  }
}

export class VfsPreconditionFailedError extends DomainError {
  readonly code = 'VFS_PRECONDITION_FAILED';
  readonly status = 412;

  // current: 충돌 시점에 트랜잭션 안에서 읽은 노드 metadata(stat 응답 필드 + revision).
  // 노드가 없으면 null이다. 오류 body에 그대로 직렬화되어 receipt로 고정된다.
  constructor(
    readonly path: string,
    readonly current: VfsPreconditionCurrentDto | null,
  ) {
    super(`mutation 전제조건 불일치: ${path}`);
  }
}

/** archive 입력 구조 또는 원본 종류가 요청 조건을 만족하지 않는다. */
export class VfsArchiveInvalidRequestError extends DomainError {
  readonly code = 'VFS_INVALID_ARCHIVE_REQUEST';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 archive 요청');
  }
}

/** 요청한 archive 원본 revision 형식이 잘못됐다. */
export class VfsArchiveInvalidRevisionError extends DomainError {
  readonly code = 'VFS_INVALID_REVISION';
  readonly status = 400;

  /** 실패한 entries 배열의 0부터 시작하는 index다. */
  constructor(readonly archiveEntry: number) {
    super(`유효하지 않은 archive entry revision: ${archiveEntry}`);
  }
}

/** archive 항목의 revision이 capture 시점과 다르다. */
export class VfsArchivePreconditionFailedError extends VfsPreconditionFailedError {
  /** 실패한 entries 배열의 0부터 시작하는 index다. target 충돌이면 없다. */
  constructor(
    path: string,
    current: VfsPreconditionCurrentDto | null,
    readonly archiveEntry?: number,
  ) {
    super(path, current);
  }
}

/** archive 입력의 FILE 수 또는 원본 byte 합계가 상한을 넘었다. */
export class VfsArchiveTooLargeError extends DomainError {
  readonly code = 'VFS_ARCHIVE_TOO_LARGE';
  readonly status = 413;

  constructor() {
    super('archive 입력 상한 초과');
  }
}

/** 생성 중인 ZIP 전체 byte 수가 archive 결과 상한을 넘었다. */
export class VfsArchiveResultTooLargeError extends DomainError {
  readonly code = 'VFS_ARCHIVE_TOO_LARGE';
  readonly status = 413;

  constructor() {
    super('archive 결과 상한 초과');
  }
}

/** 요청한 archive 원본 FILE이 namespace에 없다. 부재·다른 namespace·휴지통을 구분하지 않는다. */
export class VfsArchiveSourceNotFoundError extends DomainError {
  readonly code = 'VFS_NODE_NOT_FOUND';
  readonly status = 404;

  /** 실패한 entries 배열의 0부터 시작하는 index다. */
  constructor(readonly archiveEntry: number) {
    super(`존재하지 않는 archive 원본: entry ${archiveEntry}`);
  }
}

/** archive의 최종 mutation 시각이 고정 deadline을 넘었다. */
export class VfsArchiveDeadlineExceededError extends DomainError {
  readonly code = 'VFS_ARCHIVE_TIMEOUT';
  readonly status = 503;

  constructor() {
    super('archive 실행 deadline 초과');
  }
}

/** 프로세스 archive 동시 실행 한도에 도달했다. */
export class VfsArchiveBusyError extends DomainError {
  readonly code = 'VFS_ARCHIVE_BUSY';
  readonly status = 503;

  /** 응답 `Retry-After` 초다. 필터와 service가 같은 값을 쓴다. */
  constructor(readonly retryAfterSeconds: number) {
    super('archive 실행 한도 초과');
  }
}

export class VfsRevisionExhaustedError extends DomainError {
  readonly code = 'VFS_REVISION_EXHAUSTED';
  readonly status = 409;

  constructor() {
    super('revision 상한 초과');
  }
}

export class VfsInvalidPathError extends DomainError {
  readonly code = 'VFS_INVALID_PATH';
  readonly status = 400;

  constructor(readonly path: string) {
    super(`유효하지 않은 경로: ${path}`);
  }
}

export class VfsInvalidCursorError extends DomainError {
  readonly code = 'VFS_INVALID_CURSOR';
  readonly status = 400;

  constructor(readonly cursor: string) {
    super(`유효하지 않은 cursor: ${cursor}`);
  }
}

export class VfsInvalidQueryError extends DomainError {
  readonly code = 'VFS_INVALID_QUERY';
  readonly status = 400;

  constructor(readonly parameter: string) {
    super(`유효하지 않은 쿼리 파라미터: ${parameter}`);
  }
}

export class VfsInvalidChangeCursorError extends DomainError {
  readonly code = 'VFS_INVALID_CURSOR';
  readonly status = 400;

  constructor() {
    super('유효하지 않은 change feed cursor');
  }
}

export class VfsChangeCursorExpiredError extends DomainError {
  readonly code = 'VFS_CHANGE_CURSOR_EXPIRED';
  readonly status = 410;

  constructor() {
    super('change feed cursor 보존 기간 만료');
  }
}

export class VfsNamespaceNotFoundError extends DomainError {
  readonly code = 'NAMESPACE_NOT_FOUND';
  readonly status = 404;

  constructor(readonly namespaceId: string) {
    super(`존재하지 않는 namespace: ${namespaceId}`);
  }
}

export class VfsNodeNotFoundError extends DomainError {
  readonly code = 'VFS_NODE_NOT_FOUND';
  readonly status = 404;

  constructor(readonly path: string) {
    super(`존재하지 않는 경로: ${path}`);
  }
}

export class VfsSnapshotNotFoundError extends DomainError {
  readonly code = 'VFS_SNAPSHOT_NOT_FOUND';
  readonly status = 404;

  constructor(readonly snapshotId: string) {
    super(`존재하지 않는 snapshot: ${snapshotId}`);
  }
}

export class VfsNotDirectoryError extends DomainError {
  readonly code = 'VFS_NOT_DIRECTORY';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`directory가 아님: ${path}`);
  }
}

export class VfsAlreadyExistsError extends DomainError {
  readonly code = 'VFS_ALREADY_EXISTS';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`이미 존재하는 경로: ${path}`);
  }
}

export class VfsRangeNotSatisfiableError extends DomainError {
  readonly code = 'VFS_RANGE_NOT_SATISFIABLE';
  readonly status = 416;

  constructor(
    readonly range: string,
    readonly representationSize: number,
  ) {
    super(`처리할 수 없는 Range: ${range}`);
  }
}

export class VfsIsDirectoryError extends DomainError {
  readonly code = 'VFS_IS_DIRECTORY';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`directory 대상에는 허용되지 않는 연산: ${path}`);
  }
}

export class VfsVersionConflictError extends DomainError {
  readonly code = 'VFS_VERSION_CONFLICT';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`version 불일치: ${path}`);
  }
}

export class VfsInvalidOperationError extends DomainError {
  readonly code = 'VFS_INVALID_OPERATION';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`잘못된 tree 연산: ${path}`);
  }
}

export class VfsDirectoryNotEmptyError extends DomainError {
  readonly code = 'VFS_DIRECTORY_NOT_EMPTY';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`비어 있지 않은 directory: ${path}`);
  }
}

export class VfsDeleteLimitExceededError extends DomainError {
  readonly code = 'VFS_DELETE_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(readonly maxNodes: number) {
    super(`삭제 대상 Node 수가 상한(${maxNodes})을 초과함`);
  }
}

export class VfsTrashLimitExceededError extends DomainError {
  readonly code = 'VFS_TRASH_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(readonly maxNodes: number | string) {
    super(`휴지통 보존 상한(${maxNodes})을 초과함`);
  }
}

export class VfsTrashItemNotFoundError extends DomainError {
  readonly code = 'VFS_TRASH_ITEM_NOT_FOUND';
  readonly status = 404;

  constructor(readonly trashId: string) {
    super(`존재하지 않는 휴지통 항목: ${trashId}`);
  }
}

export class VfsTrashItemExpiredError extends DomainError {
  readonly code = 'VFS_TRASH_ITEM_EXPIRED';
  readonly status = 410;

  constructor(readonly trashId: string) {
    super(`복원 기한이 지난 휴지통 항목: ${trashId}`);
  }
}

export class VfsCopyLimitExceededError extends DomainError {
  readonly code = 'VFS_COPY_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(readonly maxNodes: number) {
    super(`복사 대상 Node 수가 상한(${maxNodes})을 초과함`);
  }
}

export class VfsMoveLimitExceededError extends DomainError {
  readonly code = 'VFS_MOVE_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(readonly maxNodes: number) {
    super(`이동 대상 Node 수가 상한(${maxNodes})을 초과함`);
  }
}

export class VfsPresignedEncryptedUnsupportedError extends DomainError {
  readonly code = 'VFS_PRESIGNED_ENCRYPTED_UNSUPPORTED';
  readonly status = 409;

  constructor(readonly path: string) {
    super(`ENCRYPTED namespace는 presigned 다운로드를 지원하지 않음: ${path}`);
  }
}

export class VfsSnapshotLimitExceededError extends DomainError {
  readonly code = 'VFS_SNAPSHOT_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor() {
    super('Snapshot Node 수 또는 logical byte 보존 한도 초과');
  }
}

export class VfsQuotaExceededError extends DomainError {
  readonly code = 'VFS_QUOTA_EXCEEDED';
  readonly status = 413;

  constructor(
    readonly maxTotalLogicalBytes: string,
    readonly usedTotalLogicalBytes: string,
  ) {
    super(`namespace logical byte quota exceeded (${usedTotalLogicalBytes}/${maxTotalLogicalBytes})`);
  }
}

export class VfsFolderFileLimitExceededError extends DomainError {
  readonly code = 'VFS_FOLDER_FILE_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(
    readonly maxFiles: string,
    readonly usedFiles: string,
  ) {
    super(`folder direct FILE limit exceeded (${usedFiles}/${maxFiles})`);
  }
}

export class VfsNamespaceNodeLimitExceededError extends DomainError {
  readonly code = 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(
    readonly maxNodes: string,
    readonly usedNodes: string,
  ) {
    super(`namespace live node limit exceeded (${usedNodes}/${maxNodes})`);
  }
}
