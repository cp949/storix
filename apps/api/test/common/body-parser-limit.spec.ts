import { Body, Controller, INestApplication, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

@Controller('api/v2/namespaces/:namespaceId/fs/snapshots')
class SnapshotMutationProbeController {
  @Post(':snapshotId/delete')
  echoRaw(@Req() req: Request) {
    return {
      isBuffer: Buffer.isBuffer(req.body),
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
    };
  }
}

@Controller('api/v2/namespaces/:namespaceId/fs')
class ArchiveProbeController {
  @Post('archive')
  echo(@Req() req: Request) {
    return { isBuffer: Buffer.isBuffer(req.body), size: Buffer.isBuffer(req.body) ? req.body.length : 0 };
  }
}

@Controller('api/v2/namespaces/:namespaceId/fs')
class ExtractProbeController {
  @Post('extract')
  echo(@Req() req: Request) {
    return {
      isBuffer: Buffer.isBuffer(req.body),
      size: Buffer.isBuffer(req.body) ? req.body.length : 0,
      body: Buffer.isBuffer(req.body) && req.body.length < 100 ? req.body.toString('utf8') : null,
    };
  }
}

@Module({
  controllers: [
    ProbeController,
    SnapshotMutationProbeController,
    ArchiveProbeController,
    ExtractProbeController,
  ],
})
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
      .post('/api/v2/namespaces/abc/fs/snapshots/not-a-uuid/delete')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(201, { isBuffer: true, body });
  });

  it('archive는 정확히 8 MiB JSON 원문을 보존하고 1 byte 초과 본문을 BAD_REQUEST 413으로 거부한다', async () => {
    // `{"value":"` + value + `"}` 형태라 JSON 전체 길이는 value 길이 + 12다.
    const limit = 8 * 1024 * 1024;
    const accepted = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/archive')
      .send({ value: 'x'.repeat(limit - 12) })
      .expect(201);
    expect(accepted.body).toEqual({ isBuffer: true, size: limit });
    const rejected = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/archive')
      .send({ value: 'x'.repeat(limit - 11) })
      .expect(413);
    expect(rejected.body).toMatchObject({ code: 'BAD_REQUEST', requestId: expect.any(String) });
  });

  it('extract는 JSON 원문을 raw Buffer로 보존하고 정확히 64 KiB까지 받으며 1 byte 초과는 BAD_REQUEST 413이다', async () => {
    const raw = '{"mode":"clean",  "source":"/a.zip"}';
    const echoed = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/extract')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(201);
    // 공백과 키 순서가 그대로여야 receipt fingerprint가 원문 기준으로 정해진다.
    expect(echoed.body).toEqual({ isBuffer: true, size: raw.length, body: raw });
    // `{"value":"` + value + `"}` 형태라 JSON 전체 길이는 value 길이 + 12다.
    const limit = 64 * 1024;
    const accepted = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/extract')
      .send({ value: 'x'.repeat(limit - 12) })
      .expect(201);
    expect(accepted.body).toMatchObject({ isBuffer: true, size: limit });
    const rejected = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/extract')
      .send({ value: 'x'.repeat(limit - 11) })
      .expect(413);
    expect(rejected.body).toMatchObject({ code: 'BAD_REQUEST', requestId: expect.any(String) });
  });

  it('JSON이 아닌 Content-Type의 extract 본문은 파서가 건너뛰어 빈 본문처럼 도달한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces/abc/fs/extract')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(201);
    expect(response.body).toMatchObject({ isBuffer: false, size: 0 });
  });
});
