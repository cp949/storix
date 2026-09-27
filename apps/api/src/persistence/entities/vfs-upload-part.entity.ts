import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsUploadPartState = 'RESERVED' | 'STORED' | 'CLEANUP' | 'DELETED';

@Entity('vfs_upload_part')
export class VfsUploadPartEntity {
  @PrimaryColumn({ name: 'session_id', type: 'uuid' }) sessionId: string;
  @PrimaryColumn({ name: 'part_index', type: 'integer' }) partIndex: number;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes: string;
  @Column({ name: 'staging_key', type: 'varchar', length: 512 }) stagingKey: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) digest: string | null;
  @Column({ name: 'encryption_iv', type: 'varchar', length: 32, nullable: true }) encryptionIv: string | null;
  @Column({ type: 'varchar', length: 16 }) state: VfsUploadPartState;
  @Column({ name: 'object_deleted_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  objectDeletedAt: Date | null;
  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE }) createdAt: Date;
  @Column({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE }) updatedAt: Date;
}
