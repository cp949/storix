import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAX_TCP_PORT, parseBoolean, parseOptionalString, parsePositiveInt } from '../common/env-parsing.js';
import { BLOB_STORAGE, STORAGE_BUCKET, STORAGE_CLIENT, STORAGE_PUBLIC_CLIENT } from './storage.constants.js';
import { S3BlobStorage } from './s3-blob-storage.js';
import { StorageKeyGenerator } from './storage-key-generator.js';

// IPv6 리터럴은 URL에서 대괄호가 필요하다.
function toEndpoint(host: string, port: number, useSsl: boolean): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${useSsl ? 'https' : 'http'}://${authority}:${port}`;
}

function buildClientConfig(config: ConfigService, endpoint: string): S3ClientConfig {
  return {
    endpoint,
    // SDK는 리전을 자동 조회하지 않는다. 백엔드가 리전을 지정해 운영되면(AWS S3 버킷 리전, VersityGW
    // --region) 같은 값을 STORIX_STORAGE_REGION에 설정해야 한다.
    region: parseOptionalString(config.get<string>('STORIX_STORAGE_REGION')) ?? 'us-east-1',
    credentials: {
      accessKeyId: config.getOrThrow<string>('STORIX_STORAGE_ACCESS_KEY'),
      secretAccessKey: config.getOrThrow<string>('STORIX_STORAGE_SECRET_KEY'),
    },
    forcePathStyle: parseBoolean(
      config.get<string>('STORIX_STORAGE_PATH_STYLE'),
      true,
      'STORIX_STORAGE_PATH_STYLE',
    ),
    // 업로드 stream은 재생할 수 없고, 저장 장애는 호출자가 분류해 응답한다. SDK 자동 재시도를 끈다.
    maxAttempts: 1,
    // 기본값(WHEN_SUPPORTED)은 요청에 CRC32 체크섬과 aws-chunked 인코딩을 붙인다.
    // 일부 S3 호환 백엔드가 이를 거부하므로 서비스가 요구할 때만 계산한다.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

export function buildS3ClientConfig(config: ConfigService): S3ClientConfig {
  const endpoint = toEndpoint(
    config.getOrThrow<string>('STORIX_STORAGE_ENDPOINT'),
    parsePositiveInt(config.get<string>('STORIX_STORAGE_PORT'), 9000, MAX_TCP_PORT),
    parseBoolean(config.get<string>('STORIX_STORAGE_USE_SSL'), false, 'STORIX_STORAGE_USE_SSL'),
  );
  return buildClientConfig(config, endpoint);
}

// presigned URL 서명은 서명 시점 Client의 host/port/scheme으로 만들어진다. 외부에서
// 접근 가능한 값(STORIX_STORAGE_PUBLIC_*)이 내부 통신용(STORIX_STORAGE_ENDPOINT 등)과 다를 수 있어
// 별도 Client로 분리한다(ADR-0013). STORIX_STORAGE_PUBLIC_ENDPOINT가 없으면 presigned 기능을
// 안 쓰는 배포로 보고 null을 반환한다 — S3BlobStorage.getPresignedUrl 호출 시점에
// 에러가 나며, 부팅 자체는 막지 않는다.
export function buildS3PublicClientConfig(config: ConfigService): S3ClientConfig | null {
  const host = parseOptionalString(config.get<string>('STORIX_STORAGE_PUBLIC_ENDPOINT'));
  if (!host) {
    return null;
  }
  const endpoint = toEndpoint(
    host,
    parsePositiveInt(config.get<string>('STORIX_STORAGE_PUBLIC_PORT'), 9000, MAX_TCP_PORT),
    parseBoolean(config.get<string>('STORIX_STORAGE_PUBLIC_USE_SSL'), false, 'STORIX_STORAGE_PUBLIC_USE_SSL'),
  );
  return buildClientConfig(config, endpoint);
}

@Module({
  providers: [
    {
      provide: STORAGE_CLIENT,
      useFactory: (config: ConfigService) => new S3Client(buildS3ClientConfig(config)),
      inject: [ConfigService],
    },
    {
      provide: STORAGE_PUBLIC_CLIENT,
      useFactory: (config: ConfigService) => {
        const clientConfig = buildS3PublicClientConfig(config);
        return clientConfig ? new S3Client(clientConfig) : null;
      },
      inject: [ConfigService],
    },
    {
      provide: STORAGE_BUCKET,
      useFactory: (config: ConfigService) => config.getOrThrow<string>('STORIX_STORAGE_BUCKET'),
      inject: [ConfigService],
    },
    {
      provide: BLOB_STORAGE,
      useFactory: (client: S3Client, bucket: string, publicClient: S3Client | null) =>
        new S3BlobStorage(client, bucket, publicClient),
      inject: [STORAGE_CLIENT, STORAGE_BUCKET, STORAGE_PUBLIC_CLIENT],
    },
    StorageKeyGenerator,
  ],
  exports: [STORAGE_CLIENT, STORAGE_BUCKET, BLOB_STORAGE, StorageKeyGenerator],
})
export class StorageModule {}
