import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureBodyParsers } from './common/body-parser.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import type { ErrorReporter } from './observability/error-reporter.js';
import { ERROR_REPORTER } from './observability/observability.constants.js';

async function bootstrap() {
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
