import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAX_TCP_PORT, parseBoolean, parseOptionalString, parsePositiveInt } from '../common/env-parsing.js';
import { BLOB_STORAGE, STORAGE_BUCKET, STORAGE_CLIENT, STORAGE_PUBLIC_CLIENT } from './storage.constants.js';
import { S3BlobStorage } from './s3-blob-storage.js';
import { StorageKeyGenerator } from './storage-key-generator.js';

// 응답이 멈춘 소켓이 무기한 남지 않게 하는 상한이다. socketTimeout은 소켓 무활동 시간이라 정상 전송은 끊지 않고,
// 큰 object의 CompleteMultipartUpload처럼 서버가 응답 전에 오래 걸리는 호출을 오탐하지 않도록 넉넉히 잡는다.
const DEFAULT_SOCKET_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// SDK 기본값과 같다. 진행 중인 요청마다 소켓 하나를 쓰고, 장기 다운로드는 클라이언트가 다 받을 때까지 점유한다.
// 상한에 닿으면 다음 요청은 대기열에서 connectionTimeout 뒤 TimeoutError(503)로 끝난다.
const DEFAULT_MAX_SOCKETS = 50;
// Node 타이머는 2^31-1ms를 넘으면 1ms로 줄여 즉시 발화하므로 그 값까지만 받는다.
const MAX_TIMEOUT_MS = 2_147_483_647;

// IPv6 리터럴은 URL에서 대괄호가 필요하다.
function toEndpoint(host: string, port: number, useSsl: boolean): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${useSsl ? 'https' : 'http'}://${authority}:${port}`;
}

function buildClientConfig(config: ConfigService, endpoint: string): S3ClientConfig {
  const agent = {
    // 한 목적지에 대한 연결 수는 TCP 포트 수를 넘을 수 없다.
    maxSockets: parsePositiveInt(
      config.get<string>('STORIX_STORAGE_MAX_SOCKETS'),
      DEFAULT_MAX_SOCKETS,
      MAX_TCP_PORT,
    ),
  };
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
    // 요청 전체 시간(requestTimeout)은 대용량 전송을 끊고 본문 도중 정지도 못 잡아 쓰지 않는다.
    requestHandler: {
      socketTimeout: parsePositiveInt(
        config.get<string>('STORIX_STORAGE_SOCKET_TIMEOUT_MS'),
        DEFAULT_SOCKET_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
      connectionTimeout: parsePositiveInt(
        config.get<string>('STORIX_STORAGE_CONNECT_TIMEOUT_MS'),
        DEFAULT_CONNECT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
      // 객체로 주면 SDK가 keepAlive를 유지한 채 이 값만 덮어쓴 Agent를 만든다.
      httpAgent: agent,
      httpsAgent: agent,
    },
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
