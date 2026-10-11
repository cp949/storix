import { UploadStagingCleanup } from './upload-staging-cleanup.js';
import { VfsSnapshotService } from './vfs-snapshot.service.js';
import { VfsSnapshotController } from './vfs-snapshot.controller.js';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from '../common/request-context.middleware.js';
import { CAPABILITY_CONFIG, CapabilityModule } from '../capability/capability.module.js';
import type { CapabilityConfig } from '../capability/capability-config.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OnlineStorageModule } from '../storage/online-storage.module.js';
import { ContentService } from './content.service.js';
import { FsController } from './fs.controller.js';
import { PathResolver } from './path-resolver.js';
import { PublicFsController } from './public-fs.controller.js';
import { VfsService } from './vfs.service.js';
import { MutationService } from './mutation.service.js';
import { ConditionalContentService } from './conditional-content.service.js';
import { UploadSessionController } from './upload-session.controller.js';
import { UploadSessionService } from './upload-session.service.js';
import { UploadSessionPartService } from './upload-session-part.service.js';
import { UploadSessionFinalizeService } from './upload-session-finalize.service.js';
import { ChangeFeedController } from './change-feed.controller.js';
import { ChangeFeedService } from './change-feed.service.js';
import { VfsTrashController } from './vfs-trash.controller.js';
import { VfsTrashService } from './vfs-trash.service.js';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { ContentIngressService } from './content-ingress.service.js';
import { ARCHIVE_CONFIG, createArchiveConfig } from './archive-config.js';
import { ArchiveService } from './archive.service.js';
import { ArchiveGate } from './archive-gate.js';

@Module({
  imports: [PersistenceModule, OnlineStorageModule, EncryptionModule, CapabilityModule],
  controllers: [
    FsController,
    PublicFsController,
    VfsSnapshotController,
    UploadSessionController,
    ChangeFeedController,
    VfsTrashController,
  ],
  providers: [
    UploadStagingCleanup,
    VfsSnapshotService,
    VfsService,
    ContentService,
    PathResolver,
    MutationService,
    ConditionalContentService,
    UploadSessionService,
    UploadSessionPartService,
    UploadSessionFinalizeService,
    ChangeFeedService,
    VfsTrashService,
    ContentIngressService,
    AdminApiKeyGuard,
    ArchiveService,
    {
      provide: ArchiveGate,
      useFactory: (config: ReturnType<typeof createArchiveConfig>) => new ArchiveGate(config.maxConcurrency),
      inject: [ARCHIVE_CONFIG],
    },
    {
      provide: ARCHIVE_CONFIG,
      // archive를 전역 허용하지 않은 배포는 grace 불변식 위반을 경고로만 남긴다(archive-config.ts 참고).
      useFactory: (capabilities: CapabilityConfig) =>
        createArchiveConfig(undefined, undefined, {
          archiveGloballyAllowed: capabilities.globalAllowedCapabilities.includes('archive'),
        }),
      inject: [CAPABILITY_CONFIG],
    },
  ],
})
export class VfsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes(
        FsController,
        PublicFsController,
        VfsSnapshotController,
        UploadSessionController,
        ChangeFeedController,
        VfsTrashController,
      );
  }
}
