import { ConfigService } from '@nestjs/config';
import { buildMinioClientOptions, buildMinioPublicClientOptions } from './storage.module.js';

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

describe('buildMinioPublicClientOptions', () => {
  it('MINIO_PUBLIC_ENDPOINT가 없으면 null을 반환한다', () => {
    const options = buildMinioPublicClientOptions(stubConfig(REQUIRED));

    expect(options).toBeNull();
  });

  it('MINIO_PUBLIC_ENDPOINT가 있으면 port/useSSL 기본값과 함께 옵션을 반환한다', () => {
    const options = buildMinioPublicClientOptions(
      stubConfig({ ...REQUIRED, MINIO_PUBLIC_ENDPOINT: 'storage.example.com' }),
    );

    expect(options?.endPoint).toBe('storage.example.com');
    expect(options?.port).toBe(9000);
    expect(options?.useSSL).toBe(false);
  });

  it('MINIO_PUBLIC_PORT/MINIO_PUBLIC_USE_SSL을 지정하면 그대로 반영한다', () => {
    const options = buildMinioPublicClientOptions(
      stubConfig({
        ...REQUIRED,
        MINIO_PUBLIC_ENDPOINT: 'storage.example.com',
        MINIO_PUBLIC_PORT: '443',
        MINIO_PUBLIC_USE_SSL: 'true',
      }),
    );

    expect(options?.port).toBe(443);
    expect(options?.useSSL).toBe(true);
  });

  it('MINIO_PATH_STYLE/MINIO_REGION은 내부 설정을 그대로 재사용한다', () => {
    const options = buildMinioPublicClientOptions(
      stubConfig({
        ...REQUIRED,
        MINIO_PUBLIC_ENDPOINT: 'storage.example.com',
        MINIO_PATH_STYLE: 'false',
        MINIO_REGION: 'us-east-1',
      }),
    );

    expect(options?.pathStyle).toBe(false);
    expect(options?.region).toBe('us-east-1');
  });
});
