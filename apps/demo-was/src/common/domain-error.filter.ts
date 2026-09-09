import { ArgumentsHost, Catch, ExceptionFilter, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error.js';

@Catch()
@Injectable()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();

    if (!(exception instanceof DomainError)) {
      this.logger.error('처리되지 않은 예외', exception instanceof Error ? exception.stack : String(exception));
      response.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: request.requestId,
      });
      return;
    }

    if (exception.shouldReport) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(exception.status).json({
      code: exception.code,
      message: exception.message,
      requestId: request.requestId,
    });
  }
}
