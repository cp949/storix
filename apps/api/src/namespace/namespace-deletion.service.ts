/**
 * 삭제 입력을 검증하고 repository 결과를 공개 오류 계약으로 바꾼다.
 * 규칙은 docs/design/13-namespace-deletion.md "HTTP 계약". 결정은 api ADR-0032.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isNamespaceId } from '../common/namespace-id.js';
import { NamespaceDeletionRepository } from '../persistence/namespace-deletion.repository.js';
import { NamespaceDeletionNotFoundError, NamespaceNotFoundError } from './namespace.errors.js';

/**
 * 삭제 접수와 상태 조회의 입력을 검증하고 repository 결과를 공개 오류로 바꾼다.
 *
 * - ID 형식이 잘못됐거나 없는 namespace는 `NamespaceNotFoundError`다.
 * - 키 원문은 repository에 넘기지 않고 SHA-256 hash만 넘긴다.
 * - 삭제 operation이 없는 namespace의 상태 조회는 `NamespaceDeletionNotFoundError`다.
 *
 * 규칙은 docs/design/13-namespace-deletion.md "HTTP 계약".
 */
@Injectable()
export class NamespaceDeletionService {
  constructor(private readonly repository: NamespaceDeletionRepository) {}

  async accept(namespaceId: string, key: string) {
    if (!isNamespaceId(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const result = await this.repository.accept(
      namespaceId,
      createHash('sha256').update(key).digest('hex'),
      new Date(),
    );
    if (!result) throw new NamespaceNotFoundError(namespaceId);
    return result;
  }

  async getStatus(namespaceId: string) {
    if (!isNamespaceId(namespaceId)) throw new NamespaceNotFoundError(namespaceId);
    const result = await this.repository.findStatus(namespaceId);
    if (!result.namespaceExists) throw new NamespaceNotFoundError(namespaceId);
    if (!result.view) throw new NamespaceDeletionNotFoundError(namespaceId);
    return {
      ...result.view,
      requestedAt: result.view.requestedAt.toISOString(),
      completedAt: result.view.completedAt?.toISOString() ?? null,
    };
  }
}
