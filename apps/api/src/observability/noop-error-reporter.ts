import { Injectable } from '@nestjs/common';
import type { ErrorReporter } from './error-reporter.js';

// STORIX_SENTRY_DSN 미설정 시 사용되는 기본 구현 — 의도적으로 아무 것도 하지 않는다.
@Injectable()
export class NoopErrorReporter implements ErrorReporter {
  report(_error: Error, _context?: Record<string, unknown>): void {}
}
