import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { AuditLogRepository } from '../persistence/audit-log.repository.js';

const CALLER_ID_HEADER = 'x-caller-id';
// 로그 삽입/개행을 막기 위해 request-context.middleware.ts의 requestId 검증과
// 동일한 기준(출력 가능 ASCII, 200자 이하)을 적용한다. caller는 자기신고 값이라
// requestId와 달리 없거나 유효하지 않으면 임의로 채우지 않고 null로 둔다.
const VALID_CALLER_ID = /^[\x20-\x7e]{1,200}$/;

export function resolveCallerId(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && VALID_CALLER_ID.test(value) ? value : null;
}

function resolveStringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogRepository: AuditLogRepository,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const operation = `${context.getClass().name}.${context.getHandler().name}`;

    response.once('close', () => {
      this.auditLogRepository
        .record({
          requestId: request.requestId,
          namespaceId: this.resolveNamespaceId(request),
          operation,
          path: this.resolvePath(request),
          detail: this.resolveDetail(request),
          caller: resolveCallerId(request.headers[CALLER_ID_HEADER]),
          status: response.statusCode,
        })
        .catch((error: unknown) => {
          this.logger.error('감사 로그 기록 실패', error instanceof Error ? error.stack : String(error));
        });
    });

    return next.handle();
  }

  private resolveNamespaceId(request: Request): string | null {
    const value = request.params.namespaceId ?? request.params.id;
    return typeof value === 'string' ? value : null;
  }

  private resolvePath(request: Request): string | null {
    const query = request.query as Record<string, unknown>;
    const body = request.body as Record<string, unknown> | undefined;
    return resolveStringField(query, 'path') ?? resolveStringField(body, 'path') ?? null;
  }

  private resolveDetail(request: Request): Record<string, unknown> | null {
    const body = request.body as Record<string, unknown> | undefined;
    const detail: Record<string, unknown> = {};
    const source = resolveStringField(body, 'source');
    const destination = resolveStringField(body, 'destination');
    const name = resolveStringField(body, 'name');
    if (source !== undefined) detail.source = source;
    if (destination !== undefined) detail.destination = destination;
    if (name !== undefined) detail.name = name;
    return Object.keys(detail).length > 0 ? detail : null;
  }
}
