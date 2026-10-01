/**
 * 삭제 요청의 최초 응답을 namespace UUID·키 hash별로 보존한다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FIXED_CHAR_COLUMN_TYPE, TIMESTAMP_COLUMN_TYPE } from './dialect-column-types.js';

@Entity('namespace_deletion_receipt')
export class NamespaceDeletionReceiptEntity {
  @PrimaryColumn({ name: 'namespace_id', type: 'uuid' }) namespaceId: string;
  @PrimaryColumn({ name: 'key_hash', type: FIXED_CHAR_COLUMN_TYPE, length: 64 }) keyHash: string;
  @Column({ name: 'response_status', type: 'smallint' }) responseStatus: number;
  @Column({ name: 'response_body', type: 'jsonb' }) responseBody: {
    namespaceId: string;
    status: 'DELETING' | 'DELETED';
  };
  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP_COLUMN_TYPE }) createdAt: Date;
}
