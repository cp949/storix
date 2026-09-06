import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    startTime: number;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// 로그 삽입/개행을 막기 위해 출력 가능한 ASCII 문자만 허용하고 길이를 제한한다.
const VALID_REQUEST_ID = /^[\x20-\x7e]{1,200}$/;

function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (req.requestId) {
      next();
      return;
    }
    req.requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    req.startTime = Date.now();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  }
}
