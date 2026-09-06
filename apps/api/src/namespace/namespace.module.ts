import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from '../common/request-context.middleware.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NamespaceController } from './namespace.controller.js';
import { NamespaceService } from './namespace.service.js';

@Module({
  imports: [PersistenceModule],
  controllers: [NamespaceController],
  providers: [NamespaceService],
})
export class NamespaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes(NamespaceController);
  }
}
