import { createServer } from 'node:http';
import { MAX_TIMER_MS } from '../../src/common/env-parsing.js';
import { applyUploadRequestTimeout } from '../../src/common/http-server-timeouts.js';
import {
  DEFAULT_MAX_UPLOAD_SECONDS,
  MAX_UPLOAD_SECONDS_LIMIT,
  parseMaxUploadSeconds,
} from '../../src/common/upload-duration.js';

describe('parseMaxUploadSeconds', () => {
  it('값이 없으면 24시간이다', () => {
    expect(parseMaxUploadSeconds(undefined)).toBe(DEFAULT_MAX_UPLOAD_SECONDS);
    expect(DEFAULT_MAX_UPLOAD_SECONDS).toBe(86_400);
  });

  it('상한은 setTimeout이 받는 최대 ms를 초로 내린 값이다', () => {
    expect(MAX_UPLOAD_SECONDS_LIMIT * 1000).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect((MAX_UPLOAD_SECONDS_LIMIT + 1) * 1000).toBeGreaterThan(MAX_TIMER_MS);
  });

  it('상한과 같은 값은 받는다', () => {
    expect(parseMaxUploadSeconds(String(MAX_UPLOAD_SECONDS_LIMIT))).toBe(MAX_UPLOAD_SECONDS_LIMIT);
  });

  // 30일(2592000초)을 ms로 바꾸면 setTimeout 한도를 넘어 타이머가 1ms 뒤에 발화해 모든 업로드가 즉시 끊긴다.
  it('상한을 넘는 값은 부팅 단계에서 거부한다', () => {
    expect(() => parseMaxUploadSeconds(String(MAX_UPLOAD_SECONDS_LIMIT + 1))).toThrow(
      '잘못된 정수 환경변수 값',
    );
    expect(() => parseMaxUploadSeconds('2592000')).toThrow('잘못된 정수 환경변수 값');
  });

  it('양의 정수 표기가 아닌 값은 거부한다', () => {
    expect(() => parseMaxUploadSeconds('0')).toThrow();
    expect(() => parseMaxUploadSeconds('1e3')).toThrow();
  });
});

describe('applyUploadRequestTimeout', () => {
  it('요청 수신 상한을 업로드 최대 지속 시간(ms)에 맞춘다', () => {
    const server = createServer();

    applyUploadRequestTimeout(server, '3600');

    expect(server.requestTimeout).toBe(3_600_000);
  });

  // Node 기본값 300초가 남으면 느린 대용량 업로드가 문서의 24시간 상한보다 먼저 408로 끊긴다.
  it('값이 없으면 기본 24시간을 적용해 Node 기본값 300초를 넘긴다', () => {
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);

    applyUploadRequestTimeout(server, undefined);

    expect(server.requestTimeout).toBe(DEFAULT_MAX_UPLOAD_SECONDS * 1000);
  });

  it('헤더 수신 상한은 건드리지 않는다', () => {
    const server = createServer();
    const headersTimeout = server.headersTimeout;

    applyUploadRequestTimeout(server, '3600');

    expect(server.headersTimeout).toBe(headersTimeout);
  });

  it('잘못된 값이면 서버 설정을 바꾸지 않고 거부한다', () => {
    const server = createServer();

    expect(() => applyUploadRequestTimeout(server, '2592000')).toThrow('잘못된 정수 환경변수 값');
    expect(server.requestTimeout).toBe(300_000);
  });
});
