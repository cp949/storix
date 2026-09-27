import { Injectable } from '@nestjs/common';
import { isUuid } from '../common/uuid.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsTrashRepository, type TrashListBoundary } from '../persistence/vfs-trash.repository.js';
import type { TrashPageDto } from './dto/trash-response.dto.js';
import { resolveLimit } from './pagination.js';
import { requireRoot } from './require-root.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

interface TrashCursor extends TrashListBoundary {
  readonly namespaceId: string;
  readonly order: 'deletedAtDescTrashIdAsc';
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;

function valid(cursor: TrashCursor): boolean {
  return isUuid(cursor.namespaceId) && isUuid(cursor.trashId) && cursor.order === 'deletedAtDescTrashIdAsc'
    && TIMESTAMP.test(cursor.deletedAtKey) && !Number.isNaN(Date.parse(cursor.deletedAtKey));
}

function encode(cursor: TrashCursor): string {
  if (!valid(cursor)) throw new VfsInvalidCursorError(JSON.stringify(cursor));
  return `tr1.${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

function decode(raw: string, namespaceId: string): TrashCursor {
  try {
    if (!/^tr1\.[A-Za-z0-9_-]+$/.test(raw)) throw new Error('prefix');
    const value: unknown = JSON.parse(Buffer.from(raw.slice(4), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const record = value as Record<string, unknown>;
    const keys = ['namespaceId', 'deletedAtKey', 'trashId', 'order'];
    if (Object.keys(record).length !== keys.length ||
      keys.some((key) => typeof record[key] !== 'string')) throw new Error('fields');
    const cursor = record as unknown as TrashCursor;
    if (!valid(cursor) || cursor.namespaceId.toLowerCase() !== namespaceId.toLowerCase()) throw new Error('owner');
    if (encode(cursor) !== raw) throw new Error('canonical');
    return cursor;
  } catch {
    throw new VfsInvalidCursorError(raw);
  }
}

@Injectable()
export class VfsTrashService {
  constructor(private readonly nodes: VfsNodeRepository, private readonly trash: VfsTrashRepository) {}

  async list(namespaceId: string, cursor: string | undefined, rawLimit: string | undefined): Promise<TrashPageDto> {
    await requireRoot(this.nodes, namespaceId);
    const after = cursor === undefined ? null : decode(cursor, namespaceId);
    const page = await this.trash.list(namespaceId, after, resolveLimit(rawLimit));
    return {
      items: page.items.map(({ deletedAtKey: _key, ...item }) => ({
        ...item, deletedAt: item.deletedAt.toISOString(), expiresAt: item.expiresAt.toISOString(),
      })),
      nextCursor: page.nextBoundary === null ? null : encode({
        namespaceId, order: 'deletedAtDescTrashIdAsc', ...page.nextBoundary,
      }),
    };
  }
}
