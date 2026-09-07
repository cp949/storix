import { Injectable } from '@nestjs/common';
import type { ErrorReporter } from './error-reporter.js';

// @sentry/node의 init/captureException만 필요한 만큼 좁혀 정의한다 — 실제 SDK를
// 테스트에서 직접 spy하지 않고 fake로 주입 가능하게 하기 위함이다.
export interface SentryClient {
  init(options: { dsn: string; sendDefaultPii: boolean }): void;
  captureException(error: Error, hint?: { extra?: Record<string, unknown> }): void;
}

@Injectable()
export class SentryErrorReporter implements ErrorReporter {
  constructor(
    dsn: string,
    private readonly client: SentryClient,
  ) {
    this.client.init({ dsn, sendDefaultPii: false });
  }

  report(error: Error, context?: Record<string, unknown>): void {
    this.client.captureException(error, context ? { extra: context } : undefined);
  }
}
