import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import { requestContextMiddleware } from './common/request-context.middleware.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(requestContextMiddleware);
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(process.env.DEMO_WAS_PORT ?? 4000);
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error('애플리케이션 부팅 실패', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
