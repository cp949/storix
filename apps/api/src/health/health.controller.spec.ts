import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { HealthIndicatorResult, TerminusModule, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from './health.controller.js';
import { MinioHealthIndicator } from './minio-health.indicator.js';

describe('HealthController', () => {
  let app: INestApplication;
  let dbPingCheck: jest.Mock<() => Promise<HealthIndicatorResult>>;
  let minioCheck: jest.Mock<() => Promise<HealthIndicatorResult>>;

  beforeEach(async () => {
    dbPingCheck = jest
      .fn<() => Promise<HealthIndicatorResult>>()
      .mockResolvedValue({ database: { status: 'up' } });
    minioCheck = jest
      .fn<() => Promise<HealthIndicatorResult>>()
      .mockResolvedValue({ minio: { status: 'up' } });

    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck: dbPingCheck },
        },
        { provide: MinioHealthIndicator, useValue: { check: minioCheck } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health/live는 항상 200을 반환한다', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });

  it('GET /health/ready는 PostgreSQL과 MinIO가 모두 정상이면 200을 반환한다', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('GET /health/ready는 PostgreSQL 연결이 끊기면 503을 반환한다', async () => {
    dbPingCheck.mockResolvedValue({
      database: { status: 'down', message: 'database down' },
    });

    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  it('GET /health/ready는 MinIO bucket 접근이 불가하면 503을 반환한다', async () => {
    minioCheck.mockResolvedValue({
      minio: { status: 'down', message: 'minio down' },
    });

    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
});
