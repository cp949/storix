import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';
import type { VfsNodeType } from './vfs-node.entity.js';

export type VfsChangeKind = 'created' | 'updated' | 'moved' | 'deleted';

@Entity('vfs_change_event')
export class VfsChangeEventEntity {
  @PrimaryColumn({ name: 'namespace_id', type: 'uuid' })
  namespaceId: string;

  @PrimaryColumn({ type: 'bigint' })
  sequence: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId: string;

  @Column({ name: 'operation_index', type: 'integer' })
  operationIndex: number;

  @Column({ name: 'operation_count', type: 'integer' })
  operationCount: number;

  @Column({ type: 'varchar', length: 16 })
  kind: VfsChangeKind;

  @Column({ name: 'node_id', type: 'uuid' })
  nodeId: string;

  @Column({ name: 'node_type', type: 'varchar', length: 16 })
  nodeType: VfsNodeType;

  @Column({ type: 'text' })
  path: string;

  @Column({ name: 'previous_path', type: 'text', nullable: true })
  previousPath: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  revision: string | null;

  @CreateDateColumn({ name: 'occurred_at', type: TIMESTAMP_COLUMN_TYPE })
  occurredAt: Date;
}
