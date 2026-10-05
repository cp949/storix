import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureHttpPipeline } from './common/http-pipeline.js';
import { DEMO_WAS_CONFIG, DemoWasConfig } from './config/demo-was-config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureHttpPipeline(app);
  const config = app.get<DemoWasConfig>(DEMO_WAS_CONFIG);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(
    '애플리케이션 부팅 실패',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
