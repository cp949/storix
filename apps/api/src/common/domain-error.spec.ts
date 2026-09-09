import { DomainError } from './domain-error.js';

class ServerError extends DomainError {
  readonly code = 'SERVER_ERROR';
  readonly status = 500;
}

class ClientError extends DomainError {
  readonly code = 'CLIENT_ERROR';
  readonly status = 400;
}

class OverriddenReportError extends DomainError {
  readonly code = 'OVERRIDDEN';
  readonly status = 400;

  override get shouldReport(): boolean {
    return true;
  }
}

describe('DomainError', () => {
  it('Error의 인스턴스다', () => {
    expect(new ServerError('boom')).toBeInstanceOf(Error);
  });

  it('status가 500 이상이면 shouldReport 기본값은 true다', () => {
    expect(new ServerError('boom').shouldReport).toBe(true);
  });

  it('status가 500 미만이면 shouldReport 기본값은 false다', () => {
    expect(new ClientError('bad').shouldReport).toBe(false);
  });

  it('서브클래스가 shouldReport를 override하면 기본값 대신 그 값을 쓴다', () => {
    expect(new OverriddenReportError('bad').shouldReport).toBe(true);
  });
});
