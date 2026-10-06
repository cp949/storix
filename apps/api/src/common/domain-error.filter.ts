import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { inspect } from 'node:util';
import { DomainError } from './domain-error.js';
import { StorageFailureError, StorageUnavailableError } from './storage-failure.errors.js';
import type { ErrorReporter } from '../observability/error-reporter.js';
import { ERROR_REPORTER } from '../observability/observability.constants.js';
import { InvalidApiKeyError } from '../auth/auth.errors.js';
import type { AuditLogRepository } from '../persistence/audit-log.repository.js';
import { AUDIT_LOG_REPOSITORY } from '../persistence/audit-log.tokens.js';
import { VfsRangeNotSatisfiableError } from '../vfs/vfs.errors.js';
import { sanitizeAuditString } from '../audit/audit-string.js';
import {
  AUTH_REJECT_AUDIT_LIMITER,
  AUTH_REJECT_AUDIT_MAX_PER_WINDOW,
  AUTH_REJECT_AUDIT_WINDOW_MS,
  AuthRejectAuditLimiter,
} from '../audit/auth-reject-audit-limiter.js';
import type { AuditLogEntry } from '../persistence/audit-log.repository.js';

interface DomainErrorShape {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly path?: unknown;
  readonly current?: unknown;
  readonly retryAfterSeconds?: unknown;
}

const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export function resolveErrorStatus(exception: unknown): number {
  const status = (exception as DomainErrorShape)?.status;
  return typeof status === 'number' ? status : 500;
}

// code 산출 규칙(우선순위 순):
// 1. DomainError 등 string code를 가진 예외는 그 code를 쓴다.
// 2. Nest HttpException(없는 라우트 404, terminus 503 등)은 HttpStatus 이름을 쓴다(NOT_FOUND, SERVICE_UNAVAILABLE).
// 3. 그 밖의 status 오류(body-parser의 400·413 등)는 BAD_REQUEST다. 공개 계약(openapi)에 적혀 있어 바꾸지 않는다.
export function resolveErrorCode(exception: unknown, status: number): string {
  const code = (exception as DomainErrorShape)?.code;
  if (typeof code === 'string') {
    return code;
  }
  if (status === 500) return 'INTERNAL_ERROR';
  if (exception instanceof HttpException) {
    // 숫자 enum의 역조회라 HttpStatus에 없는 status는 undefined다.
    return HttpStatus[status] ?? 'BAD_REQUEST';
  }
  return 'BAD_REQUEST';
}

/**
 * HTTP 응답과 업로드 세션의 완료 실패 기록에 사용하는 공개 오류 코드를 반환한다.
 * 500은 저장소 실패만 고유 코드를 사용하고 나머지는 INTERNAL_ERROR로 숨긴다.
 * 원시 DB·네트워크 오류의 code(SQLSTATE, errno 등)는 공개하지 않는다.
 */
export function resolvePublicErrorCode(exception: unknown): string {
  const status = resolveErrorStatus(exception);
  if (status === 500) return exception instanceof StorageFailureError ? exception.code : 'INTERNAL_ERROR';
  return resolveErrorCode(exception, status);
}

export function resolveErrorPath(exception: unknown): string | undefined {
  const path = (exception as DomainErrorShape)?.path;
  return typeof path === 'string' ? path : undefined;
}

// current는 412 오류만 담는 필드다. 값이 없으면(undefined) body에 키를 만들지 않아
// 다른 오류의 body 형태를 바꾸지 않는다. null은 "노드 없음"이라는 값이므로 유지한다.
export function resolveErrorCurrent(exception: unknown): { current: unknown } | undefined {
  const current = (exception as DomainErrorShape)?.current;
  return current === undefined ? undefined : { current };
}

// 재시도로 성공할 수 있는 오류(503 등)가 대기 시간을 알리는 필드다. 값이 없으면 헤더를 붙이지 않는다.
export function resolveRetryAfterSeconds(exception: unknown): number | undefined {
  const seconds = (exception as DomainErrorShape)?.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function resolveErrorMessage(exception: unknown, status: number): string {
  if (status === 500) {
    return INTERNAL_ERROR_MESSAGE;
  }
  if (exception instanceof StorageUnavailableError) return 'Storage temporarily unavailable';
  return exception instanceof Error ? exception.message : INTERNAL_ERROR_MESSAGE;
}

// 저장 장애 오류는 원본 DB·Blob 오류를 cause로만 들고 응답에는 고정 문구를 쓴다. 로그에는 cause stack을
// 이어 붙여 SQLSTATE·SDK 코드 같은 진단 정보를 잃지 않게 한다.
export function resolveLogStack(exception: Error): string | undefined {
  if (exception.cause === undefined) return exception.stack;
  const cause =
    exception.cause instanceof Error
      ? (exception.cause.stack ?? exception.cause.message)
      : inspect(exception.cause);
  return `${exception.stack ?? exception.message}\nCaused by: ${cause}`;
}

// DomainError가 아닌 예외(third-party, body-parser 등)는 shouldReport 개념이 없으므로
// 기존 전역 규칙(500만 report)으로 fallback한다.
export function resolveShouldReport(exception: unknown, status: number): boolean {
  if (exception instanceof DomainError) {
    return exception.shouldReport;
  }
  return status === 500;
}

@Catch()
@Injectable()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  constructor(
    @Optional() @Inject(ERROR_REPORTER) private readonly errorReporter?: ErrorReporter,
    @Optional() @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLogRepository?: AuditLogRepository,
    // 필터는 전역 인스턴스와 컨트롤러별 DI 인스턴스로 여러 개 생기므로, 상한 상태는 앱 단위 provider를
    // 공유해야 한다. provider가 없는 구성(단위 테스트 등)은 필터마다 별도 리미터를 쓴다.
    @Optional()
    @Inject(AUTH_REJECT_AUDIT_LIMITER)
    private readonly authRejectLimiter: AuthRejectAuditLimiter = new AuthRejectAuditLimiter(),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = resolveErrorStatus(exception);

    if (exception instanceof InvalidApiKeyError && this.auditLogRepository) {
      this.recordAuthReject(request);
    }

    if (status === 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? resolveLogStack(exception) : undefined,
      );
    } else if (exception instanceof StorageUnavailableError) {
      // 503은 재시도 대상이지만 장애 원인 추적을 위해 cause를 경고로 남긴다.
      this.logger.warn(resolveLogStack(exception) ?? exception.message);
    }

    if (resolveShouldReport(exception, status)) {
      this.errorReporter?.report(exception instanceof Error ? exception : new Error(String(exception)), {
        requestId: request.requestId,
        path: `${request.method} ${request.path}`,
      });
    }

    if (status === 500) {
      response.status(500).json({
        code: resolvePublicErrorCode(exception),
        message: exception instanceof StorageFailureError ? 'Storage failure' : INTERNAL_ERROR_MESSAGE,
        requestId: request.requestId,
      });
      return;
    }

    const retryAfterSeconds = resolveRetryAfterSeconds(exception);
    if (retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(retryAfterSeconds));
    if (exception instanceof VfsRangeNotSatisfiableError) {
      response.setHeader('Content-Range', `bytes */${exception.representationSize}`);
    }

    response.status(status).json({
      code: resolveErrorCode(exception, status),
      message: resolveErrorMessage(exception, status),
      path: resolveErrorPath(exception),
      ...resolveErrorCurrent(exception),
      requestId: request.requestId,
    });
  }

  // 401 감사 행을 윈도당 상한 안에서만 기록한다. 기록은 응답을 막지 않는 best-effort다.
  private recordAuthReject(request: Request): void {
    const decision = this.authRejectLimiter.admit();
    if (decision.firstSuppressed) {
      this.logger.warn(
        `인증 거부 감사 기록이 윈도 상한(${AUTH_REJECT_AUDIT_MAX_PER_WINDOW}건/${AUTH_REJECT_AUDIT_WINDOW_MS / 1000}초)을 넘어 생략됨`,
      );
    }
    if (decision.suppressedBefore > 0) {
      this.recordAudit({
        requestId: request.requestId,
        namespaceId: null,
        snapshotId: null,
        trashId: null,
        operation: 'AUTH_REJECT_SUPPRESSED',
        path: null,
        detail: { suppressed: decision.suppressedBefore, windowSeconds: AUTH_REJECT_AUDIT_WINDOW_MS / 1000 },
        caller: null,
        status: 401,
      });
    }
    if (!decision.record) return;

    const path = sanitizeAuditString(request.path);
    this.recordAudit({
      requestId: request.requestId,
      namespaceId: null,
      snapshotId: null,
      trashId: null,
      // operation 컬럼은 기존 varchar(128) 계약을 유지하고 경로는 text path에 남긴다.
      operation: `${request.method} ${path}`.slice(0, 128),
      path,
      detail: null,
      caller: null,
      status: 401,
    });
  }

  private recordAudit(entry: AuditLogEntry): void {
    void this.auditLogRepository?.record(entry).catch((error: unknown) => {
      this.logger.error('감사 로그 기록 실패', error instanceof Error ? error.stack : String(error));
    });
  }
}
