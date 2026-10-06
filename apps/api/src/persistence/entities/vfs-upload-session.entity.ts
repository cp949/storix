import { Column, Entity, PrimaryColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsUploadSessionState = 'OPEN' | 'FINALIZING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

@Entity('vfs_upload_session')
export class VfsUploadSessionEntity {
  @PrimaryColumn({ type: 'uuid' }) id: string;
  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH }) namespaceId: string;
  @Column({ type: 'varchar', length: 128 }) scope: string;
  @Column({ name: 'creation_key', type: 'uuid' }) creationKey: string;
  @Column({ type: 'varchar', length: 64 }) fingerprint: string;
  @Column({ name: 'target_path', type: 'text' }) targetPath: string;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) sha256: string | null;
  @Column({ name: 'mime_type', type: 'varchar', length: 255 }) mimeType: string;
  // 완료로 만들 파일의 만료 초. 완료 트랜잭션 시각을 기준으로 계산한다.
  @Column({ name: 'file_expires_in_seconds', type: 'integer', nullable: true })
  fileExpiresInSeconds: number | null;
  @Column({ name: 'condition_type', type: 'varchar', length: 16 }) conditionType: 'ABSENT' | 'REVISION';
  @Column({ name: 'condition_revision', type: 'varchar', length: 128, nullable: true }) conditionRevision:
    string | null;
  @Column({ name: 'part_size_bytes', type: 'integer' }) partSizeBytes: number;
  @Column({ name: 'part_count', type: 'integer' }) partCount: number;
  @Column({ type: 'varchar', length: 16 }) state: VfsUploadSessionState;
  @Column({ name: 'lease_expires_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  leaseExpiresAt: Date | null;
  @Column({ name: 'lease_token', type: 'uuid', nullable: true }) leaseToken: string | null;
  @Column({ name: 'expires_at', type: TIMESTAMP_COLUMN_TYPE }) expiresAt: Date;
  @Column({ name: 'creation_expires_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  creationExpiresAt: Date | null;
  @Column({ name: 'max_expires_at', type: TIMESTAMP_COLUMN_TYPE }) maxExpiresAt: Date;
  @Column({ name: 'terminal_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true }) terminalAt: Date | null;
  @Column({ name: 'response_status', type: 'integer', nullable: true }) responseStatus: number | null;
  @Column({ name: 'response_body', type: 'text', nullable: true }) responseBody: string | null;
  @Column({ name: 'request_id', type: 'varchar', length: 200, nullable: true }) requestId: string | null;
  // 완료가 실패해 OPEN으로 돌아온 마지막 시도의 진단. 다음 claim과 모든 종결 전이에서 지운다.
  @Column({ name: 'last_complete_failure_code', type: 'text', nullable: true })
  lastCompleteFailureCode: string | null;
  @Column({ name: 'last_complete_failure_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  lastCompleteFailureAt: Date | null;
  @Column({ name: 'creation_request_id', type: 'varchar', length: 200, nullable: true })
  creationRequestId: string | null;
  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE }) createdAt: Date;
  @Column({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE }) updatedAt: Date;
}
