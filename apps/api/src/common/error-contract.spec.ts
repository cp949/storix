import {
  Body,
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from './body-parser.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { StructuredLoggingInterceptor } from './structured-logging.interceptor.js';

class KnownError extends Error {
  readonly code = 'KNOWN_ERROR';
  readonly status = 404;

  constructor(readonly path: string) {
    super('알려진 대상 없음');
  }
}

@Controller('probe')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
class ProbeController {
  @Get('known-error')
  knownError(): never {
    throw new KnownError('/probe/target');
  }

  @Get('unknown-error')
  unknownError(): never {
    throw new Error('storage key sk-should-not-leak.bin 처리 실패');
  }

  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes(ProbeController);
  }
}

describe('오류 응답 계약 (미들웨어+필터+인터셉터 파이프라인)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.useGlobalFilters(new DomainErrorFilter());
    configureBodyParsers(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('알려진 도메인 에러는 code/message/path/requestId를 포함한 해당 status로 응답한다', async () => {
    const response = await request(app.getHttpServer()).get('/probe/known-error').expect(404);

    expect(response.body).toEqual({
      code: 'KNOWN_ERROR',
      message: '알려진 대상 없음',
      path: '/probe/target',
      requestId: expect.any(String),
    });
  });

  it('알 수 없는 예외는 500과 고정 메시지로 응답하고 원본 메시지를 노출하지 않는다', async () => {
    const response = await request(app.getHttpServer()).get('/probe/unknown-error').expect(500);

    expect(response.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('storage key');
  });

  it('인바운드 X-Request-Id 헤더를 성공 응답에도 그대로 반영한다', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('X-Request-Id', 'caller-trace-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('caller-trace-id');
  });

  it('body-parser가 던진 400은 code/requestId를 포함한다(모듈 미들웨어를 거치지 않는 예외)', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken": ')
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'BAD_REQUEST',
      requestId: expect.any(String),
    });
  });

  it('정상 JSON 요청은 echo 라우트에서 그대로 처리된다', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ hello: 'world' })
      .expect(201);

    expect(response.body).toEqual({ received: { hello: 'world' } });
  });
});
