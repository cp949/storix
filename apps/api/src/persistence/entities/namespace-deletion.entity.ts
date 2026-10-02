/**
 * namespace UUID별 삭제 operation과 재시작 위치를 보존한다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

/** 삭제 정리의 현재 단계다. */
export type NamespaceDeletionPhase = 'UPLOADS' | 'METADATA' | 'OBJECTS' | 'COMPLETED';

/** 자동 정리가 진행하지 못한 원인이다. */
export type NamespaceDeletionBlockedReason =
  'UPLOAD_SETTLEMENT_UNKNOWN' | 'STORAGE_DELETE_FAILED' | 'DATA_INCONSISTENT';

@Entity('namespace_deletion')
export class NamespaceDeletionEntity {
  @PrimaryColumn({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;
  @Column({ type: 'varchar', length: 16 }) phase: NamespaceDeletionPhase;
  @Column({ name: 'requested_at', type: TIMESTAMP_COLUMN_TYPE }) requestedAt: Date;
  @Column({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE }) updatedAt: Date;
  @Column({ name: 'completed_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true }) completedAt: Date | null;
  @Column({ name: 'blocked_reason', type: 'varchar', length: 32, nullable: true })
  blockedReason: NamespaceDeletionBlockedReason | null;
}
