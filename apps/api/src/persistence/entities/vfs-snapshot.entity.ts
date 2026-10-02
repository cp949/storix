import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsSnapshotKind = 'FILE' | 'TREE';
export type VfsSnapshotRootType = 'FILE' | 'DIRECTORY';

@Entity('vfs_snapshot')
export class VfsSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;

  @Column({ type: 'varchar', length: 16 })
  kind: VfsSnapshotKind;

  @Column({ name: 'source_path', type: 'text' })
  sourcePath: string;

  @Column({ name: 'root_node_id', type: 'uuid' })
  rootNodeId: string;

  @Column({ name: 'source_revision', type: 'varchar', length: 64 })
  sourceRevision: string;

  @Column({ name: 'root_type', type: 'varchar', length: 16 })
  rootType: VfsSnapshotRootType;

  @Column({ name: 'node_count', type: 'integer' })
  nodeCount: number;

  @Column({ name: 'logical_bytes', type: 'bigint' })
  logicalBytes: string;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;
}
