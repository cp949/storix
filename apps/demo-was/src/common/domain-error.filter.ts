import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error.js';

@Catch()
@Injectable()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();

    if (exception instanceof DomainError) {
      if (exception.shouldReport) {
        this.logger.error(exception.message, exception.stack);
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

    this.logger.error('처리되지 않은 예외', exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: request.requestId,
    });
  }
}
