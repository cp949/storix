import { ConfigService } from '@nestjs/config';
import { buildS3ClientConfig, buildS3PublicClientConfig } from '../../src/storage/storage.module.js';

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
  STORIX_STORAGE_ENDPOINT: 'localhost',
  STORIX_STORAGE_ACCESS_KEY: 'storix',
  STORIX_STORAGE_SECRET_KEY: 'storix-secret',
};

describe('buildS3ClientConfig', () => {
  it('endpoint를 scheme·host·port로 조립한다', () => {
    expect(buildS3ClientConfig(stubConfig(REQUIRED)).endpoint).toBe('http://localhost:9000');
    expect(
      buildS3ClientConfig(
        stubConfig({ ...REQUIRED, STORIX_STORAGE_PORT: '443', STORIX_STORAGE_USE_SSL: 'true' }),
      ).endpoint,
    ).toBe('https://localhost:443');
  });

  it('IPv6 host는 대괄호로 감싼다', () => {
    const config = buildS3ClientConfig(stubConfig({ ...REQUIRED, STORIX_STORAGE_ENDPOINT: '::1' }));

    expect(config.endpoint).toBe('http://[::1]:9000');
  });

  it('자격증명을 accessKeyId/secretAccessKey로 전달한다', () => {
    expect(buildS3ClientConfig(stubConfig(REQUIRED)).credentials).toEqual({
      accessKeyId: 'storix',
      secretAccessKey: 'storix-secret',
    });
  });

  it('STORIX_STORAGE_PATH_STYLE이 없으면 forcePathStyle 기본값 true를 사용한다', () => {
    expect(buildS3ClientConfig(stubConfig(REQUIRED)).forcePathStyle).toBe(true);
  });

  it('STORIX_STORAGE_PATH_STYLE=false면 forcePathStyle을 false로 설정한다', () => {
    expect(
      buildS3ClientConfig(stubConfig({ ...REQUIRED, STORIX_STORAGE_PATH_STYLE: 'false' })).forcePathStyle,
    ).toBe(false);
  });

  it.each(['STORIX_STORAGE_USE_SSL', 'STORIX_STORAGE_PATH_STYLE'])(
    '%s가 true·false가 아니면 설정 해석을 거부한다',
    (name) => {
      expect(() => buildS3ClientConfig(stubConfig({ ...REQUIRED, [name]: 'yes' }))).toThrow(`${name}=yes`);
    },
  );

  it('STORIX_STORAGE_REGION이 없으면 us-east-1을 사용한다', () => {
    expect(buildS3ClientConfig(stubConfig(REQUIRED)).region).toBe('us-east-1');
  });

  it('STORIX_STORAGE_REGION이 있으면 그대로 region에 반영한다', () => {
    expect(
      buildS3ClientConfig(stubConfig({ ...REQUIRED, STORIX_STORAGE_REGION: 'ap-northeast-2' })).region,
    ).toBe('ap-northeast-2');
  });

  it('timeout 환경변수가 없으면 socketTimeout 120초, connectionTimeout 10초를 쓴다', () => {
    expect(buildS3ClientConfig(stubConfig(REQUIRED)).requestHandler).toEqual({
      socketTimeout: 120_000,
      connectionTimeout: 10_000,
    });
  });

  it('STORIX_STORAGE_SOCKET_TIMEOUT_MS·STORIX_STORAGE_CONNECT_TIMEOUT_MS를 그대로 반영한다', () => {
    const config = buildS3ClientConfig(
      stubConfig({
        ...REQUIRED,
        STORIX_STORAGE_SOCKET_TIMEOUT_MS: '30000',
        STORIX_STORAGE_CONNECT_TIMEOUT_MS: '2500',
      }),
    );

    expect(config.requestHandler).toEqual({ socketTimeout: 30_000, connectionTimeout: 2_500 });
  });

  it('timeout 환경변수가 빈 문자열이면 기본값을 쓴다', () => {
    const config = buildS3ClientConfig(
      stubConfig({
        ...REQUIRED,
        STORIX_STORAGE_SOCKET_TIMEOUT_MS: '',
        STORIX_STORAGE_CONNECT_TIMEOUT_MS: '',
      }),
    );

    expect(config.requestHandler).toEqual({ socketTimeout: 120_000, connectionTimeout: 10_000 });
  });

  // 0은 무제한이라 무기한 대기를 되살린다. 2147483647 초과는 Node 타이머가 1ms로 줄여 즉시 끊는다.
  it.each(['STORIX_STORAGE_SOCKET_TIMEOUT_MS', 'STORIX_STORAGE_CONNECT_TIMEOUT_MS'])(
    '%s가 0·음수·비정수·타이머 상한 초과면 설정 해석을 거부한다',
    (name) => {
      for (const value of ['0', '-1', '1.5', 'abc', '2147483648']) {
        expect(() => buildS3ClientConfig(stubConfig({ ...REQUIRED, [name]: value }))).toThrow();
      }
      expect(() => buildS3ClientConfig(stubConfig({ ...REQUIRED, [name]: '2147483647' }))).not.toThrow();
    },
  );

  it('SDK 자동 재시도를 끄고 체크섬을 필요할 때만 계산한다', () => {
    const config = buildS3ClientConfig(stubConfig(REQUIRED));

    expect(config.maxAttempts).toBe(1);
    expect(config.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(config.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });
});

describe('buildS3PublicClientConfig', () => {
  it('STORIX_STORAGE_PUBLIC_USE_SSL이 true·false가 아니면 설정 해석을 거부한다', () => {
    expect(() =>
      buildS3PublicClientConfig(
        stubConfig({
          ...REQUIRED,
          STORIX_STORAGE_PUBLIC_ENDPOINT: 'storage.example.com',
          STORIX_STORAGE_PUBLIC_USE_SSL: '1',
        }),
      ),
    ).toThrow('STORIX_STORAGE_PUBLIC_USE_SSL=1');
  });

  it('STORIX_STORAGE_PUBLIC_ENDPOINT가 없으면 null을 반환한다', () => {
    expect(buildS3PublicClientConfig(stubConfig(REQUIRED))).toBeNull();
  });

  it('STORIX_STORAGE_PUBLIC_ENDPOINT가 있으면 port/SSL 기본값과 함께 endpoint를 조립한다', () => {
    const config = buildS3PublicClientConfig(
      stubConfig({ ...REQUIRED, STORIX_STORAGE_PUBLIC_ENDPOINT: 'storage.example.com' }),
    );

    expect(config?.endpoint).toBe('http://storage.example.com:9000');
  });

  it('STORIX_STORAGE_PUBLIC_PORT/STORIX_STORAGE_PUBLIC_USE_SSL을 지정하면 그대로 반영한다', () => {
    const config = buildS3PublicClientConfig(
      stubConfig({
        ...REQUIRED,
        STORIX_STORAGE_PUBLIC_ENDPOINT: 'storage.example.com',
        STORIX_STORAGE_PUBLIC_PORT: '443',
        STORIX_STORAGE_PUBLIC_USE_SSL: 'true',
      }),
    );

    expect(config?.endpoint).toBe('https://storage.example.com:443');
  });

  it('timeout은 내부 설정을 그대로 재사용한다', () => {
    const config = buildS3PublicClientConfig(
      stubConfig({
        ...REQUIRED,
        STORIX_STORAGE_PUBLIC_ENDPOINT: 'storage.example.com',
        STORIX_STORAGE_SOCKET_TIMEOUT_MS: '30000',
      }),
    );

    expect(config?.requestHandler).toEqual({ socketTimeout: 30_000, connectionTimeout: 10_000 });
  });

  it('path style·region·자격증명은 내부 설정을 그대로 재사용한다', () => {
    const config = buildS3PublicClientConfig(
      stubConfig({
        ...REQUIRED,
        STORIX_STORAGE_PUBLIC_ENDPOINT: 'storage.example.com',
        STORIX_STORAGE_PATH_STYLE: 'false',
        STORIX_STORAGE_REGION: 'ap-northeast-2',
      }),
    );

    expect(config?.forcePathStyle).toBe(false);
    expect(config?.region).toBe('ap-northeast-2');
    expect(config?.credentials).toEqual({ accessKeyId: 'storix', secretAccessKey: 'storix-secret' });
  });
});
