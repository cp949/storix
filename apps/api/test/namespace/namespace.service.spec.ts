import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { canonicalJsonHash } from '../../src/common/canonical-json-hash.js';
import { NamespaceEncryptionNotConfiguredError } from '../../src/encryption/encryption.errors.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import {
  IdempotencyKeyReusedError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  NamespaceQuotaLimitExceedsGlobalError,
} from '../../src/namespace/namespace.errors.js';
import { NamespaceService } from '../../src/namespace/namespace.service.js';

function makeNamespaceEntity(overrides: Partial<NamespaceEntity> = {}): NamespaceEntity {
  return {
    id: 'ns-1',
    name: 'acme',
    encryptionPolicy: 'NONE',
    accessPolicy: 'PRIVATE',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as NamespaceEntity;
}

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('NamespaceService', () => {
  let namespaceRepo: {
    findOneBy: jest.Mock<() => Promise<NamespaceEntity | null>>;
    find: jest.Mock<() => Promise<NamespaceEntity[]>>;
    manager: {
      connection: { options: { type: 'better-sqlite3' } };
      query: jest.Mock<(sql: string, ids: string[]) => Promise<unknown[]>>;
    };
  };
  let idempotencyRepo: {
    findOneBy: jest.Mock<() => Promise<IdempotencyKeyEntity | null>>;
    insert: jest.Mock<(entity: Partial<IdempotencyKeyEntity>) => Promise<unknown>>;
  };
  let provisioningRepo: { createWithRoot: jest.Mock<() => Promise<NamespaceEntity>> };
  let service: NamespaceService;

  beforeEach(() => {
    namespaceRepo = {
      findOneBy: jest.fn(),
      find: jest.fn(),
      manager: {
        connection: { options: { type: 'better-sqlite3' } },
        query: jest.fn(async (_sql: string, ids: string[]) =>
          ids.map((id) => ({
            id,
            maxTotalLogicalBytes: null,
            liveFileByteCount: '0',
            retainedSnapshotByteCount: '0',
            retainedTrashByteCount: '0',
            retainedTrashNodeCount: '0',
          })),
        ),
      },
    };
    idempotencyRepo = { findOneBy: jest.fn(), insert: jest.fn() };
    provisioningRepo = { createWithRoot: jest.fn() };

    service = new NamespaceService(
      namespaceRepo as unknown as Repository<NamespaceEntity>,
      idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
      provisioningRepo as unknown as NamespaceProvisioningRepository,
      null,
      makeConfig(),
    );
  });

  describe('create', () => {
    it('처음 보는 key면 receipt와 함께 namespace 생성 transaction을 요청한다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity());

      const result = await service.create('key-1', 'acme');

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ id: 'ns-1', name: 'acme' });
      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith(
        expect.any(String),
        'acme',
        'NONE',
        'PRIVATE',
        null,
        expect.objectContaining({ key: 'key-1', responseStatus: 201, requestHash: expect.any(String) }),
      );
      expect(idempotencyRepo.insert).not.toHaveBeenCalled();
    });

    it('같은 key와 같은 body로 재시도하면 저장된 응답을 그대로 재생하고 다시 생성하지 않는다', async () => {
      const storedBody = { id: 'ns-1', name: 'acme' };
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: canonicalJsonHash({ name: 'acme', encryptionPolicy: 'NONE', accessPolicy: 'PRIVATE' }),
        responseStatus: 201,
        responseBody: storedBody,
      } as unknown as IdempotencyKeyEntity);

      const result = await service.create('key-1', 'acme');

      expect(result).toEqual({ status: 201, body: storedBody });
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });

    it('idPrefix를 요청 hash에 넣고 application ID를 provisioning에 전달한다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(
        makeNamespaceEntity({ id: `tenant_${'a'.repeat(32)}` }),
      );

      await service.create('key-prefix', 'acme', 'NONE', 'PRIVATE', null, 'tenant');

      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith(
        expect.stringMatching(/^tenant_[0-9a-f]{32}$/),
        'acme',
        'NONE',
        'PRIVATE',
        null,
        expect.objectContaining({
          key: 'key-prefix',
          requestHash: canonicalJsonHash({
            name: 'acme',
            idPrefix: 'tenant',
            encryptionPolicy: 'NONE',
            accessPolicy: 'PRIVATE',
          }),
        }),
      );
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

    it('409 idempotency record 저장 실패에도 원래 namespace 충돌 오류를 보존한다', async () => {
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      const provisioningError = new NamespaceAlreadyExistsError('acme');
      provisioningRepo.createWithRoot.mockRejectedValue(provisioningError);
      idempotencyRepo.insert.mockRejectedValue(new Error('injected conflict receipt write failure'));

      await expect(service.create('key-1', 'acme')).rejects.toBe(provisioningError);
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
        makeConfig(),
      );
      idempotencyRepo.findOneBy.mockResolvedValue(null);
      provisioningRepo.createWithRoot.mockResolvedValue(
        makeNamespaceEntity({ encryptionPolicy: 'ENCRYPTED' }),
      );

      const result = await service.create('key-1', 'acme', 'ENCRYPTED');

      expect(result.status).toBe(201);
      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith(
        expect.any(String),
        'acme',
        'ENCRYPTED',
        'PRIVATE',
        null,
        expect.any(Object),
      );
    });

    it('accessPolicy를 provisioningRepo에 그대로 전달한다', async () => {
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity({ accessPolicy: 'PUBLIC' }));

      await service.create('key-public', 'public-ns', 'NONE', 'PUBLIC');

      expect(provisioningRepo.createWithRoot).toHaveBeenCalledWith(
        expect.any(String),
        'public-ns',
        'NONE',
        'PUBLIC',
        null,
        expect.any(Object),
      );
    });

    it('accessPolicy만 다른 재요청은 같은 Idempotency-Key로 재사용할 수 없다', async () => {
      // 테스트가 canonicalJsonHash를 직접 재계산하면, 구현이 accessPolicy를
      // 해시에서 빠뜨리는 회귀가 생겨도 테스트가 같은 실수를 반복해 통과해버린다.
      // 서비스가 계산해야 하는 계약 hash를 독립적으로 구성해 재사용 검증을 확인한다.
      idempotencyRepo.findOneBy.mockResolvedValueOnce(null);
      provisioningRepo.createWithRoot.mockResolvedValue(makeNamespaceEntity());

      await service.create('key-reuse', 'acme', 'NONE', 'PRIVATE');

      const persistedHash = canonicalJsonHash({
        name: 'acme',
        encryptionPolicy: 'NONE',
        accessPolicy: 'PRIVATE',
      });

      idempotencyRepo.findOneBy.mockResolvedValueOnce({
        key: 'key-reuse',
        requestHash: persistedHash,
        responseStatus: 201,
        responseBody: {},
      } as unknown as IdempotencyKeyEntity);

      await expect(service.create('key-reuse', 'acme', 'NONE', 'PUBLIC')).rejects.toThrow(
        IdempotencyKeyReusedError,
      );
    });
  });

  describe('create quota 검증', () => {
    it('ConfigService 전역 quota보다 큰 namespace override는 생성 전에 거부한다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        null,
        makeConfig({ STORIX_MAX_TOTAL_LOGICAL_BYTES: '100' }),
      );

      await expect(service.create('key-1', 'acme', 'NONE', 'PRIVATE', '101')).rejects.toThrow(
        NamespaceQuotaLimitExceedsGlobalError,
      );
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });
  });

  describe('create 영수증 재생과 전역 설정 검사의 순서', () => {
    it('전역 quota가 낮아진 뒤에도 저장된 201 영수증은 재생한다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        null,
        makeConfig({ STORIX_MAX_TOTAL_LOGICAL_BYTES: '100' }),
      );
      const storedBody = { id: 'ns-1', name: 'acme' };
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: canonicalJsonHash({
          name: 'acme',
          encryptionPolicy: 'NONE',
          accessPolicy: 'PRIVATE',
          maxTotalLogicalBytes: '101',
        }),
        responseStatus: 201,
        responseBody: storedBody,
      } as unknown as IdempotencyKeyEntity);

      const result = await service.create('key-1', 'acme', 'NONE', 'PRIVATE', '101');

      expect(result).toEqual({ status: 201, body: storedBody });
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
    });

    it('같은 key에 다른 body가 오면 전역 quota 초과보다 IdempotencyKeyReusedError가 먼저다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        null,
        makeConfig({ STORIX_MAX_TOTAL_LOGICAL_BYTES: '100' }),
      );
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: canonicalJsonHash({ name: 'acme', encryptionPolicy: 'NONE', accessPolicy: 'PRIVATE' }),
        responseStatus: 201,
        responseBody: {},
      } as unknown as IdempotencyKeyEntity);

      await expect(service.create('key-1', 'acme', 'NONE', 'PRIVATE', '101')).rejects.toThrow(
        IdempotencyKeyReusedError,
      );
    });

    it('마스터 키가 빠진 뒤에도 ENCRYPTED 생성의 저장된 201 영수증은 재생한다', async () => {
      const storedBody = { id: 'ns-1', name: 'acme' };
      idempotencyRepo.findOneBy.mockResolvedValue({
        key: 'key-1',
        requestHash: canonicalJsonHash({
          name: 'acme',
          encryptionPolicy: 'ENCRYPTED',
          accessPolicy: 'PRIVATE',
        }),
        responseStatus: 201,
        responseBody: storedBody,
      } as unknown as IdempotencyKeyEntity);

      const result = await service.create('key-1', 'acme', 'ENCRYPTED');

      expect(result).toEqual({ status: 201, body: storedBody });
      expect(provisioningRepo.createWithRoot).not.toHaveBeenCalled();
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

    it('유효한 prefix ID는 조회하고 대문자 변형은 거부한다', async () => {
      const id = `tenant_${'a'.repeat(32)}`;
      namespaceRepo.findOneBy.mockResolvedValue(makeNamespaceEntity({ id }));

      expect((await service.findById(id)).id).toBe(id);
      await expect(service.findById(`Tenant_${'a'.repeat(32)}`)).rejects.toThrow(NamespaceNotFoundError);
    });

    it('존재하는 namespace를 응답 DTO로 반환한다', async () => {
      namespaceRepo.findOneBy.mockResolvedValue(
        makeNamespaceEntity({ id: '11111111-1111-1111-1111-111111111111' }),
      );

      const result = await service.findById('11111111-1111-1111-1111-111111111111');

      expect(result.id).toBe('11111111-1111-1111-1111-111111111111');
      expect(result.limits).toEqual({
        maxFileSizeBytes: '5368709120',
        maxFilesPerFolder: '10000',
        maxNodes: '1000000',
      });
    });

    it('응답 파일 한도는 ConfigService의 STORIX_MAX_FILE_SIZE_BYTES를 사용한다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        null,
        makeConfig({ STORIX_MAX_FILE_SIZE_BYTES: '4096' }),
      );
      namespaceRepo.findOneBy.mockResolvedValue(
        makeNamespaceEntity({ id: '11111111-1111-1111-1111-111111111111', maxFileSizeBytes: null }),
      );

      const result = await service.findById('11111111-1111-1111-1111-111111111111');

      expect(result.limits).toEqual({
        maxFileSizeBytes: '4096',
        maxFilesPerFolder: '10000',
        maxNodes: '1000000',
      });
    });

    it('응답 quota 상한은 ConfigService의 STORIX_MAX_TOTAL_LOGICAL_BYTES를 사용한다', async () => {
      service = new NamespaceService(
        namespaceRepo as unknown as Repository<NamespaceEntity>,
        idempotencyRepo as unknown as Repository<IdempotencyKeyEntity>,
        provisioningRepo as unknown as NamespaceProvisioningRepository,
        null,
        makeConfig({ STORIX_MAX_TOTAL_LOGICAL_BYTES: '2048' }),
      );
      namespaceRepo.findOneBy.mockResolvedValue(
        makeNamespaceEntity({ id: '11111111-1111-1111-1111-111111111111', maxTotalLogicalBytes: null }),
      );

      const result = await service.findById('11111111-1111-1111-1111-111111111111');

      expect(result.quota.limitBytes).toBe('2048');
    });
  });

  describe('findAll', () => {
    it('activate namespace 목록을 name/id 오름차순으로 응답 DTO 배열로 반환한다', async () => {
      namespaceRepo.find
        .mockResolvedValueOnce([makeNamespaceEntity(), makeNamespaceEntity({ id: 'ns-2', name: 'beta' })])
        .mockResolvedValueOnce([makeNamespaceEntity({ id: 'ns-3', name: null })]);

      const result = await service.findAll();

      expect(namespaceRepo.find).toHaveBeenNthCalledWith(1, {
        where: { status: 'ACTIVE', name: expect.anything() },
        order: { name: 'ASC', id: 'ASC' },
      });
      expect(namespaceRepo.find).toHaveBeenNthCalledWith(2, {
        where: { status: 'ACTIVE', name: expect.anything() },
        order: { id: 'ASC' },
      });
      expect(result).toEqual([
        expect.objectContaining({ id: 'ns-1' }),
        expect.objectContaining({ id: 'ns-2' }),
        expect.objectContaining({ id: 'ns-3', name: null }),
      ]);
    });
  });
});
