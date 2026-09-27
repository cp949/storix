import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('vfs_upload_usage')
export class VfsUploadUsageEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ name: 'namespace_id', type: 'uuid', nullable: true }) namespaceId: string | null;
  @Column({ name: 'active_sessions', type: 'bigint' }) activeSessions: string;
  @Column({ name: 'staged_bytes', type: 'bigint' }) stagedBytes: string;
}
