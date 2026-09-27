import { jest } from '@jest/globals';
import type { Response } from 'express';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceNotFoundError } from '../../src/namespace/namespace.errors.js';
import { NamespaceController } from '../../src/namespace/namespace.controller.js';
import { NamespaceService } from '../../src/namespace/namespace.service.js';

describe('NamespaceController', () => {
  const namespaceService = {
    findById: jest.fn<NamespaceService['findById']>(),
  };
  const capabilityService = {
    listEnabled: jest.fn<CapabilityService['listEnabled']>(),
  };
  let controller: NamespaceController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new NamespaceController(
      namespaceService as unknown as NamespaceService,
      capabilityService as unknown as CapabilityService,
    );
  });

  it('ACTIVE namespace의 활성 capability를 반환하고 응답 캐시를 막는다', async () => {
    namespaceService.findById.mockResolvedValue({ status: 'ACTIVE' } as Awaited<
      ReturnType<NamespaceService['findById']>
    >);
    capabilityService.listEnabled.mockReturnValue(['content-search']);
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(controller.findCapabilities('namespace-id', response)).resolves.toEqual({ capabilities: ['content-search'] });

    expect(namespaceService.findById).toHaveBeenCalledWith('namespace-id');
    expect(capabilityService.listEnabled).toHaveBeenCalledWith('namespace-id');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it.each(['DELETING', 'DELETED'] as const)('%s namespace의 capability 조회를 숨긴다', async (status) => {
    namespaceService.findById.mockResolvedValue({ status } as Awaited<ReturnType<NamespaceService['findById']>>);
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(controller.findCapabilities('namespace-id', response)).rejects.toBeInstanceOf(NamespaceNotFoundError);
    expect(capabilityService.listEnabled).not.toHaveBeenCalled();
  });
});
