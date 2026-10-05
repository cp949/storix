import { DomainError } from '../common/domain-error.js';

export class DemoUserRequiredError extends DomainError {
  readonly code = 'DEMO_USER_REQUIRED';
  readonly status = 400;

  constructor(received: string | undefined) {
    super(`X-Demo-User 헤더가 'alice' 또는 'bob'이어야 함(받은 값: ${received ?? '없음'})`);
  }
}

export class DocumentPathEscapesRootError extends DomainError {
  readonly code = 'DOCUMENT_PATH_ESCAPES_ROOT';
  readonly status = 403;

  constructor(requestedPath: string) {
    super(`요청 경로가 사용자 root를 벗어남: ${requestedPath}`);
  }
}

export class ExternalPathResolutionError extends DomainError {
  readonly code = 'EXTERNAL_PATH_RESOLUTION_FAILED';
  readonly status = 500;
  readonly internalPath: string;

  constructor(internalPath: string) {
    super('내부 경로를 외부 경로로 변환할 수 없음');
    this.internalPath = internalPath;
  }
}

export class UploadSessionNotFoundError extends DomainError {
  readonly code = 'VFS_UPLOAD_SESSION_NOT_FOUND';
  readonly status = 404;

  constructor() {
    super('업로드 세션을 찾을 수 없음');
  }
}

export class UploadSessionInvalidRequestError extends DomainError {
  readonly code = 'UPLOAD_SESSION_INVALID_REQUEST';
  readonly status = 400;

  constructor() {
    super('업로드 세션 생성 요청이 올바르지 않음');
  }
}

export class InvalidRequestBodyError extends DomainError {
  readonly code = 'DEMO_INVALID_REQUEST_BODY';
  readonly status = 400;

  constructor(field: string) {
    super(`요청 본문의 ${field}는 문자열이어야 함`);
  }
}
