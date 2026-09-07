import { NoopErrorReporter } from './noop-error-reporter.js';

describe('NoopErrorReporter', () => {
  it('report를 호출해도 예외를 던지지 않는다', () => {
    const reporter = new NoopErrorReporter();

    expect(() => reporter.report(new Error('boom'), { requestId: 'req-1' })).not.toThrow();
  });

  it('context 없이 호출해도 예외를 던지지 않는다', () => {
    const reporter = new NoopErrorReporter();

    expect(() => reporter.report(new Error('boom'))).not.toThrow();
  });
});
