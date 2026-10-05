import type { INestApplication } from '@nestjs/common';
import { configureBodyParsers } from './body-parser.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { requestContextMiddleware } from './request-context.middleware.js';

/**
 * HTTP 파이프라인 배선이다. `main.ts`와 통합 테스트가 같은 순서를 쓴다.
 * body parser 오류도 필터를 거치므로 requestContext가 먼저 와야 오류 응답에 requestId가 실린다.
 */
export function configureHttpPipeline(app: INestApplication): void {
  app.use(requestContextMiddleware);
  configureBodyParsers(app);
  app.useGlobalFilters(new DomainErrorFilter());
}
