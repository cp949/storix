import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { HealthIndicatorService } from '@nestjs/terminus';
import { jest } from '@jest/globals';
import {
  STORAGE_CHECK_TIMEOUT_MS,
  StorageHealthIndicator,
} from '../../src/health/storage-health.indicator.js';

type SendFn = (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
type SendMock = jest.Mock<SendFn>;

function indicatorWith(send: SendMock): StorageHealthIndicator {
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

  it('스토리지가 응답하지 않으면 timeout 안에 요청을 취소하고 down을 반환한다', async () => {
    let aborted = false;
    const send: SendMock = jest.fn<SendFn>().mockImplementation(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const started = Date.now();
    const result = await indicatorWith(send).check('storage', 30);

    expect(result).toEqual({ storage: { status: 'down', message: 'storage check timed out after 30ms' } });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('기본 timeout은 컨테이너 healthcheck(5초)보다 짧다', () => {
    expect(STORAGE_CHECK_TIMEOUT_MS).toBe(3000);
  });
});
