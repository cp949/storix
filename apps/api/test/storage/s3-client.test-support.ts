import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

interface S3ServerAccess {
  getHost(): string;
  getPort(): number;
  getUsername(): string;
  getPassword(): string;
}

// 통합 테스트용 S3Client. 운영 설정(buildS3ClientConfig)과 같은 체크섬·재시도 옵션을 쓴다.
export function createTestS3Client(server: S3ServerAccess): S3Client {
  return new S3Client({
    endpoint: `http://${server.getHost()}:${server.getPort()}`,
    region: 'us-east-1',
    credentials: { accessKeyId: server.getUsername(), secretAccessKey: server.getPassword() },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function createTestBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

export async function readTestObject(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface StubResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

// 네트워크 없이 SDK 요청 파이프라인을 통과시키는 단위 테스트용 클라이언트.
// handle이 던진 오류는 SDK가 재시도 없이 그대로 전파한다.
export function createStubS3Client(handle: (request: unknown) => Promise<StubResponse> | StubResponse): {
  client: S3Client;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const client = new S3Client({
    endpoint: 'http://stub.invalid:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      metadata: { handlerProtocol: 'http/1.1' },
      destroy: () => undefined,
      handle: async (request: unknown) => {
        requests.push(request);
        const { statusCode, headers = {}, body = '' } = await handle(request);
        return { response: { statusCode, headers, body: Readable.from([Buffer.from(body)]) } };
      },
    } as never,
  });
  return { client, requests };
}

// commandType 명령만 outcomes로 대체한다(Error는 거절, 그 밖의 값은 응답). 다른 명령이나 outcomes를
// 모두 소비한 뒤의 호출은 원본으로 위임한다. 해제는 반환된 spy의 mockRestore()로 한다.
export function interceptCommand(
  client: S3Client,
  commandType: abstract new (...args: never[]) => unknown,
  ...outcomes: Array<Error | Record<string, unknown>>
) {
  const original = client.send.bind(client) as (command: unknown) => Promise<unknown>;
  const queue = [...outcomes];
  return jest.spyOn(client, 'send').mockImplementation(((command: unknown) => {
    if (command instanceof commandType && queue.length > 0) {
      const outcome = queue.shift() as Error | Record<string, unknown>;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    }
    return original(command);
  }) as never);
}

// GetObject 응답 본문을 source로 대체한다.
export function getObjectResult(source: Readable): Record<string, unknown> {
  return { Body: source };
}
