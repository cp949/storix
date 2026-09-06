import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { Client } from 'minio';
import { MINIO_BUCKET, MINIO_CLIENT } from '../storage/storage.constants.js';

@Injectable()
export class MinioHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(MINIO_CLIENT) private readonly client: Client,
    @Inject(MINIO_BUCKET) private readonly bucket: string,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        return indicator.down(`bucket not found: ${this.bucket}`);
      }
      return indicator.up();
    } catch (error) {
      return indicator.down(error instanceof Error ? error.message : 'unknown error');
    }
  }
}
