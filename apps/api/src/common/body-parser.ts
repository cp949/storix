import { json, raw, urlencoded } from 'express';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { RequestContextMiddleware } from './request-context.middleware.js';

/**
 * POST .../fs/content 라우트는 요청 본문을 raw stream 그대로 읽어야 하므로
 * Express의 기본 json/urlencoded 파서가 스트림을 미리 소비하면 안 된다.
 */
export function isRawUploadRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  return (
    (req.method === 'POST' && (path.endsWith('/fs/content') || path.endsWith('/fs/content/conditional'))) ||
    (req.method === 'PUT' && /\/fs\/upload-sessions\/[^/]+\/parts\/[^/]+$/.test(path))
  );
}

export function isMutationJsonRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'POST' && req.path.toLowerCase().replace(/\/+$/, '').endsWith('/fs/mutations');
}

export function isSnapshotJsonMutationRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  return (
    req.method.toUpperCase() === 'POST' &&
    (/\/fs\/snapshots(?:\/[^/]+\/(?:restore|delete))?$/.test(path) ||
      /\/fs\/trash\/[^/]+\/(?:restore|purge)$/.test(path))
  );
}

// JSON/urlencoded 요청은 제어 데이터만 다루므로 namespace별 조정 대신 고정 상한으로
// 조기 차단한다. raw 업로드는 이 파서를 우회하고 별도 파일 크기 상한을 적용한다.
const JSON_BODY_LIMIT = '16kb';

function matchesContentType(req: Request, expected: string): boolean {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === expected;
}

/**
 * 본문이 있는데 JSON 파서가 읽지 않은 요청인지 판정한다. JSON이 아닌 Content-Type의 본문은
 * 파서가 건너뛰어 컨트롤러에는 빈 본문과 구분되지 않게 도달한다. 본문이 선택 사항인 라우트가
 * 이를 거부하지 않으면 요청 필드(예: trash restore의 `targetPath`)가 조용히 사라진다.
 */
export function hasUnparsedBody(req: Pick<Request, 'headers'>): boolean {
  if (matchesContentType(req as Request, 'application/json')) return false;
  const length = req.headers['content-length'];
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (typeof length === 'string' && length.trim() !== '' && Number(length) !== 0)
  );
}

/**
 * NestFactory.create(AppModule, { bodyParser: false })로 기본 body-parser를 끈 뒤,
 * POST .../fs/content 라우트만 제외하고 json/urlencoded 파서를 동일하게 재적용한다.
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
  httpAdapter.use((req: Request, res: Response, next: NextFunction) =>
    requestContextMiddleware.use(req, res, next),
  );
  httpAdapter.use(
    raw({
      limit: JSON_BODY_LIMIT,
      type: (req: IncomingMessage) =>
        (isMutationJsonRoute(req as Request) || isSnapshotJsonMutationRoute(req as Request)) &&
        matchesContentType(req as Request, 'application/json'),
    }),
  );
  httpAdapter.use(
    json({
      limit: JSON_BODY_LIMIT,
      type: (req: IncomingMessage) =>
        !isRawUploadRoute(req as Request) &&
        !isMutationJsonRoute(req as Request) &&
        !isSnapshotJsonMutationRoute(req as Request) &&
        matchesContentType(req as Request, 'application/json'),
    }),
  );
  httpAdapter.use(
    urlencoded({
      extended: true,
      limit: JSON_BODY_LIMIT,
      type: (req: IncomingMessage) =>
        !isRawUploadRoute(req as Request) &&
        !isMutationJsonRoute(req as Request) &&
        !isSnapshotJsonMutationRoute(req as Request) &&
        matchesContentType(req as Request, 'application/x-www-form-urlencoded'),
    }),
  );
  httpAdapter.use(dropParserErrorCode);
}

/**
 * 파서 단계 오류의 라이브러리 `code`(압축 해제의 `Z_DATA_ERROR`, 입력에 따라 번호가 달라지는 brotli의
 * `ERR__ERROR_FORMAT_PADDING_N`, `ECONNABORTED`)를 지운다. 필터는 문자열 code를 그대로 응답하므로
 * 지우지 않으면 공개 계약의 `BAD_REQUEST` 대신 외부 라이브러리 코드가 나간다.
 * 범위를 파서 직후로 한정해, 다른 경로의 code(`DB_BUSY` 등)는 건드리지 않는다.
 */
export function dropParserErrorCode(error: unknown, _req: Request, _res: Response, next: NextFunction): void {
  const { status, code, message, type } = (error ?? {}) as Record<string, unknown>;
  if (typeof status !== 'number' || typeof code !== 'string') {
    next(error);
    return;
  }
  next(Object.assign(new Error(typeof message === 'string' ? message : undefined), { status, type }));
}
