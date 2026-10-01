import { jest } from '@jest/globals';
import type { Repository } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { EncryptionBootGuard } from '../../src/encryption/encryption-boot-guard.js';

describe('EncryptionBootGuard', () => {
  let namespaceRepo: {
    exists: jest.Mock<() => Promise<boolean>>;
    count: jest.Mock<() => Promise<number>>;
  };

  beforeEach(() => {
    namespaceRepo = { exists: jest.fn(), count: jest.fn() };
  });

  it('마스터 키가 있으면 ENCRYPTED namespace 존재 여부를 확인하지 않고 통과한다', async () => {
    const guard = new EncryptionBootGuard(
      namespaceRepo as unknown as Repository<NamespaceEntity>,
      Buffer.alloc(32),
    );

    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(namespaceRepo.exists).not.toHaveBeenCalled();
    expect(namespaceRepo.count).not.toHaveBeenCalled();
  });

  it('마스터 키가 없고 ENCRYPTED namespace도 없으면 통과한다', async () => {
    namespaceRepo.exists.mockResolvedValue(false);
    const guard = new EncryptionBootGuard(namespaceRepo as unknown as Repository<NamespaceEntity>, null);

    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(namespaceRepo.exists).toHaveBeenCalledWith({ where: { encryptionPolicy: 'ENCRYPTED' } });
    // 전체 namespace를 세지 않는다. 존재 여부만 확인한다.
    expect(namespaceRepo.count).not.toHaveBeenCalled();
  });

  it('마스터 키가 없는데 ENCRYPTED namespace가 있으면 부팅을 실패시킨다', async () => {
    namespaceRepo.exists.mockResolvedValue(true);
    namespaceRepo.count.mockResolvedValue(3);
    const guard = new EncryptionBootGuard(namespaceRepo as unknown as Repository<NamespaceEntity>, null);

    await expect(guard.onApplicationBootstrap()).rejects.toThrow('ENCRYPTED namespace가 3개');
  });
});
