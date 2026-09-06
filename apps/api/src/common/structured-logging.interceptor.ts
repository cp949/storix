import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

@Injectable()
export class StructuredLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(StructuredLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const operation = `${context.getClass().name}.${context.getHandler().name}`;

    // 'finish'는 성공 완료 시에만 발생한다. 클라이언트 중단이나 스트림 오류로 응답이
    // destroy되는 경우(예: fs.controller.ts의 다운로드 pipeline 실패)에도 로그가
    // 남도록 'close'를 쓴다 — 'close'는 성공/실패 양쪽 모두, 'finish' 발생 여부와
    // 무관하게 항상 발생한다.
    response.once('close', () => {
      this.logger.log(
        JSON.stringify({
          requestId: request.requestId,
          namespaceId: request.params.namespaceId ?? request.params.id,
          operation,
          status: response.statusCode,
          duration: Date.now() - request.startTime,
          byteCount: this.resolveByteCount(request, response),
        }),
      );
    });

    return next.handle();
  }

  private resolveByteCount(request: Request, response: Response): number | undefined {
    const requestLength = Number(request.headers['content-length']);
    if (Number.isFinite(requestLength)) {
      return requestLength;
    }
    const responseLength = Number(response.getHeader('content-length'));
    return Number.isFinite(responseLength) ? responseLength : undefined;
  }
}
