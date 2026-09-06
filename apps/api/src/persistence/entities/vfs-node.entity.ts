import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export type VfsNodeType = 'FILE' | 'DIRECTORY';

@Entity('vfs_node')
export class VfsNodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'uuid' })
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @VersionColumn()
  version: number;
}
