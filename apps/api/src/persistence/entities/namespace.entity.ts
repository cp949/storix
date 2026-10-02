import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type NamespaceStatus = 'ACTIVE' | 'DELETING' | 'DELETED';
export type EncryptionPolicy = 'NONE' | 'ENCRYPTED';
export type AccessPolicy = 'PRIVATE' | 'PUBLIC';

@Entity('namespace')
export class NamespaceEntity {
  @PrimaryColumn({ type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  id: string = randomUUID();

  @Column({ type: 'varchar', length: 128, nullable: true })
  name: string | null;

  @Column({
    name: 'encryption_policy',
    type: 'varchar',
    length: 16,
    default: 'NONE',
  })
  encryptionPolicy: EncryptionPolicy;

  // 생성 시점에 결정되고 이후 변경하지 않는다. NamespaceController에 수정
  // 엔드포인트가 없어 정책 변경 경로 자체가 존재하지 않는다.
  @Column({
    name: 'access_policy',
    type: 'varchar',
    length: 16,
    default: 'PRIVATE',
  })
  accessPolicy: AccessPolicy;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: NamespaceStatus;

  @Column({ name: 'trash_enabled', type: 'boolean', default: false })
  trashEnabled: boolean;

  @Column({ name: 'max_file_size_bytes', type: 'bigint', nullable: true })
  maxFileSizeBytes: string | null;

  @Column({ name: 'max_sync_delete_nodes', type: 'integer', nullable: true })
  maxSyncDeleteNodes: number | null;

  @Column({ name: 'max_sync_copy_nodes', type: 'integer', nullable: true })
  maxSyncCopyNodes: number | null;

  @Column({ name: 'max_sync_snapshot_nodes', type: 'integer', nullable: true })
  maxSyncSnapshotNodes: number | null;

  @Column({ name: 'max_snapshot_bytes', type: 'bigint', nullable: true })
  maxSnapshotBytes: string | null;

  @Column({ name: 'max_retained_snapshot_nodes', type: 'integer', nullable: true })
  maxRetainedSnapshotNodes: number | null;

  @Column({ name: 'max_retained_snapshot_bytes', type: 'bigint', nullable: true })
  maxRetainedSnapshotBytes: string | null;

  @Column({ name: 'retained_snapshot_node_count', type: 'integer', default: 0 })
  retainedSnapshotNodeCount: number;

  @Column({ name: 'retained_snapshot_byte_count', type: 'bigint', default: 0 })
  retainedSnapshotByteCount: string;

  @Column({ name: 'retained_trash_node_count', type: 'bigint', default: 0 })
  retainedTrashNodeCount: string;

  @Column({ name: 'retained_trash_byte_count', type: 'bigint', default: 0 })
  retainedTrashByteCount: string;

  @Column({ name: 'max_total_logical_bytes', type: 'bigint', nullable: true })
  maxTotalLogicalBytes: string | null;

  @Column({ name: 'live_file_byte_count', type: 'bigint', default: 0 })
  liveFileByteCount: string;

  @Column({ name: 'max_files_per_folder', type: 'bigint', nullable: true })
  maxFilesPerFolder: string | null;

  @Column({ name: 'live_node_count', type: 'bigint', default: 0 })
  liveNodeCount: string;

  @Column({ name: 'max_live_nodes', type: 'bigint', nullable: true })
  maxLiveNodes: string | null;

  @Column({ name: 'exclude_trash_from_quota', type: 'boolean', default: false })
  excludeTrashFromQuota: boolean;

  @Column({ name: 'exclude_snapshots_from_quota', type: 'boolean', default: false })
  excludeSnapshotsFromQuota: boolean;

  @Column({ name: 'max_retained_trash_bytes', type: 'bigint', nullable: true })
  maxRetainedTrashBytes: string | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE })
  updatedAt: Date;
}
