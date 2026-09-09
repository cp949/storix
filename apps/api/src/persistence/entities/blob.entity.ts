import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BINARY_COLUMN_TYPE, FIXED_CHAR_COLUMN_TYPE, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

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

  @Column({ type: FIXED_CHAR_COLUMN_TYPE, length: 64 })
  sha256: string;

  @Column({ name: 'encryption_iv', type: BINARY_COLUMN_TYPE, nullable: true })
  encryptionIv: Buffer | null;

  @Column({ name: 'reference_count', type: 'integer', default: 0 })
  referenceCount: number;

  @Column({ name: 'zero_since', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  zeroSince: Date | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;
}
