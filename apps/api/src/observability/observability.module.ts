import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { parseOptionalString } from '../common/env-parsing.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsInterceptor } from './metrics.interceptor.js';
import { NoopErrorReporter } from './noop-error-reporter.js';
import type { ErrorReporter } from './error-reporter.js';
import { ERROR_REPORTER, METRICS_REGISTRY } from './observability.constants.js';
import { PrometheusMetricsRegistry } from './prometheus-metrics-registry.js';
import { SentryErrorReporter, type SentryClient } from './sentry-error-reporter.js';

export function resolveErrorReporter(dsn: string | undefined, client: SentryClient): ErrorReporter {
  return dsn ? new SentryErrorReporter(dsn, client) : new NoopErrorReporter();
}

@Module({
  controllers: [MetricsController],
  providers: [
    PrometheusMetricsRegistry,
    { provide: METRICS_REGISTRY, useExisting: PrometheusMetricsRegistry },
    {
      provide: ERROR_REPORTER,
      useFactory: (config: ConfigService) => resolveErrorReporter(parseOptionalString(config.get<string>('SENTRY_DSN')), Sentry),
      inject: [ConfigService],
    },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [METRICS_REGISTRY, ERROR_REPORTER, PrometheusMetricsRegistry],
})
export class ObservabilityModule {}
