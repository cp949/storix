import { DomainError } from '../common/domain-error.js';
import type { VfsPreconditionCurrentDto } from './dto/node-response.dto.js';

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

  constructor(readonly range: string) {
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

export class VfsCopyLimitExceededError extends DomainError {
  readonly code = 'VFS_COPY_LIMIT_EXCEEDED';
  readonly status = 413;

  constructor(readonly maxNodes: number) {
    super(`복사 대상 Node 수가 상한(${maxNodes})을 초과함`);
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

  constructor(readonly maxTotalLogicalBytes: string, readonly usedTotalLogicalBytes: string) {
    super(`namespace logical byte quota exceeded (${usedTotalLogicalBytes}/${maxTotalLogicalBytes})`);
  }
}
