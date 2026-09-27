import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DomainError } from '../common/domain-error.js';
import { isUuid } from '../common/uuid.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsTrashRepository, type TrashListBoundary } from '../persistence/vfs-trash.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { toNodeResponse } from './dto/node-response.dto.js';
import type { TrashPageDto } from './dto/trash-response.dto.js';
import { busyResponse, replayReceipt, storeErrorReceipt, type ErrorReceiptOwner } from './mutation-receipt.js';
import { hashParts, identityOf, type MutationHttpResult } from './mutation.service.js';
import { resolveLimit } from './pagination.js';
import { PathResolver } from './path-resolver.js';
import { requireRoot } from './require-root.js';
import { VfsInvalidCursorError, VfsInvalidMutationRequestError, VfsTrashItemNotFoundError } from './vfs.errors.js';

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
  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly trash: VfsTrashRepository,
    private readonly receipts: VfsMutationReceiptRepository,
  ) {}

  async restore(
    namespaceId: string, trashId: string, scope: string | undefined, key: string | undefined,
    rawBody: Buffer | undefined, requestId: string,
  ): Promise<MutationHttpResult> {
    return this.mutate(namespaceId, trashId, scope, key, rawBody, requestId, 'restore');
  }

  async purge(
    namespaceId: string, trashId: string, scope: string | undefined, key: string | undefined,
    rawBody: Buffer | undefined, requestId: string,
  ): Promise<MutationHttpResult> {
    return this.mutate(namespaceId, trashId, scope, key, rawBody, requestId, 'purge');
  }

  private async mutate(
    namespaceId: string, rawTrashId: string, scope: string | undefined, key: string | undefined,
    rawBody: Buffer | undefined, requestId: string, operation: 'restore' | 'purge',
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const root = await requireRoot(this.nodes, namespaceId);
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    let targetPath: string | undefined;
    let parseError: DomainError | null = null;
    try {
      const parsed: unknown = bytes.length === 0 ? {} : JSON.parse(bytes.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new VfsInvalidMutationRequestError();
      const body = parsed as Record<string, unknown>;
      if (Object.keys(body).some((field) => field !== 'targetPath') ||
        (operation === 'purge' && Object.keys(body).length > 0)) throw new VfsInvalidMutationRequestError();
      if (body.targetPath !== undefined) {
        if (typeof body.targetPath !== 'string') throw new VfsInvalidMutationRequestError();
        const resolved = new PathResolver().resolve(body.targetPath);
        if (resolved.segments.length === 0) throw new VfsInvalidMutationRequestError();
        targetPath = resolved.canonical;
      }
      if (!isUuid(rawTrashId)) throw new VfsTrashItemNotFoundError(rawTrashId);
    } catch (error) {
      parseError = error instanceof DomainError ? error : new VfsInvalidMutationRequestError();
    }
    const trashId = rawTrashId.toLowerCase();
    const fingerprint = hashParts([
      'POST', `trash/${trashId}/${operation}`, JSON.stringify({ targetPath }),
      createHash('sha256').update(bytes).digest('hex'),
    ]);
    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') return busyResponse(claim.retryAfterSeconds, requestId);
    if (claim.kind === 'complete') return replayReceipt(claim.receipt, 'POST', fingerprint, requestId);
    const owner: ErrorReceiptOwner = {
      identity, generation: claim.generation, fingerprint, method: 'POST', requestBodyBytes: bytes.length,
    };
    try {
      if (parseError) return await storeErrorReceipt(this.receipts, owner, parseError, requestId);
      let response: MutationHttpResult | undefined;
      try {
        await this.nodes.withMutation(namespaceId, root.id, async (tx) => operation === 'restore'
          ? this.nodes.restoreTrashItem(namespaceId, trashId, targetPath, tx)
          : this.nodes.purgeTrashItem(namespaceId, trashId, tx),
        async (tx, result) => {
          const value = result.value;
          response = operation === 'restore' && 'node' in value
            ? { status: 200, body: { trashId, resource: {
                ...toNodeResponse(value.node, value.path), revision: result.affectedRevisions.find(
                  (entry) => entry.path === value.path)?.revision,
              } }, headers: { 'x-request-id': requestId } }
            : { status: 200, body: { trashId, purged: true }, headers: { 'x-request-id': requestId } };
          await this.receipts.complete(tx, identity, claim.generation, fingerprint, 'POST', response, bytes.length);
        });
      } catch (error) {
        return await storeErrorReceipt(this.receipts, owner, error, requestId);
      }
      return response!;
    } catch (error) {
      await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }

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
