import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('blob')
export class BlobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'namespace_id', type: 'uuid' })
  namespaceId: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey: string;

  @Column({ type: 'bigint' })
  size: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 255 })
  mimeType: string;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @Column({ name: 'reference_count', type: 'integer', default: 0 })
  referenceCount: number;

  @Column({ name: 'zero_since', type: 'timestamptz', nullable: true })
  zeroSince: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
