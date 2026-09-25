import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { RequestContextMiddleware } from '../common/request-context.middleware.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NamespaceController } from './namespace.controller.js';
import { NamespaceQuotaController } from './namespace-quota.controller.js';
import { NamespaceQuotaService } from './namespace-quota.service.js';
import { NamespaceService } from './namespace.service.js';

@Module({
  imports: [PersistenceModule, EncryptionModule],
  controllers: [NamespaceController, NamespaceQuotaController],
  providers: [NamespaceService, NamespaceQuotaService, AdminApiKeyGuard],
})
export class NamespaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes(NamespaceController, NamespaceQuotaController);
  }
}
