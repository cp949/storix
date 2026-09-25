import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { MutationService } from './mutation.service.js';

describe('MutationService path parsing', () => {
  it('NFD path의 claim을 해제하고 완료 receipt를 만들지 않는다', async () => {
    const namespaceId = randomUUID();
    const rootId = randomUUID();
    const complete = jest.fn(async () => undefined);
    const release = jest.fn(async () => undefined);
    const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
    const service = new MutationService(
      { getRoot: async () => ({ id: rootId }), withMutation } as unknown as VfsNodeRepository,
      {
        claim: async () => ({ kind: 'owner', generation: 1 }),
        complete,
        release,
      } as unknown as VfsMutationReceiptRepository,
    );
    const result = await service.executeJson(
      namespaceId,
      'scope',
      randomUUID(),
      'POST',
      Buffer.from('{"kind":"mkdir","path":"/e\\u0301","ifAbsent":true}'),
      'req-1',
    );
    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH' } });
    expect(release).toHaveBeenCalledTimes(1);
    expect(withMutation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
