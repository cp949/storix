import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { generateNamespaceId } from '../../src/common/namespace-id.js';
import { ChangeFeedService } from '../../src/vfs/change-feed.service.js';
import { NamespaceService } from '../../src/namespace/namespace.service.js';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import type { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import type { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import type { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';

const NAMESPACE_ID = generateNamespaceId();
const diskFull = (): Error => Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
const connectionDropped = (): Error => new Error('Connection terminated unexpectedly');

function namespaceService(repos: {
  namespaceRepo?: object;
  idempotencyRepo?: object;
  provisioningRepo?: object;
}): NamespaceService {
  return new NamespaceService(
    (repos.namespaceRepo ?? {}) as unknown as Repository<NamespaceEntity>,
    (repos.idempotencyRepo ?? {}) as unknown as Repository<IdempotencyKeyEntity>,
    (repos.provisioningRepo ?? {}) as unknown as NamespaceProvisioningRepository,
    null,
    { get: () => undefined } as unknown as ConfigService,
  );
}

describe('분류 데코레이터가 없던 서비스 경로의 DB 오류', () => {
  it('NamespaceService.create는 영수증 조회 실패를 503으로 분류한다', async () => {
    const service = namespaceService({
      idempotencyRepo: {
        findOneBy: jest.fn<() => Promise<never>>().mockRejectedValue(connectionDropped()),
      },
    });
    await expect(service.create('key-1', 'acme')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
  });

  it('NamespaceService.create는 provisioning 저장 실패를 500 STORAGE_FAILURE로 분류한다', async () => {
    const service = namespaceService({
      idempotencyRepo: {
        findOneBy: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      },
      provisioningRepo: {
        createWithRoot: jest.fn<() => Promise<never>>().mockRejectedValue(diskFull()),
      },
    });
    await expect(service.create('key-1', 'acme')).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
      status: 500,
    });
  });

  it('NamespaceService.findAll은 목록 조회 실패를 분류한다', async () => {
    const service = namespaceService({
      namespaceRepo: { find: jest.fn<() => Promise<never>>().mockRejectedValue(diskFull()) },
    });
    await expect(service.findAll()).rejects.toMatchObject({ code: 'STORAGE_FAILURE', status: 500 });
  });

  it('NamespaceService.findPage는 페이지 조회 실패를 분류한다', async () => {
    const service = namespaceService({
      namespaceRepo: {
        createQueryBuilder: () => {
          throw connectionDropped();
        },
      },
    });
    await expect(service.findPage(undefined, undefined)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
  });

  it('ChangeFeedService.list는 namespace 조회 실패를 분류한다', async () => {
    const service = new ChangeFeedService(
      {
        findOneBy: jest.fn<() => Promise<never>>().mockRejectedValue(connectionDropped()),
      } as unknown as Repository<NamespaceEntity>,
      {} as unknown as VfsNodeRepository,
      {} as unknown as CapabilityService,
    );
    await expect(service.list(NAMESPACE_ID, undefined, undefined)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
  });
});
