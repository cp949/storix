import { AuditLogEntity } from './audit-log.entity.js';
import { BlobEntity } from './blob.entity.js';
import { IdempotencyKeyEntity } from './idempotency-key.entity.js';
import { NamespaceDeletionEntity } from './namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from './namespace-deletion-receipt.entity.js';
import { NamespaceEntity } from './namespace.entity.js';
import { VfsChangeEventEntity } from './vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from './vfs-change-feed-state.entity.js';
import { VfsMutationReceiptEntity } from './vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from './vfs-node.entity.js';
import { VfsSnapshotEntity } from './vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from './vfs-snapshot-entry.entity.js';
import { VfsTrashEntity } from './vfs-trash.entity.js';
import { VfsTrashEntryEntity } from './vfs-trash-entry.entity.js';
import { VfsUploadPartEntity } from './vfs-upload-part.entity.js';
import { VfsUploadSessionEntity } from './vfs-upload-session.entity.js';
import { VfsUploadStagingCleanupEntity } from './vfs-upload-staging-cleanup.entity.js';
import { VfsUploadUsageEntity } from './vfs-upload-usage.entity.js';

/**
 * 앱 런타임(`persistence.module.ts`)과 typeorm CLI(`data-source.ts`)가 함께 쓰는 entity 목록이다.
 * 새 entity는 여기에만 추가한다. 목록이 두 곳이던 때 CLI 쪽에서 change feed entity가 빠진 적이 있다.
 */
export const ALL_ENTITIES = [
  NamespaceEntity,
  NamespaceDeletionEntity,
  NamespaceDeletionReceiptEntity,
  VfsNodeEntity,
  BlobEntity,
  IdempotencyKeyEntity,
  AuditLogEntity,
  VfsMutationReceiptEntity,
  VfsSnapshotEntity,
  VfsSnapshotEntryEntity,
  VfsTrashEntity,
  VfsTrashEntryEntity,
  VfsUploadSessionEntity,
  VfsUploadPartEntity,
  VfsUploadStagingCleanupEntity,
  VfsUploadUsageEntity,
  VfsChangeFeedStateEntity,
  VfsChangeEventEntity,
];
