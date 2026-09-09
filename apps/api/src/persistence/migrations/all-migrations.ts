import { MigrationInterface } from 'typeorm';
import { AddAuditLog1789200000000 } from './1789200000000-AddAuditLog.js';
import { AddBlobZeroSince1788800000000 } from './1788800000000-AddBlobZeroSince.js';
import { AddEncryptionSupport1789100000000 } from './1789100000000-AddEncryptionSupport.js';
import { AddGcState1789300000000 } from './1789300000000-AddGcState.js';
import { AddIdempotencyKey1788700000000 } from './1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from './1789000000000-AddNamespaceResourceLimits.js';
import { InitSchema1788637362016 } from './1788637362016-InitSchema.js';

type MigrationClass = new () => MigrationInterface;

// 타임스탬프 오름차순(= 실행 순서) 정본 목록. 통합 스펙마다 이 목록을 손으로
// 나열하는 대신 여기서 가져와 ALL_MIGRATIONS 또는 ALL_MIGRATIONS.slice(0, n)로
// 쓴다(n번째까지만 필요한 재구성 전/후 스펙 등).
export const ALL_MIGRATIONS: MigrationClass[] = [
  InitSchema1788637362016,
  AddIdempotencyKey1788700000000,
  AddBlobZeroSince1788800000000,
  AddNamespaceResourceLimits1789000000000,
  AddEncryptionSupport1789100000000,
  AddAuditLog1789200000000,
  AddGcState1789300000000,
];
