import { Injectable } from '@nestjs/common';
import type { ErrorEvent, NodeOptions } from '@sentry/node';
import type { ErrorReporter } from './error-reporter.js';

// @sentry/node의 init/captureException만 필요한 만큼 좁혀 정의한다 — 실제 SDK를
// 테스트에서 직접 spy하지 않고 fake로 주입 가능하게 하기 위함이다.
export interface SentryClient {
  init(options: {
    dsn: string;
    dataCollection: NonNullable<NodeOptions['dataCollection']>;
    beforeSend: (event: ErrorEvent) => ErrorEvent;
  }): void;
  captureException(error: Error, hint?: { extra?: Record<string, unknown> }): void;
}

// @sentry/node 11은 sendDefaultPii 옵션이 없고 dataCollection을 생략하면 쿠키·IP·요청 본문·DB 쿼리 값까지
// 기본 수집한다. 10.x에서 sendDefaultPii=false였던 수집 범위를 그대로 고정한다(공식 마이그레이션 가이드의
// v10 기본값 보존 설정). 값을 비우거나 지워서 SDK 기본값으로 돌아가지 않게 하고, 키를 추가할 때도
// 기본 수집 여부를 확인한다.
export const SENTRY_DATA_COLLECTION: NonNullable<NodeOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
  },
  httpBodies: [],
  urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
  databaseQueryData: false,
  queues: false,
};

// @sentry/node 11은 Authorization 값을 "[Filtered]"로 바꿔 보낸다. 헤더 이름이 이벤트에 남지 않도록
// 전송 직전에 키 자체를 지운다. SDK 필터링 방식이 바뀌어도 Bearer API 키가 나가지 않게 하는 이중 방어다.
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
    this.client.init({ dsn, dataCollection: SENTRY_DATA_COLLECTION, beforeSend: scrubAuthorizationHeader });
  }

  report(error: Error, context?: Record<string, unknown>): void {
    this.client.captureException(error, context ? { extra: context } : undefined);
  }
}
