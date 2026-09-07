import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

interface DomainErrorShape {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly path?: unknown;
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

export function resolveErrorMessage(exception: unknown, status: number): string {
  if (status === 500) {
    return INTERNAL_ERROR_MESSAGE;
  }
  return exception instanceof Error ? exception.message : INTERNAL_ERROR_MESSAGE;
}

@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status = resolveErrorStatus(exception);

    if (status === 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
      response.status(500).json({
        code: 'INTERNAL_ERROR',
        message: INTERNAL_ERROR_MESSAGE,
        requestId: request.requestId,
      });
      return;
    }

    response.status(status).json({
      code: resolveErrorCode(exception, status),
      message: resolveErrorMessage(exception, status),
      path: resolveErrorPath(exception),
      requestId: request.requestId,
    });
  }
}
