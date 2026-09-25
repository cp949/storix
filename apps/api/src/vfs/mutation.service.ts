import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DomainError } from '../common/domain-error.js';
import { resolveErrorCode, resolveErrorMessage, resolveErrorPath } from '../common/domain-error.filter.js';
import {
  VfsMutationReceiptRepository,
  ReceiptIdentity,
  ReceiptResponse,
} from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { parseConditionalMutation, ConditionalMutation } from './dto/conditional-mutation-request.dto.js';
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

export function errorResponse(error: DomainError, requestId: string): MutationHttpResult {
  const path = resolveErrorPath(error);
  return {
    status: error.status,
    body: {
      code: resolveErrorCode(error, error.status),
      message: resolveErrorMessage(error, error.status),
      ...(path ? { path } : {}),
      requestId,
    },
    headers: { 'x-request-id': requestId },
  };
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
    if (claim.kind === 'busy') {
      return {
        status: 409,
        body: { code: 'MUTATION_IN_PROGRESS', message: 'mutation 처리 중', requestId },
        headers: { 'retry-after': String(claim.retryAfterSeconds), 'x-request-id': requestId },
      };
    }
    if (claim.kind === 'complete') {
      const receipt = claim.receipt;
      if (receipt.method !== method || receipt.fingerprint !== requestFingerprint) {
        return {
          status: 409,
          body: { code: 'MUTATION_KEY_REUSED', message: '다른 요청에 사용한 mutation key', requestId },
          headers: { 'x-request-id': requestId },
        };
      }
      return {
        status: receipt.responseStatus as number,
        body: JSON.parse(receipt.responseBody as string) as unknown,
        headers: JSON.parse(receipt.responseHeaders as string) as Record<string, string>,
      };
    }

    try {
      if (parseError) {
        const result = errorResponse(parseError, requestId);
        await this.nodes.withMutation(
          namespaceId,
          root.id,
          async () => null,
          (tx) => this.receipts.complete(tx, identity, claim.generation, requestFingerprint, method, result),
        );
        return result;
      }
      const validCommand = command as ConditionalMutation;
      const applied = await this.nodes.withMutation(
        namespaceId,
        root.id,
        (tx) => this.nodes.applyConditionalMutation(tx, validCommand),
        (tx, result) =>
          this.receipts.complete(tx, identity, claim.generation, requestFingerprint, method, {
            status: result.value.status,
            body: { resource: result.value.resource, affectedRevisions: result.affectedRevisions },
            headers: { 'x-request-id': requestId },
          }),
      );
      return {
        status: applied.value.status,
        body: { resource: applied.value.resource, affectedRevisions: applied.affectedRevisions },
        headers: { 'x-request-id': requestId },
      };
    } catch (error) {
      await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }
}
