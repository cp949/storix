import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DomainError } from '../common/domain-error.js';
import {
  VfsMutationReceiptRepository,
  ReceiptIdentity,
  ReceiptResponse,
} from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { parseConditionalMutation, ConditionalMutation } from './dto/conditional-mutation-request.dto.js';
import { busyResponse, ErrorReceiptOwner, replayReceipt, storeErrorReceipt } from './mutation-receipt.js';
import { requireRoot } from './require-root.js';
import { VfsInvalidMutationRequestError } from './vfs.errors.js';

export type MutationHttpResult = ReceiptResponse;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hashParts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size).update(bytes);
  }
  return hash.digest('hex');
}

function fingerprint(method: string, command: ConditionalMutation | null, rawBody: Buffer): string {
  return hashParts([
    method,
    'application/json',
    command ? JSON.stringify(command) : 'invalid',
    createHash('sha256').update(rawBody).digest('hex'),
  ]);
}

export function identityOf(
  namespaceId: string,
  scope: string | undefined,
  key: string | undefined,
): ReceiptIdentity {
  if (!key || !UUID_PATTERN.test(key) || !scope || Buffer.byteLength(scope, 'utf8') > 128) {
    throw new VfsInvalidMutationRequestError();
  }
  return { namespaceId, scope, key: key.toLowerCase() };
}

@Injectable()
export class MutationService {
  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly receipts: VfsMutationReceiptRepository,
  ) {}

  async executeJson(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    method: string,
    rawBody: Buffer | undefined,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const root = await requireRoot(this.nodes, namespaceId);
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    let command: ConditionalMutation | null = null;
    let parseError: DomainError | null = null;
    try {
      command = parseConditionalMutation(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof DomainError) parseError = error;
      else parseError = new VfsInvalidMutationRequestError();
    }
    const requestFingerprint = fingerprint(method, command, bytes);
    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') return busyResponse(claim.retryAfterSeconds, requestId);
    if (claim.kind === 'complete') return replayReceipt(claim.receipt, method, requestFingerprint, requestId);

    const owner: ErrorReceiptOwner = {
      identity,
      generation: claim.generation,
      fingerprint: requestFingerprint,
      method,
    };
    try {
      if (parseError) return await storeErrorReceipt(this.receipts, owner, parseError, requestId);
      return await this.apply(namespaceId, root.id, command as ConditionalMutation, owner, requestId).catch(
        (error: unknown) => storeErrorReceipt(this.receipts, owner, error, requestId),
      );
    } catch (error) {
      await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }

  // 성공 receipt는 같은 트랜잭션의 after-bump에서 완료한다. 여기서 던진 오류는 롤백 뒤
  // storeErrorReceipt가 저장 여부를 판정한다.
  private async apply(
    namespaceId: string,
    rootId: string,
    command: ConditionalMutation,
    owner: ErrorReceiptOwner,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const toResponse = (result: {
      value: { status: number; resource: unknown };
      affectedRevisions: unknown;
    }): MutationHttpResult => ({
      status: result.value.status,
      body: { resource: result.value.resource, affectedRevisions: result.affectedRevisions },
      headers: { 'x-request-id': requestId },
    });
    const applied = await this.nodes.withMutation(
      namespaceId,
      rootId,
      (tx) => this.nodes.applyConditionalMutation(tx, command),
      (tx, result) =>
        this.receipts.complete(
          tx,
          owner.identity,
          owner.generation,
          owner.fingerprint,
          owner.method,
          toResponse(result),
        ),
    );
    return toResponse(applied);
  }
}
