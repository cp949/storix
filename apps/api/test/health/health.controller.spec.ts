import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { HealthIndicatorResult, TerminusModule, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from '../../src/health/health.controller.js';
import { StorageHealthIndicator } from '../../src/health/storage-health.indicator.js';
import { IS_PUBLIC_KEY } from '../../src/auth/public.decorator.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';

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
        { provide: StorageHealthIndicator, useValue: { check: storageCheck } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainErrorFilter());
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

  it('GET /health/ready 503은 표준 오류 형태로 응답하고 indicator 상세를 노출하지 않는다', async () => {
    storageCheck.mockResolvedValue({
      storage: { status: 'down', message: 'bucket not found: secret-bucket' },
    });

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable Exception' });
    expect(JSON.stringify(response.body)).not.toContain('secret-bucket');
  });

  it('없는 라우트는 404 NOT_FOUND로 응답한다', async () => {
    const response = await request(app.getHttpServer()).get('/health/nope').expect(404);

    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('헬스체크는 인증 없이 접근 가능하도록 @Public()이 적용되어 있다', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController)).toBe(true);
  });
});
