import { MigrationInterface } from 'typeorm';
import { AddAuditLog1789200000000 } from './1789200000000-AddAuditLog.js';
import { AddBlobZeroSince1788800000000 } from './1788800000000-AddBlobZeroSince.js';
import { AddGcState1789300000000 } from './1789300000000-AddGcState.js';
import { AddIdempotencyKey1788700000000 } from './1788700000000-AddIdempotencyKey.js';
import { InitSchema1788637362016 } from './1788637362016-InitSchema.js';

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
];
