import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { NAMESPACE_ID_COLUMN_LENGTH, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

export type VfsNodeType = 'FILE' | 'DIRECTORY';

@Entity('vfs_node')
export class VfsNodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 16 })
  type: VfsNodeType;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'blob_id', type: 'uuid', nullable: true })
  blobId: string | null;

  @Column({ type: 'bigint', nullable: true })
  size: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType: string | null;

  @Column({ name: 'child_file_count', type: 'bigint', default: 0 })
  childFileCount: string;

  // 생성 시 지정한 만료 시각. NULL이면 만료 없음. DIRECTORY는 항상 NULL이다.
  @Column({ name: 'expires_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE })
  updatedAt: Date;

  // PostgreSQL bigint는 pg 드라이버가 문자열로 돌려주므로 엔티티 경로에서는 number로 변환한다.
  // raw SQL 결과에는 적용되지 않는다(TRP-011). 상한은 MAX_VFS_VERSION이라 정밀도 손실이 없다.
  @VersionColumn({
    type: 'bigint',
    transformer: { to: (value: number) => value, from: (value: string | number) => Number(value) },
  })
  version: number;
}
