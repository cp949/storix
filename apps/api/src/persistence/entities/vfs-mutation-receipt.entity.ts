import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  FIXED_CHAR_COLUMN_TYPE,
  NAMESPACE_ID_COLUMN_LENGTH,
  TIMESTAMP_COLUMN_TYPE,
} from './dialect-column-types.js';

export type VfsMutationReceiptState = 'RESERVED' | 'COMPLETE';

@Entity('vfs_mutation_receipt')
export class VfsMutationReceiptEntity {
  @PrimaryColumn({ name: 'namespace_id', type: 'varchar', length: NAMESPACE_ID_COLUMN_LENGTH })
  namespaceId: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  scope: string;

  @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 16 })
  state: VfsMutationReceiptState;

  @Column({ type: 'integer' })
  generation: number;

  @Column({ name: 'lease_expires_at', type: TIMESTAMP_COLUMN_TYPE, nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ name: 'expires_at', type: TIMESTAMP_COLUMN_TYPE })
  expiresAt: Date;

  @Column({ type: 'varchar', length: 16, nullable: true })
  method: string | null;

  @Column({ type: FIXED_CHAR_COLUMN_TYPE, length: 64, nullable: true })
  fingerprint: string | null;

  @Column({ name: 'response_status', type: 'smallint', nullable: true })
  responseStatus: number | null;

  @Column({ name: 'response_body', type: 'text', nullable: true })
  responseBody: string | null;

  @Column({ name: 'response_headers', type: 'text', nullable: true })
  responseHeaders: string | null;

  @Column({ name: 'request_body_bytes', type: 'bigint', nullable: true })
  requestBodyBytes: string | null;

  @Column({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;

  @Column({ name: 'updated_at', type: TIMESTAMP_COLUMN_TYPE })
  updatedAt: Date;
}
