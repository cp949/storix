import { HeadBucketCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { STORAGE_BUCKET, STORAGE_CLIENT } from '../storage/storage.constants.js';

// 컨테이너 healthcheck(timeout 5초)가 중단하기 전에 503을 돌려주도록 그보다 짧게 잡는다.
export const STORAGE_CHECK_TIMEOUT_MS = 3000;

@Injectable()
export class StorageHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(STORAGE_BUCKET) private readonly bucket: string,
  ) {}

  // 응답하지 않는 스토리지가 공개 엔드포인트 요청과 공유 소켓 풀을 붙잡지 않도록 요청 자체를 취소한다.
  async check(key: string, timeoutMs: number = STORAGE_CHECK_TIMEOUT_MS): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const abortSignal = AbortSignal.timeout(timeoutMs);

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal });
      return indicator.up();
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return indicator.down(`bucket not found: ${this.bucket}`);
      }
      if (abortSignal.aborted) {
        return indicator.down(`storage check timed out after ${timeoutMs}ms`);
      }
      return indicator.down(error instanceof Error ? error.message : 'unknown error');
    }
  }
}
