import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CapabilityService } from '../capability/capability.service.js';
import { isUuid } from '../common/uuid.js';
import { NamespaceNotFoundError } from '../namespace/namespace.errors.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { decodeChangeFeedCursor, encodeChangeFeedCursor } from './change-feed-cursor.js';
import { toChangeFeedEventDto, type ChangeFeedPageDto } from './dto/change-feed-response.dto.js';
import { resolveLimit } from './pagination.js';
import { VfsChangeCursorExpiredError, VfsInvalidChangeCursorError } from './vfs.errors.js';

@Injectable()
export class ChangeFeedService {
  constructor(
    @InjectRepository(NamespaceEntity) private readonly namespaces: Repository<NamespaceEntity>,
    private readonly nodes: VfsNodeRepository,
    private readonly capabilities: CapabilityService,
  ) {}

  async list(namespaceId: string, rawCursor: string | undefined, rawLimit: string | undefined): Promise<ChangeFeedPageDto> {
    if (!isUuid(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const id = namespaceId.toLowerCase();
    const namespace = await this.namespaces.findOneBy({ id });
    if (!namespace || namespace.status !== 'ACTIVE') throw new NamespaceNotFoundError(namespaceId);
    this.capabilities.requireEnabled(id, 'change-feed');
    const root = await this.nodes.getRoot(id);
    if (!root) throw new NamespaceNotFoundError(namespaceId);

    if (rawCursor === undefined) {
      const sequence = await this.nodes.createChangeFeedCheckpoint(id, root.id);
      const state = await this.nodes.getChangeFeedState(id);
      if (!state) throw new Error('Change feed checkpoint state missing');
      return { changes: [], nextCursor: encodeChangeFeedCursor(id, sequence, state.signingSecret), hasMore: false };
    }

    const limit = resolveLimit(rawLimit);
    const { state, events: rows } = await this.nodes.readChangeFeedPage(id, limit + 1, (state) => {
      if (!state?.hasCheckpoint) throw new VfsInvalidChangeCursorError();
      const sequence = decodeChangeFeedCursor(rawCursor, id, state.signingSecret);
      if (BigInt(sequence) > BigInt(state.lastSequence)) throw new VfsInvalidChangeCursorError();
      if (BigInt(sequence) < BigInt(state.prunedThrough)) throw new VfsChangeCursorExpiredError();
      return sequence;
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      changes: page.map(toChangeFeedEventDto),
      nextCursor: page.length === 0 ? rawCursor :
        encodeChangeFeedCursor(id, page[page.length - 1].sequence, state.signingSecret),
      hasMore,
    };
  }
}
