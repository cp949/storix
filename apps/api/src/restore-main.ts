import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { bootstrapWithEnv } from './common/bootstrap-with-env.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';

// RestoreAppModule/RestoreJob은 정적 import하면 안 된다 — PersistenceModule을 거쳐
// entities를 끌어오고, entities의 드라이버 중립 컬럼 타입 상수(dialect-column-types.ts)는
// 모듈 로드 시점에 process.env.STORIX_DB_DRIVER를 읽어 얼어붙는다(main.ts와 동일한
// 이유). bootstrapWithEnv()로 .env 로드 이후에만 평가되도록 강제한다.
async function bootstrap(): Promise<void> {
  const logger = new Logger('RestoreMain');
  let app: INestApplicationContext | undefined;
  try {
    const { RestoreAppModule, RestoreJob } = await bootstrapWithEnv(() => import('./restore-app.module.js'));
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
