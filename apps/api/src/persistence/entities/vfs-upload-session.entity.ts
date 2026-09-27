import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsUploadSessionState = 'OPEN' | 'FINALIZING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

@Entity('vfs_upload_session')
export class VfsUploadSessionEntity {
  @PrimaryColumn({ type: 'uuid' }) id: string;
  @Column({ name: 'namespace_id', type: 'uuid' }) namespaceId: string;
  @Column({ type: 'varchar', length: 128 }) scope: string;
  @Column({ name: 'creation_key', type: 'uuid' }) creationKey: string;
  @Column({ type: 'varchar', length: 64 }) fingerprint: string;
  @Column({ name: 'target_path', type: 'text' }) targetPath: string;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes: string;
  @Column({ name: 'mime_type', type: 'varchar', length: 255 }) mimeType: string;
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
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true }) requestId: string | null;
  @Column({ name: 'creation_request_id', type: 'varchar', length: 128, nullable: true })
  creationRequestId: string | null;
  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE }) createdAt: Date;
  @Column({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE }) updatedAt: Date;
}
