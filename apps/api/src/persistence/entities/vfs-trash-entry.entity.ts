import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type VfsTrashEntryType = 'FILE' | 'DIRECTORY';

@Entity('vfs_trash_entry')
export class VfsTrashEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;

  @Column({ name: 'trash_id', type: 'uuid' })
  trashId: string;

  @Column({ name: 'relative_path', type: 'text' })
  relativePath: string;

  @Column({ name: 'path_key', type: 'text' })
  pathKey: string;

  @Column({ type: 'varchar', length: 16 })
  type: VfsTrashEntryType;

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

  /** 삭제 직전 node의 생성 시각. 이 컬럼 도입 전에 삭제된 항목은 null이고 복구 시각을 쓴다. */
  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  createdAt: Date | null;
}
