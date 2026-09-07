import { jest } from '@jest/globals';
import { SentryErrorReporter, type SentryClient } from './sentry-error-reporter.js';

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

    expect(client.init).toHaveBeenCalledWith({ dsn: 'https://public@example.sentry.io/1', sendDefaultPii: false });
  });

  it('report 호출 시 captureException으로 에러와 context를 extra로 전달한다', () => {
    const client = createFakeClient();
    const reporter = new SentryErrorReporter('https://public@example.sentry.io/1', client);
    const error = new Error('boom');

    reporter.report(error, { requestId: 'req-1', status: 500 });

    expect(client.captureException).toHaveBeenCalledWith(error, { extra: { requestId: 'req-1', status: 500 } });
  });

  it('context 없이 report를 호출하면 hint 없이 captureException을 호출한다', () => {
    const client = createFakeClient();
    const reporter = new SentryErrorReporter('https://public@example.sentry.io/1', client);
    const error = new Error('boom');

    reporter.report(error);

    expect(client.captureException).toHaveBeenCalledWith(error, undefined);
  });
});
