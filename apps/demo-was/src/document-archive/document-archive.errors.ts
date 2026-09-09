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
