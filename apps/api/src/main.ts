import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureBodyParsers } from './common/body-parser.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.useGlobalFilters(new DomainErrorFilter());
  configureBodyParsers(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
