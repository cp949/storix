import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureBodyParsers } from './common/body-parser.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';

// AppModule은 정적 import하면 안 된다 — 엔티티의 드라이버 중립 컬럼 타입
// 상수(dialect-column-types.ts)가 모듈 로드 시점에 process.env.STORIX_DB_DRIVER를
// 읽어 얼어붙는데, 정적 import는 아래 loadEnvFile()보다 먼저(엔진이 이
// 파일의 최상위 코드를 실행하기도 전에) 평가된다. STORIX_DB_DRIVER를 쉘
// export 없이 .env 파일에만 두면 그 상수가 .env 반영 전 기본값(postgres)으로
// 고정돼 SQLite 드라이버와 붙을 때 DataTypeNotSupportedError로 부팅이
// 깨진다. loadEnvFile() 다음에 동적 import해 .env가 반영된 뒤에야 엔티티가
// 평가되도록 순서를 강제한다.
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function bootstrap() {
  loadEnvFile();
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.useGlobalFilters(new DomainErrorFilter(app.get<ErrorReporter>(ERROR_REPORTER)));
  configureBodyParsers(app);
  await app.listen(process.env.STORIX_PORT ?? 3000);
}

// catch()가 없으면 부팅 실패(EncryptionBootGuard의 fail-closed 포함)가 미처리
// 프로미스 거부 덤프로만 남아 원인 메시지가 묻힌다.
bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error('애플리케이션 부팅 실패', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
