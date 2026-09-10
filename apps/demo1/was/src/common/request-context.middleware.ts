import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[\x20-\x7e]{1,200}$/;

function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
