import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { RestoreJobModule } from './jobs/restore-job.module.js';
import { RestoreJob } from './jobs/restore.job.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';
import { ObservabilityModule } from './observability/observability.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, RestoreJobModule],
})
class RestoreAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('RestoreMain');
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(RestoreAppModule, { abortOnError: false });
    const result = await app.get(RestoreJob).run();
    logger.log(`Restore job 종료: ${JSON.stringify(result)}`);
    process.exitCode = 0;
  } catch (error) {
    logger.error('Restore job 실패', error instanceof Error ? error.stack : String(error));
    const errorReporter = app?.get<ErrorReporter>(ERROR_REPORTER, { strict: false });
    errorReporter?.report(error instanceof Error ? error : new Error(String(error)), { operation: 'RestoreJob.run' });
    process.exitCode = 1;
  } finally {
    // 실패 경로에서도 반드시 닫는다 — 열린 DB/MinIO 연결이 event loop를 붙잡아
    // cron으로 뜬 컨테이너가 종료되지 않고 쌓이는 것을 막는다.
    await app?.close();
  }
}

bootstrap();
