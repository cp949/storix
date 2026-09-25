import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type VfsSnapshotEntryType = 'FILE' | 'DIRECTORY';

@Entity('vfs_snapshot_entry')
export class VfsSnapshotEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'uuid' })
  namespaceId: string;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshotId: string;

  @Column({ name: 'relative_path', type: 'text' })
  relativePath: string;

  @Column({ name: 'path_key', type: 'text' })
  pathKey: string;

  @Column({ type: 'varchar', length: 16 })
  type: VfsSnapshotEntryType;

  @Column({ name: 'source_node_id', type: 'uuid' })
  sourceNodeId: string;

  @Column({ name: 'source_revision', type: 'varchar', length: 64 })
  sourceRevision: string;

  @Column({ name: 'blob_id', type: 'uuid', nullable: true })
  blobId: string | null;

  @Column({ type: 'bigint', nullable: true })
  size: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType: string | null;
}
