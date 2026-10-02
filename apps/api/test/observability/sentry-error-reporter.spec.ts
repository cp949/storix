import { jest } from '@jest/globals';
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import {
  SentryErrorReporter,
  scrubAuthorizationHeader,
  type SentryClient,
} from '../../src/observability/sentry-error-reporter.js';

function createFakeClient(): jest.Mocked<SentryClient> {
  return {
    init: jest.fn(),
    captureException: jest.fn(),
  };
}

describe('SentryErrorReporter', () => {
  it('생성 시 주어진 DSN으로 Sentry 클라이언트를 초기화하고 기본 PII 전송을 끈다', () => {
    const client = createFakeClient();

    new SentryErrorReporter('https://public@example.sentry.io/1', client);

    expect(client.init).toHaveBeenCalledWith({
      dsn: 'https://public@example.sentry.io/1',
      sendDefaultPii: false,
      beforeSend: scrubAuthorizationHeader,
    });
  });

  it('report 호출 시 captureException으로 에러와 context를 extra로 전달한다', () => {
    const client = createFakeClient();
    const reporter = new SentryErrorReporter('https://public@example.sentry.io/1', client);
    const error = new Error('boom');

    reporter.report(error, { requestId: 'req-1', status: 500 });

    expect(client.captureException).toHaveBeenCalledWith(error, {
      extra: { requestId: 'req-1', status: 500 },
    });
  });

  it('context 없이 report를 호출하면 hint 없이 captureException을 호출한다', () => {
    const client = createFakeClient();
    const reporter = new SentryErrorReporter('https://public@example.sentry.io/1', client);
    const error = new Error('boom');

    reporter.report(error);

    expect(client.captureException).toHaveBeenCalledWith(error, undefined);
  });

  describe('scrubAuthorizationHeader', () => {
    it('request.headers의 authorization을 대소문자와 무관하게 지우고 다른 헤더는 유지한다', () => {
      const event = {
        type: undefined,
        request: {
          headers: {
            Authorization: 'Bearer secret-key',
            authorization: 'Bearer other',
            'x-request-id': 'req-1',
          },
        },
      } as ErrorEvent;

      const result = scrubAuthorizationHeader(event);

      expect(result.request?.headers).toEqual({ 'x-request-id': 'req-1' });
    });

    it('request나 headers가 없는 이벤트는 그대로 반환한다', () => {
      const event = { type: undefined } as ErrorEvent;

      expect(scrubAuthorizationHeader(event)).toBe(event);
    });
  });

  describe('실제 @sentry/node 연동', () => {
    it('Bearer 키를 보낸 요청의 오류 이벤트가 전송 전에 authorization 없이 beforeSend를 통과한다', async () => {
      const sent: ErrorEvent[] = [];
      Sentry.init({
        dsn: 'https://public@example.sentry.io/1',
        sendDefaultPii: false,
        beforeSend: (event) => {
          sent.push(scrubAuthorizationHeader(event));
          return null;
        },
      });

      Sentry.withIsolationScope((scope) => {
        scope.setSDKProcessingMetadata({
          normalizedRequest: { headers: { authorization: 'Bearer secret-key', host: 'storix.test' } },
        });
        Sentry.captureException(new Error('boom'));
      });
      await Sentry.flush(2000);
      await Sentry.close(2000);

      expect(sent).toHaveLength(1);
      // sdkProcessingMetadata는 SDK가 envelope 직렬화 전에 제거하므로 전송되는 request만 검사한다.
      expect(JSON.stringify(sent[0].request)).not.toContain('secret-key');
      expect(sent[0].request?.headers).toEqual({ host: 'storix.test' });
    });
  });
});
