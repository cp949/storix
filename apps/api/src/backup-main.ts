import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { BackupJob } from './jobs/backup.job.js';
import { JobsModule } from './jobs/jobs.module.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';
import { ObservabilityModule } from './observability/observability.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, JobsModule],
})
class BackupAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('BackupMain');
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(BackupAppModule, { abortOnError: false });
    const result = await app.get(BackupJob).run();
    logger.log(`Backup job 종료: ${JSON.stringify(result)}`);
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    logger.error('Backup job 실패', error instanceof Error ? error.stack : String(error));
    const errorReporter = app?.get<ErrorReporter>(ERROR_REPORTER, { strict: false });
    errorReporter?.report(error instanceof Error ? error : new Error(String(error)), { operation: 'BackupJob.run' });
    process.exitCode = 1;
  }
}

bootstrap();
