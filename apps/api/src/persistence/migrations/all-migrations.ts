import { AddNamespaceDeletion1791700000011 } from './1791700000011-AddNamespaceDeletion.js';
import { AddGcCursor1791700000012 } from './1791700000012-AddGcCursor.js';
import { AddNamespaceEncryptedIndex1791700000013 } from './1791700000013-AddNamespaceEncryptedIndex.js';
import { AddIdempotencyKeyCreatedAtIndex1791700000014 } from './1791700000014-AddIdempotencyKeyCreatedAtIndex.js';
import { AddNamespaceDeletionCompletedIndex1791700000015 } from './1791700000015-AddNamespaceDeletionCompletedIndex.js';
import { MigrationInterface } from 'typeorm';
import { AddAuditLog1789200000000 } from './1789200000000-AddAuditLog.js';
import { AddBlobZeroSince1788800000000 } from './1788800000000-AddBlobZeroSince.js';
import { AddGcState1789300000000 } from './1789300000000-AddGcState.js';
import { AddVfsMutationReceipt1789400000000 } from './1789400000000-AddVfsMutationReceipt.js';
import { AddVfsSnapshots1790400000000 } from './1790400000000-AddVfsSnapshots.js';
import { AddNamespaceLogicalQuota1791400000000 } from './1791400000000-AddNamespaceLogicalQuota.js';
import { AddVfsSnapshotListIndex1791500000000 } from './1791500000000-AddVfsSnapshotListIndex.js';
import { AddAuditLogSnapshotId1791600000000 } from './1791600000000-AddAuditLogSnapshotId.js';
import { AddIdempotencyKey1788700000000 } from './1788700000000-AddIdempotencyKey.js';
import { InitSchema1788637362016 } from './1788637362016-InitSchema.js';
import { AddVfsUploadSessions1791700000000 } from './1791700000000-AddVfsUploadSessions.js';
import { AddUploadCreationExpiry1791700000001 } from './1791700000001-AddUploadCreationExpiry.js';
import { AddUploadFinalizeLeaseToken1791700000002 } from './1791700000002-AddUploadFinalizeLeaseToken.js';
import { AddUploadCreationRequestId1791700000003 } from './1791700000003-AddUploadCreationRequestId.js';
import { AddUploadPartLease1791700000004 } from './1791700000004-AddUploadPartLease.js';
import { AddUploadChecksumFailure1791700000005 } from './1791700000005-AddUploadChecksumFailure.js';
import { AddVfsChangeFeed1791700000006 } from './1791700000006-AddVfsChangeFeed.js';
import { AddVfsTrash1791700000007 } from './1791700000007-AddVfsTrash.js';
import { AddAuditLogTrashId1791700000008 } from './1791700000008-AddAuditLogTrashId.js';
import { AddNamespaceTrashEnabled1791700000009 } from './1791700000009-AddNamespaceTrashEnabled.js';
import { AddFileExpiry1791700000010 } from './1791700000010-AddFileExpiry.js';

type MigrationClass = new () => MigrationInterface;

// 타임스탬프 오름차순(= 실행 순서) 정본 목록. 통합 스펙마다 이 목록을 손으로
// 나열하는 대신 여기서 가져와 ALL_MIGRATIONS 또는 ALL_MIGRATIONS.slice(0, n)로
// 쓴다(n번째까지만 필요한 백필 전 스펙 등). namespace 리소스 상한·암호화
// 지원 컬럼은 실배포 이력이 없어 별도 마이그레이션 대신 InitSchema에
// 흡수했다(재구성 전용이던 AddNamespaceResourceLimits/AddEncryptionSupport는
// 삭제).
export const ALL_MIGRATIONS: MigrationClass[] = [
  InitSchema1788637362016,
  AddIdempotencyKey1788700000000,
  AddBlobZeroSince1788800000000,
  AddAuditLog1789200000000,
  AddGcState1789300000000,
  AddVfsMutationReceipt1789400000000,
  AddVfsSnapshots1790400000000,
  AddNamespaceLogicalQuota1791400000000,
  AddVfsSnapshotListIndex1791500000000,
  AddAuditLogSnapshotId1791600000000,
  AddVfsUploadSessions1791700000000,
  AddUploadCreationExpiry1791700000001,
  AddUploadFinalizeLeaseToken1791700000002,
  AddUploadCreationRequestId1791700000003,
  AddUploadPartLease1791700000004,
  AddUploadChecksumFailure1791700000005,
  AddVfsChangeFeed1791700000006,
  AddVfsTrash1791700000007,
  AddAuditLogTrashId1791700000008,
  AddNamespaceTrashEnabled1791700000009,
  AddFileExpiry1791700000010,
  AddNamespaceDeletion1791700000011,
  AddGcCursor1791700000012,
  AddNamespaceEncryptedIndex1791700000013,
  AddIdempotencyKeyCreatedAtIndex1791700000014,
  AddNamespaceDeletionCompletedIndex1791700000015,
];
