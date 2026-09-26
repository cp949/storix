import { ArgumentsHost, Catch, ExceptionFilter, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error.js';
import { StorageFailureError, StorageUnavailableError } from './storage-failure.errors.js';
import type { ErrorReporter } from '../observability/error-reporter.js';
import { ERROR_REPORTER } from '../observability/observability.constants.js';

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

  constructor(@Optional() @Inject(ERROR_REPORTER) private readonly errorReporter?: ErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = resolveErrorStatus(exception);

    if (status === 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
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

    response.status(status).json({
      code: resolveErrorCode(exception, status),
      message: resolveErrorMessage(exception, status),
      path: resolveErrorPath(exception),
      ...resolveErrorCurrent(exception),
      requestId: request.requestId,
    });
  }
}
