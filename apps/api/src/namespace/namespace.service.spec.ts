import { jest } from '@jest/globals';
import type { Repository } from 'typeorm';
import { canonicalJsonHash } from '../common/canonical-json-hash.js';
import { NamespaceEncryptionNotConfiguredError } from '../encryption/encryption.errors.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceProvisioningRepository } from '../persistence/namespace-provisioning.repository.js';
import {
  IdempotencyKeyReusedError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
} from './namespace.errors.js';
import { NamespaceService } from './namespace.service.js';

function makeNamespaceEntity(overrides: Partial<NamespaceEntity> = {}): NamespaceEntity {
  return {
    id: 'ns-1',
    name: 'acme',
    encryptionPolicy: 'NONE',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as NamespaceEntity;
}

describe('NamespaceService', () => {
  let namespaceRepo: {
    findOneBy: jest.Mock<() => Promise<NamespaceEntity | null>>;
    find: jest.Mock<() => Promise<NamespaceEntity[]>>;
  };
  let idempotencyRepo: {
    findOneBy: jest.Mock<() => Promise<IdempotencyKeyEntity | null>>;
    insert: jest.Mock<() => Promise<unknown>>;
  };
  let provisioningRepo: { createWithRoot: jest.Mock<() => Promise<NamespaceEntity>> };
  let service: NamespaceService;

  beforeEach(() => {
    namespaceRepo = { findOneBy: jest.fn(), find: jest.fn() };
    idempotencyRepo = { findOneBy: jest.fn(), insert: jest.fn() };
    provisioningRepo = { createWithRoot: jest.fn() };

    service = new NamespaceService(
      namespaceRepo as unknown as Repository<NamespaceEntity>,
      idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
      provisioningRepo as unknown as NamespaceProvisioningRepository,
      null,
    );
  });

  describe('create', () => {
    it('처음 보는 key면 namespace를 생성하고 201과 함께 idempotency record를 남긴다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity());

      const result = await service.create('key-1', 'acme');

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ id: 'ns-1', name: 'acme' });
      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith('acme', 'NONE');
      expect(idempotencyRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'key-1', responseStatus: 201 }),
      );
    });

    it('같은 key와 같은 body로 재시도하면 저장된 응답을 그대로 재생하고 다시 생성하지 않는다', async () => {
      const storedBody = { id: 'ns-1', name: 'acme' };
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: canonicalJsonHash({ name: 'acme', encryptionPolicy: 'NONE' }),
        responseStatus: 201,
        responseBody: storedBody,
      } as unknown as IdempotencyKeyEntity);

      const result = await service.create('key-1', 'acme');

      expect(result).toEqual({ status: 201, body: storedBody });
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });

    it('같은 key에 다른 body가 재사용되면 IdempotencyKeyReusedError를 던진다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: 'x'.repeat(64),
        responseStatus: 201,
        responseBody: { id: 'ns-1', name: 'acme' },
      } as unknown as IdempotencyKeyEntity);

      await expect(service.create('key-1', 'other-name')).rejects.toThrow(IdempotencyKeyReusedError);
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });

    it('이미 활성화된 name과 충돌하면 409 idempotency record를 남기고 에러를 다시 던진다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockRejectedValue(new NamespaceAlreadyExistsError('acme'));

      await expect(service.create('key-1', 'acme')).rejects.toThrow(NamespaceAlreadyExistsError);
      expect(idempotencyRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'key-1',
          responseStatus: 409,
          responseBody: { code: 'NAMESPACE_ALREADY_EXISTS', message: expect.any(String) },
        }),
      );
    });

    it('idempotency record 기록이 동시성 충돌(23505)로 실패해도 계산된 결과를 그대로 반환한다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity());
      idempotencyRepo.insert.mockRejectedValue({ code: '23505' });

      const result = await service.create('key-1', 'acme');

      expect(result.status).toBe(201);
    });

    it('encryptionPolicy가 ENCRYPTED이고 마스터 키가 없으면 NamespaceEncryptionNotConfiguredError를 던진다', async () => {
      await expect(service.create('key-1', 'acme', 'ENCRYPTED')).rejects.toThrow(
        NamespaceEncryptionNotConfiguredError,
      );
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });

    it('마스터 키가 설정되어 있으면 ENCRYPTED namespace 생성을 그대로 진행한다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        Buffer.alloc(32),
      );
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity({ encryptionPolicy: 'ENCRYPTED' }));

      const result = await service.create('key-1', 'acme', 'ENCRYPTED');

      expect(result.status).toBe(201);
      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith('acme', 'ENCRYPTED');
    });
  });

  describe('findById', () => {
    it('UUID 형식이 아니면 NamespaceNotFoundError를 던진다', async () => {
      await expect(service.findById('not-a-uuid')).rejects.toThrow(NamespaceNotFoundError);
      expect(namespaceRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('존재하지 않는 id면 NamespaceNotFoundError를 던진다', async () => {
      namespaceRepo.findOneBy.mockResolvedValue(null);

      await expect(service.findById('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
        NamespaceNotFoundError,
      );
    });

    it('존재하는 namespace를 응답 DTO로 반환한다', async () => {
      namespaceRepo.findOneBy.mockResolvedValue(makeNamespaceEntity({ id: '11111111-1111-1111-1111-111111111111' }));

      const result = await service.findById('11111111-1111-1111-1111-111111111111');

      expect(result.id).toBe('11111111-1111-1111-1111-111111111111');
    });
  });

  describe('findAll', () => {
    it('activate namespace 목록을 name/id 오름차순으로 응답 DTO 배열로 반환한다', async () => {
      namespaceRepo.find.mockResolvedValue([makeNamespaceEntity(), makeNamespaceEntity({ id: 'ns-2', name: 'beta' })]);

      const result = await service.findAll();

      expect(namespaceRepo.find).toHaveBeenCalledWith({
        where: { status: 'ACTIVE' },
        order: { name: 'ASC', id: 'ASC' },
      });
      expect(result).toEqual([
        expect.objectContaining({ id: 'ns-1' }),
        expect.objectContaining({ id: 'ns-2' }),
      ]);
    });
  });
});
