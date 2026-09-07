import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { GcJobModule } from './jobs/gc-job.module.js';
import { GcJob } from './jobs/gc.job.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';
import { ObservabilityModule } from './observability/observability.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, GcJobModule],
})
class GcAppModule {}

async function bootstrap(): Promise<void> {
  const logger = new Logger('GcMain');
  let app: INestApplicationContext | undefined;
  try {
    // abortOnError 기본값(true)이면 DI 초기화 실패 시 Nest가 내부적으로
    // process.exit(1)을 직접 호출해 이 catch 블록과 아래 logger.error를
    // 건너뛴다. false로 지정해 초기화 실패도 이 함수의 에러 로그를 거치게 한다.
    app = await NestFactory.createApplicationContext(GcAppModule, { abortOnError: false });
    const result = await app.get(GcJob).run();
    logger.log(`GC job 종료: ${JSON.stringify(result)}`);
    process.exitCode = 0;
  } catch (error) {
    logger.error('GC job 실패', error instanceof Error ? error.stack : String(error));
    // app 생성 자체가 실패하면 DI로 ErrorReporter를 얻을 수 없어 리포팅을 건너뛴다.
    const errorReporter = app?.get<ErrorReporter>(ERROR_REPORTER, { strict: false });
    errorReporter?.report(error instanceof Error ? error : new Error(String(error)), { operation: 'GcJob.run' });
    process.exitCode = 1;
  } finally {
    // 실패 경로에서도 반드시 닫는다 — 열린 DB/MinIO 연결이 event loop를 붙잡아
    // cron으로 뜬 컨테이너가 종료되지 않고 쌓이는 것을 막는다.
    await app?.close();
  }
}

bootstrap();
