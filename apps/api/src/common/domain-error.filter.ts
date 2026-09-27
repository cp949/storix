import { ArgumentsHost, Catch, ExceptionFilter, Inject, Injectable, Logger, Optional } from '@nestjs/common';
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

export function resolveErrorCode(exception: unknown, status: number): string {
  const code = (exception as DomainErrorShape)?.code;
  if (typeof code === 'string') {
    return code;
  }
  return status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
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
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = resolveErrorStatus(exception);

    if (exception instanceof InvalidApiKeyError && this.auditLogRepository) {
      void this.auditLogRepository.record({
        requestId: request.requestId,
        namespaceId: null,
        snapshotId: null,
        // operation 컬럼은 기존 varchar(128) 계약을 유지하고 전체 경로는 text path에 남긴다.
        operation: `${request.method} ${request.path}`.slice(0, 128),
        path: request.path,
        detail: null,
        caller: null,
        status: 401,
      }).catch((error: unknown) => {
        this.logger.error('감사 로그 기록 실패', error instanceof Error ? error.stack : String(error));
      });
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
        code: exception instanceof StorageFailureError ? exception.code : 'INTERNAL_ERROR',
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
}
