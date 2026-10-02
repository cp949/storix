import { NAMESPACE_ID_COLUMN_LENGTH } from './dialect-column-types.js';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('vfs_upload_usage')
export class VfsUploadUsageEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 }) id: string;
  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH, nullable: true })
  namespaceId: string | null;
  @Column({ name: 'active_sessions', type: 'bigint' }) activeSessions: string;
  @Column({ name: 'staged_bytes', type: 'bigint' }) stagedBytes: string;
}
