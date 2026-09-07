import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MetricsController } from './metrics.controller.js';
import { PrometheusMetricsRegistry } from './prometheus-metrics-registry.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';

describe('MetricsController', () => {
  let app: INestApplication;
  let registry: PrometheusMetricsRegistry;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [PrometheusMetricsRegistry],
    }).compile();

    app = moduleRef.createNestApplication();
    registry = moduleRef.get(PrometheusMetricsRegistry);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /metrics는 200과 등록된 지표를 Prometheus 텍스트 포맷으로 반환한다', async () => {
    registry.counter('test_probe_total', 'test help').inc();

    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(response.text).toContain('test_probe_total 1');
  });

  it('GET /metrics는 Prometheus text exposition Content-Type을 반환한다', async () => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('metrics 엔드포인트는 인증 없이 접근 가능하도록 @Public()이 적용되어 있다', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetricsController)).toBe(true);
  });
});
