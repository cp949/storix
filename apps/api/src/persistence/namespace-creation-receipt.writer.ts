import { Injectable } from '@nestjs/common';
import { EntityManager, QueryDeepPartialEntity } from 'typeorm';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';

export interface NamespaceCreationReceiptInput {
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: 201;
  readonly responseBody: Record<string, unknown>;
}

@Injectable()
export class NamespaceCreationReceiptWriter {
  async save(manager: EntityManager, input: NamespaceCreationReceiptInput): Promise<void> {
    await manager.getRepository(IdempotencyKeyEntity).insert({
      key: input.key,
      requestHash: input.requestHash,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
    } as QueryDeepPartialEntity<IdempotencyKeyEntity>);
  }
}
