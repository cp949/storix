import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import { RequestContextMiddleware } from '../../src/common/request-context.middleware.js';
import { ApiKeyGuard } from '../../src/auth/api-key.guard.js';
import { VALID_API_KEYS } from '../../src/auth/auth.constants.js';
import { Public } from '../../src/auth/public.decorator.js';

@Controller('probe')
class ProbeController {
  @Get('protected')
  protectedRoute() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: VALID_API_KEYS, useValue: ['current-key', 'previous-key'] },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
class ProbeModule {}

describe('서비스 간 인증 파이프라인 (ApiKeyGuard 전역 적용)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    const requestContext = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) => requestContext.use(req, res, next));
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('@Public() 라우트는 인증 없이 접근 가능하다', async () => {
    await request(app.getHttpServer()).get('/probe/public').expect(200, { ok: true });
  });

  it('Authorization 헤더 없이 보호된 라우트에 접근하면 401을 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/protected')
      .set('X-Request-Id', 'missing-key-request')
      .expect(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED', requestId: 'missing-key-request' });
    expect(response.headers['x-request-id']).toBe('missing-key-request');
  });

  it('현재 키로 보호된 라우트에 접근하면 통과한다', async () => {
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', 'Bearer current-key')
      .expect(200, { ok: true });
  });

  it('이전 키로도 보호된 라우트에 접근할 수 있다', async () => {
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', 'Bearer previous-key')
      .expect(200, { ok: true });
  });

  it('잘못된 키로 접근하면 401을 반환한다', async () => {
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', 'Bearer wrong-key')
      .set('X-Request-Id', 'wrong-key-request')
      .expect(401)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'UNAUTHORIZED', requestId: 'wrong-key-request' }),
      );
  });
});
