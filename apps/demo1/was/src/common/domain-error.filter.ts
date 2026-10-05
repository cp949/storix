import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ExternalPathResolutionError } from '../document-archive/document-archive.errors.js';
import { StorixApiError, StorixUpstreamUnauthorizedError } from '../storix-client/storix-client.errors.js';
import { DomainError } from './domain-error.js';

interface BodyParserError extends Error {
  readonly status: number;
  readonly type: string;
}

// body-parser(http-errors)는 4xx `status`와 `type`('entity.parse.failed', 'entity.too.large' 등)을 가진다.
function isBodyParserError(exception: unknown): exception is BodyParserError {
  if (!(exception instanceof Error)) return false;
  const { status, type } = exception as Partial<BodyParserError>;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string';
}

@Catch()
@Injectable()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();

    if (exception instanceof DomainError) {
      if (exception instanceof StorixApiError && exception.retryAfter !== undefined) {
        response.setHeader('Retry-After', exception.retryAfter);
      }
      if (exception.shouldReport) {
        let suffix = '';
        if (exception instanceof ExternalPathResolutionError) {
          suffix = ` (internalPath: ${exception.internalPath})`;
        } else if (exception instanceof StorixUpstreamUnauthorizedError) {
          suffix = ` (upstream 401 ${exception.upstreamCode} requestId=${exception.upstreamRequestId ?? '없음'})`;
        }
        this.logger.error(`${exception.message}${suffix}`, exception.stack);
      }
      response.status(exception.status).json({
        code: exception.code,
        message: exception.message,
        requestId: request.requestId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      // NestJS 자체 예외(라우트 미매칭 NotFoundException 등)는 DomainError가 아니지만
      // 진짜 HTTP 상태를 갖고 있다 — 이걸 500으로 뭉개면 404 요청도 500이 된다.
      response.status(exception.getStatus()).json({
        code: 'HTTP_ERROR',
        message: exception.message,
        requestId: request.requestId,
      });
      return;
    }

    if (isBodyParserError(exception)) {
      // express.json이 던지는 오류(잘못된 JSON 400, 본문 과대 413 등)다. HttpException이 아니라서 구분하지 않으면 500이 된다.
      response.status(exception.status).json({
        code: 'HTTP_ERROR',
        message: exception.message,
        requestId: request.requestId,
      });
      return;
    }

    this.logger.error('처리되지 않은 예외', exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: request.requestId,
    });
  }
}
