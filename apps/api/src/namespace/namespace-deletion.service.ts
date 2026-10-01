/** 삭제 입력을 검증하고 repository 결과를 공개 오류 계약으로 바꾼다. */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUuid } from '../common/uuid.js';
import { NamespaceDeletionRepository } from '../persistence/namespace-deletion.repository.js';
import { NamespaceDeletionNotFoundError, NamespaceNotFoundError } from './namespace.errors.js';

@Injectable()
export class NamespaceDeletionService {
  constructor(private readonly repository: NamespaceDeletionRepository) {}

  async accept(namespaceId: string, key: string) {
    if (!isUuid(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const result = await this.repository.accept(
      namespaceId.toLowerCase(),
      createHash('sha256').update(key).digest('hex'),
      new Date(),
    );
    if (!result) throw new NamespaceNotFoundError(namespaceId);
    return result;
  }

  async getStatus(namespaceId: string) {
    if (!isUuid(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const result = await this.repository.findStatus(namespaceId.toLowerCase());
    if (!result.namespaceExists) throw new NamespaceNotFoundError(namespaceId);
    if (!result.view) throw new NamespaceDeletionNotFoundError(namespaceId);
    return {
      ...result.view,
      requestedAt: result.view.requestedAt.toISOString(),
      completedAt: result.view.completedAt?.toISOString() ?? null,
    };
  }
}
