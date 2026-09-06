import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from './body-parser.js';
import { DomainErrorFilter } from './domain-error.filter.js';

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('configureBodyParsers의 요청 바디 크기 상한', () => {
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

  it('16KB 이하 JSON 바디는 정상 처리한다', async () => {
    const value = 'x'.repeat(100);

    await request(app.getHttpServer()).post('/probe/echo').send({ value }).expect(201, { value });
  });

  it('16KB를 초과하는 JSON 바디는 413을 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ value: 'x'.repeat(20_000) })
      .expect(413);

    expect(response.body).toMatchObject({
      code: 'BAD_REQUEST',
      requestId: expect.any(String),
    });
  });
});
