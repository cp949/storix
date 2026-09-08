import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { HealthIndicatorResult, TerminusModule, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from './health.controller.js';
import { MinioHealthIndicator } from './minio-health.indicator.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';

describe('HealthController', () => {
  let app: INestApplication;
  let dbPingCheck: jest.Mock<() => Promise<HealthIndicatorResult>>;
  let storageCheck: jest.Mock<() => Promise<HealthIndicatorResult>>;

  beforeEach(async () => {
    dbPingCheck = jest
      .fn<() => Promise<HealthIndicatorResult>>()
      .mockResolvedValue({ database: { status: 'up' } });
    storageCheck = jest
      .fn<() => Promise<HealthIndicatorResult>>()
      .mockResolvedValue({ storage: { status: 'up' } });

    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck: dbPingCheck },
        },
        { provide: MinioHealthIndicator, useValue: { check: storageCheck } },
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

  it('GET /health/ready는 PostgreSQL과 스토리지가 모두 정상이면 200을 반환한다', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('GET /health/ready는 PostgreSQL 연결이 끊기면 503을 반환한다', async () => {
    dbPingCheck.mockResolvedValue({
      database: { status: 'down', message: 'database down' },
    });

    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  it('GET /health/ready는 스토리지 버킷 접근이 불가하면 503을 반환한다', async () => {
    storageCheck.mockResolvedValue({
      storage: { status: 'down', message: 'storage down' },
    });

    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  it('헬스체크는 인증 없이 접근 가능하도록 @Public()이 적용되어 있다', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController)).toBe(true);
  });
});
