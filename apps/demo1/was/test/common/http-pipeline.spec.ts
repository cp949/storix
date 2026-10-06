import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttpPipeline } from '../../src/common/http-pipeline.js';

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

describe('configureHttpPipeline', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpPipeline(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('잘못된 JSON은 400 HTTP_ERROR이고 응답 헤더와 같은 requestId를 싣는다', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('X-Request-Id', 'req-from-client')
      .set('content-type', 'application/json')
      .send('{bad')
      .expect(400);

    expect(response.body).toMatchObject({ code: 'HTTP_ERROR', requestId: 'req-from-client' });
    expect(response.headers['x-request-id']).toBe('req-from-client');
  });

  it('본문이 JSON parser 상한을 넘으면 500이 아니라 413 HTTP_ERROR이고 requestId를 싣는다', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ filler: 'x'.repeat(200_000) }))
      .expect(413);

    expect(response.body.code).toBe('HTTP_ERROR');
    expect(typeof response.body.requestId).toBe('string');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('정상 JSON 본문은 그대로 컨트롤러에 전달한다', async () => {
    const response = await request(app.getHttpServer()).post('/probe/echo').send({ path: '/a' }).expect(201);

    expect(response.body).toEqual({ path: '/a' });
  });
});
