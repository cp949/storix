import { ArgumentsHost } from '@nestjs/common';
import { jest } from '@jest/globals';
import { DomainErrorFilter } from './domain-error.filter.js';

function createHost(requestId = 'req-1') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ requestId }),
    }),
  } as unknown as ArgumentsHost;

  return { host, json, status };
}

class FooError extends Error {
  readonly code = 'FOO';
  readonly status = 409;
}

class PathedError extends Error {
  readonly code = 'PATHED';
  readonly status = 404;

  constructor(readonly path: string) {
    super('경로를 찾을 수 없음');
  }
}

describe('DomainErrorFilter', () => {
  const filter = new DomainErrorFilter();

  it('code와 status를 가진 에러를 해당 status와 {code, message, requestId} body로 응답한다', () => {
    const { host, json, status } = createHost();

    filter.catch(new FooError('foo happened'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ code: 'FOO', message: 'foo happened', requestId: 'req-1' });
  });

  it('code/status가 없는 에러는 500과 고정 메시지로 응답하고 원본 메시지를 노출하지 않는다', () => {
    const { host, json, status } = createHost();

    filter.catch(new Error('storage key sk-123.bin 읽기 실패'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('Error가 아닌 값이 던져지면 500과 고정 메시지로 응답한다', () => {
    const { host, json, status } = createHost();

    filter.catch('문자열 예외', host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('exception에 path가 있으면 응답 body에 canonical path를 포함한다', () => {
    const { host, json } = createHost();

    filter.catch(new PathedError('/a/b'), host);

    expect(json).toHaveBeenCalledWith({
      code: 'PATHED',
      message: '경로를 찾을 수 없음',
      path: '/a/b',
      requestId: 'req-1',
    });
  });

  it('request의 requestId를 그대로 응답 body에 포함한다', () => {
    const { host, json } = createHost('req-xyz');

    filter.catch(new FooError('foo happened'), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-xyz' }));
  });

  it('exception에 code가 있어도 500 응답에서는 INTERNAL_ERROR로 대체한다', () => {
    const { host, json } = createHost();
    const thirdPartyError = Object.assign(new Error('duplicate key value'), { code: '23505' });

    filter.catch(thirdPartyError, host);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('exception에 path가 있어도 500 응답에서는 노출하지 않는다', () => {
    const { host, json } = createHost();
    const thirdPartyError = Object.assign(new Error('ENOENT'), { path: '/etc/passwd' });

    filter.catch(thirdPartyError, host);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('status는 있지만 code가 없는 예외(예: body-parser 오류)는 BAD_REQUEST로 응답한다', () => {
    const { host, json, status } = createHost();
    const bodyParserLikeError = Object.assign(new Error('Unexpected token b in JSON'), { status: 400 });

    filter.catch(bodyParserLikeError, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      code: 'BAD_REQUEST',
      message: 'Unexpected token b in JSON',
      requestId: 'req-1',
    });
  });
});
