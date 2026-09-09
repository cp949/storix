import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FIXED_CHAR_COLUMN_TYPE, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

@Entity('idempotency_key')
export class IdempotencyKeyEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  key: string;

  @Column({ name: 'request_hash', type: FIXED_CHAR_COLUMN_TYPE, length: 64 })
  requestHash: string;

  @Column({ name: 'response_status', type: 'smallint' })
  responseStatus: number;

  @Column({ name: 'response_body', type: 'jsonb' })
  responseBody: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE })
  createdAt: Date;
}
