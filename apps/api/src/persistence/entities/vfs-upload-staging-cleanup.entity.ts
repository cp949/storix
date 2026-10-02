import { Column, Entity, PrimaryColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

// A reclaimed reservation can still have a PUT in flight. Its key and charge
// remain durable after the part index becomes available for another attempt.
@Entity('vfs_upload_staging_cleanup')
export class VfsUploadStagingCleanupEntity {
  @PrimaryColumn({ name: 'staging_key', type: 'varchar', length: 512 }) stagingKey: string;
  @Column({ name: 'session_id', type: 'uuid' }) sessionId: string;
  @Column({ name: 'part_index', type: 'integer' }) partIndex: number;
  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH }) namespaceId: string;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes: string;
  @Column({ name: 'deleted_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true }) deletedAt: Date | null;
  @Column({ name: 'put_settled_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true }) putSettledAt: Date | null;
  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE }) createdAt: Date;
}
