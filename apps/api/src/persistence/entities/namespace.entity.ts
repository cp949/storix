import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type NamespaceStatus = 'ACTIVE' | 'DELETING' | 'DELETED';
export type EncryptionPolicy = 'NONE';

@Entity('namespace')
export class NamespaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({
    name: 'encryption_policy',
    type: 'varchar',
    length: 16,
    default: 'NONE',
  })
  encryptionPolicy: EncryptionPolicy;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: NamespaceStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
