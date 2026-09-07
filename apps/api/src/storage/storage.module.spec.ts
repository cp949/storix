import { ConfigService } from '@nestjs/config';
import { buildMinioClientOptions } from './storage.module.js';

function stubConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`missing required env: ${key}`);
      }
      return value;
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const REQUIRED = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_ACCESS_KEY: 'storix',
  MINIO_SECRET_KEY: 'storix-secret',
};

describe('buildMinioClientOptions', () => {
  it('MINIO_PATH_STYLE이 없으면 pathStyle 기본값 true를 사용한다', () => {
    const options = buildMinioClientOptions(stubConfig(REQUIRED));

    expect(options.pathStyle).toBe(true);
  });

  it('MINIO_PATH_STYLE=false면 pathStyle을 false로 설정한다', () => {
    const options = buildMinioClientOptions(stubConfig({ ...REQUIRED, MINIO_PATH_STYLE: 'false' }));

    expect(options.pathStyle).toBe(false);
  });

  it('MINIO_REGION이 없으면 region을 설정하지 않는다', () => {
    const options = buildMinioClientOptions(stubConfig(REQUIRED));

    expect(options.region).toBeUndefined();
  });

  it('MINIO_REGION이 있으면 그대로 region에 반영한다', () => {
    const options = buildMinioClientOptions(stubConfig({ ...REQUIRED, MINIO_REGION: 'us-east-1' }));

    expect(options.region).toBe('us-east-1');
  });
});
