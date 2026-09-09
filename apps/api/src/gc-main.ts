import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { bootstrapWithEnv } from './common/bootstrap-with-env.js';
import { parsePositiveInt } from './common/env-parsing.js';
import type { GcLock } from './jobs/gc-lock.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';

// GcAppModule/GcJob/GcLock은 정적 import하면 안 된다 — PersistenceModule을 거쳐
// entities를 끌어오고, entities의 드라이버 중립 컬럼 타입 상수(dialect-column-types.ts)는
// 모듈 로드 시점에 process.env.STORIX_DB_DRIVER를 읽어 얼어붙는다(main.ts와 동일한
// 이유). bootstrapWithEnv()로 .env 로드 이후에만 평가되도록 강제한다.
async function bootstrap(): Promise<void> {
  const logger = new Logger('GcMain');
  let app: INestApplicationContext | undefined;
  let gcLock: GcLock | undefined;
  try {
    const { GcAppModule, GcJob, GcLock: GcLockClass } = await bootstrapWithEnv(() => import('./gc-app.module.js'));

    // abortOnError 기본값(true)이면 DI 초기화 실패 시 Nest가 내부적으로
    // process.exit(1)을 직접 호출해 이 catch 블록과 아래 logger.error를
    // 건너뛴다. false로 지정해 초기화 실패도 이 함수의 에러 로그를 거치게 한다.
    app = await NestFactory.createApplicationContext(GcAppModule, { abortOnError: false });

    // 멀티 인스턴스(1:1 VersityGW + 공유 DB) 배치에서 여러 WAS 호스트가 이
    // 컨테이너를 동시에/독립적으로 띄워도 실제로 스캔·삭제를 수행하는 건 한
    // 인스턴스뿐이도록 advisory lock + 쿨다운으로 막는다(README.versitygw.md
    // "운영 잡" 참고).
    const lock = app.get(GcLockClass);
    gcLock = lock;
    const minIntervalSeconds = parsePositiveInt(process.env.STORIX_GC_MIN_INTERVAL, 3600);
    if (!(await lock.tryAcquire(minIntervalSeconds))) {
      logger.log('다른 인스턴스가 실행 중이거나 최근에 완료됨 — 건너뜀');
      process.exitCode = 0;
      return;
    }

    const result = await app.get(GcJob).run();
    logger.log(`GC job 종료: ${JSON.stringify(result)}`);
    await lock.markCompleted();
    process.exitCode = 0;
  } catch (error) {
    logger.error('GC job 실패', error instanceof Error ? error.stack : String(error));
    // app 생성 자체가 실패하면 DI로 ErrorReporter를 얻을 수 없어 리포팅을 건너뛴다.
    const errorReporter = app?.get<ErrorReporter>(ERROR_REPORTER, { strict: false });
    errorReporter?.report(error instanceof Error ? error : new Error(String(error)), { operation: 'GcJob.run' });
    process.exitCode = 1;
  } finally {
    // 락을 못 얻었거나 이미 반납한 상태에서도 안전한 no-op이다(GcLock.release 참고).
    await gcLock?.release();
    // 실패 경로에서도 반드시 닫는다 — 열린 DB/MinIO 연결이 event loop를 붙잡아
    // cron으로 뜬 컨테이너가 종료되지 않고 쌓이는 것을 막는다.
    await app?.close();
  }
}

bootstrap();
