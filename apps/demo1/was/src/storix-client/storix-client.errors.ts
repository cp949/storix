import { DomainError } from '../common/domain-error.js';

export class StorixApiError extends DomainError {
  readonly code: string;
  readonly status: number;
  readonly upstreamRequestId: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    upstreamRequestId: string | undefined,
    retryAfter?: string,
  ) {
    super(`Storix 요청 실패(${status} ${code}): ${message}`);
    this.status = status;
    this.code = code;
    this.upstreamRequestId = upstreamRequestId;
    this.retryAfter = retryAfter;
  }
}

/**
 * Storix가 WAS의 API 키를 거부한 경우다. 브라우저에는 사용자 인증 실패(401)가 아니라 upstream 설정 오류(502)로 보인다.
 * 응답 message는 고정 문구이고, upstream 원인은 필드로 보존해 로그에만 남긴다.
 */
export class StorixUpstreamUnauthorizedError extends DomainError {
  readonly code = 'STORIX_UPSTREAM_UNAUTHORIZED';
  readonly status = 502;
  readonly upstreamCode: string;
  readonly upstreamRequestId: string | undefined;

  constructor(upstreamCode: string, upstreamRequestId: string | undefined) {
    super('Storix 인증에 실패함. WAS의 Storix API 키 설정을 확인해야 함');
    this.upstreamCode = upstreamCode;
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
