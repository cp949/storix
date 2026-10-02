import { Injectable } from '@nestjs/common';
import type { ErrorEvent } from '@sentry/node';
import type { ErrorReporter } from './error-reporter.js';

// @sentry/node의 init/captureException만 필요한 만큼 좁혀 정의한다 — 실제 SDK를
// 테스트에서 직접 spy하지 않고 fake로 주입 가능하게 하기 위함이다.
export interface SentryClient {
  init(options: {
    dsn: string;
    sendDefaultPii: boolean;
    beforeSend: (event: ErrorEvent) => ErrorEvent;
  }): void;
  captureException(error: Error, hint?: { extra?: Record<string, unknown> }): void;
}

// @sentry/node 10.73.0은 sendDefaultPii=false여도 오류 이벤트의 request.headers에서 cookie·IP 헤더만
// 지운다. Authorization 원문(Bearer API 키)은 남으므로 전송 직전에 직접 지운다.
export function scrubAuthorizationHeader(event: ErrorEvent): ErrorEvent {
  const headers = event.request?.headers;
  if (headers) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'authorization') {
        delete headers[name];
      }
    }
  }
  return event;
}

@Injectable()
export class SentryErrorReporter implements ErrorReporter {
  constructor(
    dsn: string,
    private readonly client: SentryClient,
  ) {
    this.client.init({ dsn, sendDefaultPii: false, beforeSend: scrubAuthorizationHeader });
  }

  report(error: Error, context?: Record<string, unknown>): void {
    this.client.captureException(error, context ? { extra: context } : undefined);
  }
}
