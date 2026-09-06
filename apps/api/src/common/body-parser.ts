import { json, urlencoded } from 'express';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { RequestContextMiddleware } from './request-context.middleware.js';

/**
 * PUT .../fs/content 라우트는 요청 본문을 raw stream 그대로 읽어야 하므로
 * Express의 기본 json/urlencoded 파서가 스트림을 미리 소비하면 안 된다.
 */
export function isRawUploadRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'PUT' && req.path.toLowerCase().replace(/\/+$/, '').endsWith('/fs/content');
}

// JSON/urlencoded 요청은 제어 데이터만 다루므로 namespace별 조정 대신 고정 상한으로
// 조기 차단한다. raw 업로드는 이 파서를 우회하고 별도 파일 크기 상한을 적용한다.
const JSON_BODY_LIMIT = '16kb';

function matchesContentType(req: Request, expected: string): boolean {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === expected;
}

/**
 * NestFactory.create(AppModule, { bodyParser: false })로 기본 body-parser를 끈 뒤,
 * PUT .../fs/content 라우트만 제외하고 json/urlencoded 파서를 동일하게 재적용한다.
 *
 * requestId 미들웨어를 파서보다 먼저 등록하는 이유: body-parser가 던지는 예외(잘못된
 * JSON, 크기 초과)는 Nest 모듈 미들웨어(RequestContextMiddleware)보다 앞선 단계에서
 * 발생하므로, 여기서 먼저 req.requestId를 부착해두지 않으면 그 예외들은 requestId 없이
 * 응답된다. RequestContextMiddleware는 멱등이므로 이후 모듈 미들웨어에서 다시 실행돼도
 * 안전하다.
 */
export function configureBodyParsers(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter().getInstance();
  const requestContextMiddleware = new RequestContextMiddleware();
  httpAdapter.use((req: Request, res: Response, next: NextFunction) => requestContextMiddleware.use(req, res, next));
  httpAdapter.use(
    json({
      limit: JSON_BODY_LIMIT,
      type: (req: IncomingMessage) =>
        !isRawUploadRoute(req as Request) && matchesContentType(req as Request, 'application/json'),
    }),
  );
  httpAdapter.use(
    urlencoded({
      extended: true,
      limit: JSON_BODY_LIMIT,
      type: (req: IncomingMessage) =>
        !isRawUploadRoute(req as Request) &&
        matchesContentType(req as Request, 'application/x-www-form-urlencoded'),
    }),
  );
}
