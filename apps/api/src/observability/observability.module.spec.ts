import { jest } from '@jest/globals';
import { resolveErrorReporter } from './observability.module.js';
import { NoopErrorReporter } from './noop-error-reporter.js';
import { SentryErrorReporter, type SentryClient } from './sentry-error-reporter.js';

function createFakeClient(): jest.Mocked<SentryClient> {
  return { init: jest.fn(), captureException: jest.fn() };
}

describe('resolveErrorReporter', () => {
  it('STORIX_SENTRY_DSN이 있으면 SentryErrorReporter를 반환한다', () => {
    const client = createFakeClient();

    const reporter = resolveErrorReporter('https://public@example.sentry.io/1', client);

    expect(reporter).toBeInstanceOf(SentryErrorReporter);
    expect(client.init).toHaveBeenCalledWith({ dsn: 'https://public@example.sentry.io/1', sendDefaultPii: false });
  });

  it('STORIX_SENTRY_DSN이 없으면 NoopErrorReporter를 반환한다', () => {
    const client = createFakeClient();

    const reporter = resolveErrorReporter(undefined, client);

    expect(reporter).toBeInstanceOf(NoopErrorReporter);
    expect(client.init).not.toHaveBeenCalled();
  });
});
