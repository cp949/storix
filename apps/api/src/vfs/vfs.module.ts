import { VfsSnapshotService } from './vfs-snapshot.service.js';
import { VfsSnapshotController } from './vfs-snapshot.controller.js';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from '../common/request-context.middleware.js';
import { CapabilityModule } from '../capability/capability.module.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ContentService } from './content.service.js';
import { FsController } from './fs.controller.js';
import { PathResolver } from './path-resolver.js';
import { PublicFsController } from './public-fs.controller.js';
import { VfsService } from './vfs.service.js';
import { MutationService } from './mutation.service.js';
import { ConditionalContentService } from './conditional-content.service.js';

@Module({
  imports: [PersistenceModule, StorageModule, EncryptionModule, CapabilityModule],
  controllers: [FsController, PublicFsController, VfsSnapshotController],
  providers: [
    VfsSnapshotService,
    VfsService,
    ContentService,
    PathResolver,
    MutationService,
    ConditionalContentService,
  ],
})
export class VfsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes(FsController, PublicFsController, VfsSnapshotController);
  }
}
