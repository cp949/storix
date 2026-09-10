import { DomainError } from '../common/domain-error.js';

export class StorixApiError extends DomainError {
  readonly code: string;
  readonly status: number;
  readonly upstreamRequestId: string | undefined;

  constructor(status: number, code: string, message: string, upstreamRequestId: string | undefined) {
    super(`Storix 요청 실패(${status} ${code}): ${message}`);
    this.status = status;
    this.code = code;
    this.upstreamRequestId = upstreamRequestId;
  }
}

export class StorixUnreachableError extends DomainError {
  readonly code = 'STORIX_UNREACHABLE';
  readonly status = 502;

  constructor(cause: unknown) {
    super(`Storix에 연결할 수 없음: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class StorixClientNotBootstrappedError extends DomainError {
  readonly code = 'STORIX_CLIENT_NOT_BOOTSTRAPPED';
  readonly status = 500;

  constructor() {
    super('namespace 부트스트랩이 끝나기 전에 StorixClient가 호출됨');
  }
}
