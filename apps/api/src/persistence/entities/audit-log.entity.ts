import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

@Entity('audit_log')
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'request_id', type: 'varchar', length: 200 })
  requestId: string;

  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH, nullable: true })
  namespaceId: string | null;

  @Column({ name: 'snapshot_id', type: 'uuid', nullable: true })
  snapshotId: string | null;

  @Column({ name: 'trash_id', type: 'uuid', nullable: true })
  trashId: string | null;

  @Column({ type: 'varchar', length: 128 })
  operation: string;

  @Column({ type: 'text', nullable: true })
  path: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  caller: string | null;

  @Column({ type: 'smallint' })
  status: number;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;
}
