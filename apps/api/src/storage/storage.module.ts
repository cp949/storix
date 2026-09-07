import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientOptions } from 'minio';
import { Client } from 'minio';
import { parseBoolean, parseOptionalString, parsePositiveInt } from '../common/env-parsing.js';
import { BLOB_STORAGE, MINIO_BUCKET, MINIO_CLIENT, MINIO_PUBLIC_CLIENT } from './storage.constants.js';
import { MinioBlobStorage } from './minio-blob-storage.js';
import { StorageKeyGenerator } from './storage-key-generator.js';

export function buildMinioClientOptions(config: ConfigService): ClientOptions {
  return {
    endPoint: config.getOrThrow<string>('MINIO_ENDPOINT'),
    port: parsePositiveInt(config.get<string>('MINIO_PORT'), 9000),
    useSSL: parseBoolean(config.get<string>('MINIO_USE_SSL'), false),
    accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
    secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
    // S3/VersityGW 등 MinIO 외 백엔드를 겨냥할 때만 조정한다. 기본값(true/미설정)은
    // 번들 MinIO 대상 기존 동작과 동일하다.
    pathStyle: parseBoolean(config.get<string>('MINIO_PATH_STYLE'), true),
    region: parseOptionalString(config.get<string>('MINIO_REGION')),
    // minio-js는 putObject에 size를 넘기지 않으면(스트리밍 업로드) 내부적으로
    // size를 maxObjectSize(5TiB)로 간주해 파트 크기를 수백MB 단위로 계산한다.
    // 그 결과 실제 파일이 계산된 파트 크기보다 작으면 파트 하나에 파일 전체가
    // 담겨 업로드 전에 WAS 메모리에 통째로 버퍼링된다. partSize를 고정하면
    // overRidePartSize가 켜져 이 크기 추정 로직을 건너뛰고 항상 이 값을 파트
    // 크기로 사용하므로, 총 크기를 모르는 업로드도 실제로 스트리밍된다.
    partSize: 16 * 1024 * 1024,
  };
}

// presigned URL 서명은 서명 시점 Client의 host/port/scheme으로 만들어진다. 외부에서
// 접근 가능한 값(MINIO_PUBLIC_*)이 내부 통신용(MINIO_ENDPOINT 등)과 다를 수 있어
// 별도 Client로 분리한다(ADR-0013). MINIO_PUBLIC_ENDPOINT가 없으면 presigned 기능을
// 안 쓰는 배포로 보고 null을 반환한다 — MinioBlobStorage.getPresignedUrl 호출 시점에
// 에러가 나며, 부팅 자체는 막지 않는다.
export function buildMinioPublicClientOptions(config: ConfigService): ClientOptions | null {
  const endPoint = parseOptionalString(config.get<string>('MINIO_PUBLIC_ENDPOINT'));
  if (!endPoint) {
    return null;
  }

  return {
    endPoint,
    port: parsePositiveInt(config.get<string>('MINIO_PUBLIC_PORT'), 9000),
    useSSL: parseBoolean(config.get<string>('MINIO_PUBLIC_USE_SSL'), false),
    accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
    secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
    pathStyle: parseBoolean(config.get<string>('MINIO_PATH_STYLE'), true),
    region: parseOptionalString(config.get<string>('MINIO_REGION')),
  };
}

@Module({
  providers: [
    {
      provide: MINIO_CLIENT,
      useFactory: (config: ConfigService) => new Client(buildMinioClientOptions(config)),
      inject: [ConfigService],
    },
    {
      provide: MINIO_PUBLIC_CLIENT,
      useFactory: (config: ConfigService) => {
        const options = buildMinioPublicClientOptions(config);
        return options ? new Client(options) : null;
      },
      inject: [ConfigService],
    },
    {
      provide: MINIO_BUCKET,
      useFactory: (config: ConfigService) => config.getOrThrow<string>('MINIO_BUCKET'),
      inject: [ConfigService],
    },
    {
      provide: BLOB_STORAGE,
      useFactory: (client: Client, bucket: string, publicClient: Client | null) =>
        new MinioBlobStorage(client, bucket, publicClient),
      inject: [MINIO_CLIENT, MINIO_BUCKET, MINIO_PUBLIC_CLIENT],
    },
    StorageKeyGenerator,
  ],
  exports: [MINIO_CLIENT, MINIO_BUCKET, BLOB_STORAGE, StorageKeyGenerator],
})
export class StorageModule {}
