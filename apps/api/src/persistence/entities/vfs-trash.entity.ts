import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsTrashRootType = 'FILE' | 'DIRECTORY';

@Entity('vfs_trash')
export class VfsTrashEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;

  @Column({ name: 'root_type', type: 'varchar', length: 16 })
  rootType: VfsTrashRootType;

  @Column({ name: 'original_path', type: 'text' })
  originalPath: string;

  @Column({ name: 'root_node_id', type: 'uuid' })
  rootNodeId: string;

  @Column({ name: 'root_revision', type: 'varchar', length: 64 })
  rootRevision: string;

  @Column({ name: 'node_count', type: 'bigint' })
  nodeCount: string;

  @Column({ name: 'logical_bytes', type: 'bigint' })
  logicalBytes: string;

  @Column({ name: 'deleted_at', type: TIMESTAMP_COLUMN_TYPE })
  deletedAt: Date;

  @Column({ name: 'expires_at', type: TIMESTAMP_COLUMN_TYPE })
  expiresAt: Date;
}
