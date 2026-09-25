import { Body, Controller, INestApplication, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
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

@Controller('api/v1/namespaces/:namespaceId/fs/snapshots')
class SnapshotMutationProbeController {
  @Post(':snapshotId/delete')
  echoRaw(@Req() req: Request) {
    return {
      isBuffer: Buffer.isBuffer(req.body),
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
    };
  }
}

@Module({ controllers: [ProbeController, SnapshotMutationProbeController] })
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

  it('UUID 형식이 아닌 snapshot mutation 경로도 JSON 원본 bytes를 raw Buffer로 전달한다', async () => {
    const body = '{"different":true}';

    await request(app.getHttpServer())
      .post('/api/v1/namespaces/abc/fs/snapshots/not-a-uuid/delete')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(201, { isBuffer: true, body });
  });
});
