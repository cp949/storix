import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_log')
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'request_id', type: 'varchar', length: 200 })
  requestId: string;

  @Column({ name: 'namespace_id', type: 'uuid', nullable: true })
  namespaceId: string | null;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
