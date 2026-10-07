import { jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { IdempotencyKeyRequiredError, NamespaceNotFoundError } from '../../src/namespace/namespace.errors.js';
import { NamespaceController } from '../../src/namespace/namespace.controller.js';
import { NamespaceService } from '../../src/namespace/namespace.service.js';
import { NamespaceUploadSessionsReader } from '../../src/namespace/namespace-upload-sessions.reader.js';

describe('NamespaceController', () => {
  const namespaceService = {
    findById: jest.fn<NamespaceService['findById']>(),
    create: jest.fn<NamespaceService['create']>(),
  };
  const capabilityService = {
    listEnabled: jest.fn<CapabilityService['listEnabled']>(),
  };
  const uploadSessionsReader = {
    read: jest.fn<NamespaceUploadSessionsReader['read']>(),
  };
  let controller: NamespaceController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new NamespaceController(
      namespaceService as unknown as NamespaceService,
      capabilityService as unknown as CapabilityService,
      uploadSessionsReader as unknown as NamespaceUploadSessionsReader,
    );
  });

  it('GET 조회에 uploadSessions 블록이 있으면 namespace 응답에 합친다', async () => {
    const namespace = { id: 'namespace-id', status: 'ACTIVE' } as Awaited<
      ReturnType<NamespaceService['findById']>
    >;
    const block = {
      partSizeBytes: 4,
      inactivitySeconds: 60,
      maxLifetimeSeconds: 120,
      maxStagedBytes: '8',
      maxActiveSessions: 8,
      stagedBytes: '0',
      activeSessions: 0,
    };
    namespaceService.findById.mockResolvedValue(namespace);
    uploadSessionsReader.read.mockResolvedValue(block);

    await expect(controller.findOne('namespace-id')).resolves.toEqual({
      ...namespace,
      uploadSessions: block,
    });
    expect(uploadSessionsReader.read).toHaveBeenCalledWith('namespace-id', 'ACTIVE');
  });

  it('GET 조회에 uploadSessions 블록이 없으면 namespace 응답을 그대로 돌려준다', async () => {
    const namespace = { id: 'namespace-id', status: 'ACTIVE' } as Awaited<
      ReturnType<NamespaceService['findById']>
    >;
    namespaceService.findById.mockResolvedValue(namespace);
    uploadSessionsReader.read.mockResolvedValue(null);

    const result = await controller.findOne('namespace-id');

    expect(result).toBe(namespace);
    expect(result).not.toHaveProperty('uploadSessions');
  });

  it('ACTIVE namespace의 활성 capability를 반환하고 응답 캐시를 막는다', async () => {
    namespaceService.findById.mockResolvedValue({ status: 'ACTIVE' } as Awaited<
      ReturnType<NamespaceService['findById']>
    >);
    capabilityService.listEnabled.mockReturnValue(['content-search']);
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(controller.findCapabilities('namespace-id', response)).resolves.toEqual({
      capabilities: ['content-search'],
    });

    expect(namespaceService.findById).toHaveBeenCalledWith('namespace-id');
    expect(capabilityService.listEnabled).toHaveBeenCalledWith('namespace-id');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it.each(['DELETING', 'DELETED'] as const)('%s namespace의 capability 조회를 숨긴다', async (status) => {
    namespaceService.findById.mockResolvedValue({ status } as Awaited<
      ReturnType<NamespaceService['findById']>
    >);
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(controller.findCapabilities('namespace-id', response)).rejects.toBeInstanceOf(
      NamespaceNotFoundError,
    );
    expect(capabilityService.listEnabled).not.toHaveBeenCalled();
  });

  describe('POST /namespaces Idempotency-Key 길이', () => {
    const res = { status: jest.fn() } as unknown as Response;
    const req = {} as Request;
    const body = { name: 'docs' };

    it('255 byte 키는 service.create로 전달한다', async () => {
      namespaceService.create.mockResolvedValue({ status: 201, body: {} } as never);
      await controller.create('k'.repeat(255), body, req, res);
      expect(namespaceService.create).toHaveBeenCalledTimes(1);
    });

    it('응답 body의 id를 감사 로그용 auditNamespaceId로 넘기고 오류 body면 넘기지 않는다', async () => {
      const created = {} as Request;
      namespaceService.create.mockResolvedValue({ status: 201, body: { id: 'ns-1' } } as never);
      await controller.create('key', body, created, res);
      expect(created.auditNamespaceId).toBe('ns-1');

      const rejected = {} as Request;
      namespaceService.create.mockResolvedValue({
        status: 409,
        body: { code: 'NAMESPACE_ALREADY_EXISTS', message: 'x' },
      } as never);
      await controller.create('key', body, rejected, res);
      expect(rejected.auditNamespaceId).toBeUndefined();
    });

    it('256 byte 키는 IDEMPOTENCY_KEY_REQUIRED(400)로 거절하고 service를 호출하지 않는다', async () => {
      const error = await controller.create('k'.repeat(256), body, req, res).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdempotencyKeyRequiredError);
      expect((error as IdempotencyKeyRequiredError).message).toContain('255 byte');
      expect(namespaceService.create).not.toHaveBeenCalled();
    });

    it('키가 없으면 생성 경로의 255 byte 안내로 거절한다', async () => {
      const error = await controller.create(undefined, body, req, res).catch((e: unknown) => e);
      expect((error as IdempotencyKeyRequiredError).message).toBe(
        'Idempotency-Key 헤더가 필요하며 255 byte 이하여야 함',
      );
    });
  });
});
