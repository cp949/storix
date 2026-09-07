import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import type { MetricCounter, MetricHistogram, MetricsRegistry } from './metrics-registry.js';
import { METRICS_REGISTRY } from './observability.constants.js';

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly requestCounter: MetricCounter;
  private readonly durationHistogram: MetricHistogram;
  private readonly transferredBytesCounter: MetricCounter;

  constructor(@Inject(METRICS_REGISTRY) registry: MetricsRegistry) {
    this.requestCounter = registry.counter('storix_http_requests_total', 'HTTP 요청 수', ['operation', 'status']);
    this.durationHistogram = registry.histogram(
      'storix_http_request_duration_seconds',
      'HTTP 요청 처리 시간(초)',
      DURATION_BUCKETS_SECONDS,
      ['operation'],
    );
    this.transferredBytesCounter = registry.counter(
      'storix_http_transferred_bytes_total',
      'HTTP 요청/응답으로 전송된 바이트 합계',
      ['operation'],
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const operation = `${context.getClass().name}.${context.getHandler().name}`;

    response.once('close', () => {
      this.requestCounter.inc({ operation, status: String(response.statusCode) });
      this.durationHistogram.observe((Date.now() - request.startTime) / 1000, { operation });

      const byteCount = this.resolveByteCount(request, response);
      if (byteCount !== undefined) {
        this.transferredBytesCounter.inc({ operation }, byteCount);
      }
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
