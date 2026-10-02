import { NamespaceDeletionController } from './namespace-deletion.controller.js';
import { NamespaceDeletionService } from './namespace-deletion.service.js';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { RequestContextMiddleware } from '../common/request-context.middleware.js';
import { CapabilityModule } from '../capability/capability.module.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { NamespaceController } from './namespace.controller.js';
import { NamespaceQuotaController } from './namespace-quota.controller.js';
import { NamespaceQuotaService } from './namespace-quota.service.js';
import { NamespaceTrashPolicyController } from './namespace-trash-policy.controller.js';
import { NamespaceTrashPolicyService } from './namespace-trash-policy.service.js';
import { NamespaceSettingsController } from './namespace-settings.controller.js';
import { NamespaceSettingsService } from './namespace-settings.service.js';
import { NamespaceService } from './namespace.service.js';

@Module({
  imports: [PersistenceModule, EncryptionModule, CapabilityModule],
  controllers: [
    NamespaceDeletionController,
    NamespaceController,
    NamespaceQuotaController,
    NamespaceTrashPolicyController,
    NamespaceSettingsController,
  ],
  providers: [
    NamespaceDeletionService,
    NamespaceService,
    NamespaceQuotaService,
    NamespaceTrashPolicyService,
    NamespaceSettingsService,
    AdminApiKeyGuard,
  ],
})
export class NamespaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes(
        NamespaceDeletionController,
        NamespaceController,
        NamespaceQuotaController,
        NamespaceTrashPolicyController,
        NamespaceSettingsController,
      );
  }
}
