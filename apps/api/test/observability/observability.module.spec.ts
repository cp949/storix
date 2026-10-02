import { Controller, Get, Logger, Module, UseFilters } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import { RequestContextMiddleware } from '../../src/common/request-context.middleware.js';
import type { ErrorReporter } from '../../src/observability/error-reporter.js';
import { ERROR_REPORTER } from '../../src/observability/observability.constants.js';
import { ObservabilityModule, resolveErrorReporter } from '../../src/observability/observability.module.js';
import { NoopErrorReporter } from '../../src/observability/noop-error-reporter.js';
import {
  SentryErrorReporter,
  scrubAuthorizationHeader,
  type SentryClient,
} from '../../src/observability/sentry-error-reporter.js';

function createFakeClient(): jest.Mocked<SentryClient> {
  return { init: jest.fn(), captureException: jest.fn() };
}

describe('resolveErrorReporter', () => {
  it('STORIX_SENTRY_DSN이 있으면 SentryErrorReporter를 반환한다', () => {
    const client = createFakeClient();

    const reporter = resolveErrorReporter('https://public@example.sentry.io/1', client);

    expect(reporter).toBeInstanceOf(SentryErrorReporter);
    expect(client.init).toHaveBeenCalledWith({
      dsn: 'https://public@example.sentry.io/1',
      sendDefaultPii: false,
      beforeSend: scrubAuthorizationHeader,
    });
  });

  it('STORIX_SENTRY_DSN이 없으면 NoopErrorReporter를 반환한다', () => {
    const client = createFakeClient();

    const reporter = resolveErrorReporter(undefined, client);

    expect(reporter).toBeInstanceOf(NoopErrorReporter);
    expect(client.init).not.toHaveBeenCalled();
  });
});

// ObservabilityModule을 import하지 않은 기능 모듈의 컨트롤러 단위 필터가 대상이다.
@Controller('reporter-probe')
@UseFilters(DomainErrorFilter)
class ReporterProbeController {
  @Get() fail(): never {
    throw new Error('probe failure');
  }
}

@Module({ controllers: [ReporterProbeController] })
class ReporterProbeModule {}

describe('ObservabilityModule', () => {
  it('다른 모듈 컨트롤러의 DomainErrorFilter에도 ERROR_REPORTER를 주입한다', async () => {
    const report = jest.fn<ErrorReporter['report']>();
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, ReporterProbeModule],
    })
      .overrideProvider(ERROR_REPORTER)
      .useValue({ report })
      .compile();
    const app = moduleRef.createNestApplication();
    const requestContext = new RequestContextMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) => requestContext.use(req, res, next));
    await app.init();
    try {
      await request(app.getHttpServer()).get('/reporter-probe').expect(500);
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      loggerErrorSpy.mockRestore();
    }
  });
});
