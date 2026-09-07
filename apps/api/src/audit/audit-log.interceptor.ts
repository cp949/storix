import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { isUuid } from '../common/uuid.js';
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

const MAX_AUDIT_STRING_LENGTH = 4096;
const CONTROL_CHARS = /[\x00-\x1f]/g;

// 요청 본문/쿼리는 공격자가 임의로 채울 수 있으므로, DB 컬럼(text/jsonb)이 거부하는
// NUL 등 제어 문자를 저장 전에 제거하고 길이를 제한해 감사 로그 기록 자체가
// 실패해 누락되는 일을 막는다.
function sanitizeAuditString(value: string): string {
  return value.replace(CONTROL_CHARS, '').slice(0, MAX_AUDIT_STRING_LENGTH);
}

function resolveStringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? sanitizeAuditString(value) : undefined;
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

  // params.id는 현재 NamespaceController(:id)만 쓰고 그 값은 항상 namespace id이므로 이 heuristic이
  // 성립한다. 앞으로 :id를 다른 의미로 쓰는 컨트롤러가 생기면 이 가정을 재검토해야 한다.
  private resolveNamespaceId(request: Request): string | null {
    const value = request.params.namespaceId ?? request.params.id;
    return typeof value === 'string' && isUuid(value) ? value : null;
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
