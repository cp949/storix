import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';
import { buildS3ClientConfig } from '../../src/storage/storage.module.js';

// 실제 소켓으로 응답이 멈추는 상황을 만든다. 운영 설정 경로(buildS3ClientConfig)를 거쳐 timeout을 짧게 준다.
const SOCKET_TIMEOUT_MS = 300;

function configFor(port: number): ConfigService {
  const values: Record<string, string> = {
    STORIX_STORAGE_ENDPOINT: '127.0.0.1',
    STORIX_STORAGE_PORT: String(port),
    STORIX_STORAGE_ACCESS_KEY: 'storix',
    STORIX_STORAGE_SECRET_KEY: 'storix-secret',
    STORIX_STORAGE_SOCKET_TIMEOUT_MS: String(SOCKET_TIMEOUT_MS),
  };
  return {
    getOrThrow: (key: string) => values[key],
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('S3BlobStorage 응답 정지 timeout', () => {
  let server: Server;
  let client: S3Client;
  let storage: S3BlobStorage;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // 헤더 전 정지: 응답을 보내지 않는다.
      if (req.url?.includes('no-header')) return;
      // 본문 중 정지: 헤더와 일부 본문만 보내고 멈춘다.
      res.writeHead(200, { 'content-length': '1000' });
      res.write('x'.repeat(10));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = new S3Client(buildS3ClientConfig(configFor((server.address() as AddressInfo).port)));
    storage = new S3BlobStorage(client, 'bucket', null);
  });

  afterAll(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('응답 헤더가 오기 전에 멈추면 socketTimeout 안에 503 저장 장애로 끝난다', async () => {
    const startedAt = Date.now();

    await expect(storage.get('no-header')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
    expect(Date.now() - startedAt).toBeLessThan(SOCKET_TIMEOUT_MS * 5);
  });

  // jest ESM(VM)에서는 Node 코어가 만든 오류가 `instanceof Error`가 아니라 분류기가 거르지 못한다. 여기서는
  // socketTimeout이 stream을 끝내는지만 확인하고, ECONNRESET의 503 분류는 storage-failure.spec이 다룬다.
  it('응답 본문 도중 멈추면 socketTimeout 안에 stream이 ECONNRESET으로 끝난다', async () => {
    const startedAt = Date.now();
    const stream = await storage.get('mid-body');

    await expect(
      (async () => {
        for await (const chunk of stream) void chunk;
      })(),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(Date.now() - startedAt).toBeLessThan(SOCKET_TIMEOUT_MS * 5);
  });
});
