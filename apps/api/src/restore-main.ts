import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JobsModule } from './jobs/jobs.module.js';
import { RestoreJob } from './jobs/restore.job.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';
import { ObservabilityModule } from './observability/observability.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, JobsModule],
})
class RestoreAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('RestoreMain');
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(RestoreAppModule, { abortOnError: false });
    const result = await app.get(RestoreJob).run();
    logger.log(`Restore job 종료: ${JSON.stringify(result)}`);
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    logger.error('Restore job 실패', error instanceof Error ? error.stack : String(error));
    const errorReporter = app?.get<ErrorReporter>(ERROR_REPORTER, { strict: false });
    errorReporter?.report(error instanceof Error ? error : new Error(String(error)), { operation: 'RestoreJob.run' });
    process.exitCode = 1;
  }
}

bootstrap();
