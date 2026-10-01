/** 삭제 서비스의 UUID 거부와 repository 호출 전 검증을 고정한다. */
import { NamespaceDeletionService } from '../../src/namespace/namespace-deletion.service.js';
import { NamespaceDeletionRepository } from '../../src/persistence/namespace-deletion.repository.js';
import { NamespaceNotFoundError } from '../../src/namespace/namespace.errors.js';

describe('namespace 삭제 서비스', () => {
  it('잘못된 UUID는 DB 조회 전에 NAMESPACE_NOT_FOUND로 거부한다', async () => {
    const service = new NamespaceDeletionService(null as unknown as NamespaceDeletionRepository);
    await expect(service.accept('invalid', 'key')).rejects.toThrow(NamespaceNotFoundError);
    await expect(service.getStatus('invalid')).rejects.toThrow(NamespaceNotFoundError);
  });
});
