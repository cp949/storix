import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextMiddleware } from './request-context.middleware.js';

function createReqRes(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const setHeader = jest.fn();
  const res = { setHeader } as unknown as Response;
  return { req, res, setHeader };
}

describe('RequestContextMiddleware', () => {
  const middleware = new RequestContextMiddleware();

  it('유효한 X-Request-Id 헤더가 있으면 그대로 재사용하고 응답 헤더에도 반영한다', () => {
    const { req, res, setHeader } = createReqRes({ 'x-request-id': 'caller-supplied-id' });
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(req.requestId).toBe('caller-supplied-id');
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'caller-supplied-id');
    expect(next).toHaveBeenCalled();
  });

  it('X-Request-Id 헤더가 없으면 새 UUID를 생성한다', () => {
    const { req, res } = createReqRes();

    middleware.use(req, res, jest.fn() as unknown as NextFunction);

    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('제어 문자가 포함된 X-Request-Id는 무시하고 새로 생성한다', () => {
    const { req, res } = createReqRes({ 'x-request-id': 'bad\nid' });

    middleware.use(req, res, jest.fn() as unknown as NextFunction);

    expect(req.requestId).not.toBe('bad\nid');
  });

  it('startTime을 현재 시각에 가까운 값으로 기록한다', () => {
    const { req, res } = createReqRes();
    const before = Date.now();

    middleware.use(req, res, jest.fn() as unknown as NextFunction);

    expect(req.startTime).toBeGreaterThanOrEqual(before);
    expect(req.startTime).toBeLessThanOrEqual(Date.now());
  });

  it('이미 requestId가 설정되어 있으면 재생성하지 않는다', () => {
    const { req, res } = createReqRes();
    middleware.use(req, res, jest.fn() as unknown as NextFunction);
    const firstId = req.requestId;
    const firstStartTime = req.startTime;

    middleware.use(req, res, jest.fn() as unknown as NextFunction);

    expect(req.requestId).toBe(firstId);
    expect(req.startTime).toBe(firstStartTime);
  });
});
