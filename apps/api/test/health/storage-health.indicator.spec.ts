import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { HealthIndicatorService } from '@nestjs/terminus';
import { jest } from '@jest/globals';
import { StorageHealthIndicator } from '../../src/health/storage-health.indicator.js';

function indicatorWith(send: jest.Mock<(command: unknown) => Promise<unknown>>): StorageHealthIndicator {
  const healthIndicatorService = {
    check: () => ({
      up: () => ({ storage: { status: 'up' } }),
      down: (message: unknown) => ({ storage: { status: 'down', message } }),
    }),
  } as unknown as HealthIndicatorService;
  return new StorageHealthIndicator(healthIndicatorService, { send } as unknown as S3Client, 'bucket');
}

describe('StorageHealthIndicator', () => {
  it('버킷에 접근할 수 있으면 up이다', async () => {
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({});

    await expect(indicatorWith(send).check('storage')).resolves.toEqual({ storage: { status: 'up' } });
  });

  it('버킷이 없으면(404) down과 버킷 이름을 반환한다', async () => {
    const notFound = new S3ServiceException({
      name: 'NotFound',
      $fault: 'client',
      $metadata: { httpStatusCode: 404 },
      message: 'private',
    });
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockRejectedValue(notFound);

    await expect(indicatorWith(send).check('storage')).resolves.toEqual({
      storage: { status: 'down', message: 'bucket not found: bucket' },
    });
  });

  it('그 밖의 오류는 오류 메시지와 함께 down이다', async () => {
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockRejectedValue(new Error('connect failed'));

    await expect(indicatorWith(send).check('storage')).resolves.toEqual({
      storage: { status: 'down', message: 'connect failed' },
    });
  });
});
