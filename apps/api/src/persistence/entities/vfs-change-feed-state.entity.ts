import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('vfs_change_feed_state')
export class VfsChangeFeedStateEntity {
  @PrimaryColumn({ name: 'namespace_id', type: 'uuid' })
  namespaceId: string;

  @Column({ name: 'last_sequence', type: 'bigint', default: 0 })
  lastSequence: string;

  @Column({ name: 'pruned_through', type: 'bigint', default: 0 })
  prunedThrough: string;

  @Column({ name: 'has_checkpoint', type: 'boolean', default: false })
  hasCheckpoint: boolean;

  @Column({ name: 'signing_secret', type: 'varchar', length: 64 })
  signingSecret: string;
}
