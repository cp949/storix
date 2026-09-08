import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type NamespaceStatus = 'ACTIVE' | 'DELETING' | 'DELETED';
export type EncryptionPolicy = 'NONE' | 'ENCRYPTED';

@Entity('namespace')
export class NamespaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({
    name: 'encryption_policy',
    type: 'varchar',
    length: 16,
    default: 'NONE',
  })
  encryptionPolicy: EncryptionPolicy;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: NamespaceStatus;

  @Column({ name: 'max_file_size_bytes', type: 'bigint', nullable: true })
  maxFileSizeBytes: string | null;

  @Column({ name: 'max_sync_delete_nodes', type: 'integer', nullable: true })
  maxSyncDeleteNodes: number | null;

  @Column({ name: 'max_sync_copy_nodes', type: 'integer', nullable: true })
  maxSyncCopyNodes: number | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE })
  updatedAt: Date;
}
