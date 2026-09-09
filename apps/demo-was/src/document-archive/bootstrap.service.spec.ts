import { jest } from '@jest/globals';
import { BootstrapService } from './bootstrap.service.js';
import { StorixClient } from '../storix-client/storix-client.service.js';

describe('BootstrapService', () => {
  it('onModuleInit에서 두 namespace를 순서대로 확보한다', async () => {
    const calls: string[] = [];
    const storixClient = {
      ensureDemoNamespace: jest.fn(async () => {
        calls.push('demo');
        return 'ns-private-id';
      }),
      ensurePublicNamespace: jest.fn(async () => {
        calls.push('public');
        return 'ns-public-id';
      }),
    } as unknown as StorixClient;

    const service = new BootstrapService(storixClient);
    await service.onModuleInit();

    expect(calls).toEqual(['demo', 'public']);
  });

  it('namespace 확보가 실패하면 그대로 예외를 전파한다', async () => {
    const storixClient = {
      ensureDemoNamespace: jest.fn<StorixClient['ensureDemoNamespace']>().mockRejectedValue(new Error('부팅 실패')),
      ensurePublicNamespace: jest.fn<StorixClient['ensurePublicNamespace']>(),
    } as unknown as StorixClient;

    const service = new BootstrapService(storixClient);
    await expect(service.onModuleInit()).rejects.toThrow('부팅 실패');
    expect(storixClient.ensurePublicNamespace).not.toHaveBeenCalled();
  });
});
