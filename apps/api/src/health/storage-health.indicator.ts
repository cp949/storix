import { HeadBucketCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { STORAGE_BUCKET, STORAGE_CLIENT } from '../storage/storage.constants.js';

@Injectable()
export class StorageHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(STORAGE_BUCKET) private readonly bucket: string,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return indicator.up();
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return indicator.down(`bucket not found: ${this.bucket}`);
      }
      return indicator.down(error instanceof Error ? error.message : 'unknown error');
    }
  }
}
