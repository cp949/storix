import { GetObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';
import { VfsInvalidRangeError } from '../../src/storage/storage.errors.js';
import { createStubS3Client } from './s3-client.test-support.js';

function s3Exception(name: string): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: {}, message: 'private key' });
}

async function requestBody(request: unknown): Promise<Buffer> {
  const body = (request as { body?: unknown }).body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('S3BlobStorage', () => {
  it('SDK get 실패와 반환 stream 실패를 저장 장애로 분류한다', async () => {
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(s3Exception('NoSuchKey'))
      .mockResolvedValueOnce({
        Body: Readable.from(
          (async function* () {
            throw Object.assign(new Error('private endpoint'), { code: 'ECONNRESET' });
          })(),
        ),
      });
    const storage = new S3BlobStorage({ send } as unknown as S3Client, 'bucket', null);
    await expect(storage.get('key')).rejects.toMatchObject({ code: 'STORAGE_FAILURE', status: 500 });
    const result = await storage.get('key');
    await expect(async () => {
      for await (const chunk of result) void chunk;
    }).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

  it('upload source의 ECONNRESET은 SDK 저장 장애로 재분류하지 않는다', async () => {
    const sourceError = Object.assign(new Error('client disconnected'), { code: 'ECONNRESET' });
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('first');
        throw sourceError;
      })(),
    );
    const { client } = createStubS3Client(async (request) => {
      await requestBody(request);
      return { statusCode: 200 };
    });
    const storage = new S3BlobStorage(client, 'bucket', null);
    await expect(storage.put('key', source)).rejects.toBe(sourceError);
  });

  it('SDK put/delete 오류를 분류하고 미확인 오류는 원형 보존한다', async () => {
    const reset = Object.assign(new Error('private endpoint'), { code: 'ECONNREFUSED' });
    const unknown = new Error('unknown');
    const putStub = createStubS3Client(() => Promise.reject(reset));
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockRejectedValue(unknown);
    const storage = new S3BlobStorage(putStub.client, 'bucket', null);
    await expect(storage.put('key', Readable.from(Buffer.from('a')))).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    const deleting = new S3BlobStorage({ send } as unknown as S3Client, 'bucket', null);
    await expect(deleting.delete('key')).rejects.toBe(unknown);
  });

  it('멀티파트 업로드 중 파트 전송이 실패하면 AbortMultipartUpload로 미완성 파트를 정리한다', async () => {
    const uploadId = 'upload-1';
    const { client, requests } = createStubS3Client((request) => {
      const { method, query } = request as { method: string; query?: Record<string, string> };
      if (method === 'POST' && query && 'uploads' in query) {
        return {
          statusCode: 200,
          body: `<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>key</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        };
      }
      if (method === 'PUT' && query?.partNumber) {
        return { statusCode: 500, body: '<Error><Code>InternalError</Code><Message>fail</Message></Error>' };
      }
      return { statusCode: 204 };
    });
    const storage = new S3BlobStorage(client, 'bucket', null);
    // 16MiB 파트 크기를 넘겨 멀티파트 경로로 들어가게 한다.
    const source = Readable.from(
      (async function* () {
        for (let sent = 0; sent < 20; sent += 1) yield Buffer.alloc(1024 * 1024, 1);
      })(),
    );

    await expect(storage.put('key', source)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    const aborts = (requests as { method: string; query?: Record<string, string> }[]).filter(
      (request) => request.method === 'DELETE' && request.query?.uploadId === uploadId,
    );
    expect(aborts).toHaveLength(1);
  });

  it('range.end가 range.start보다 작으면 거부한다', async () => {
    const storage = new S3BlobStorage({} as S3Client, 'bucket', null);

    await expect(storage.get('key', { start: 5, end: 2 })).rejects.toThrow(VfsInvalidRangeError);
  });

  it('range.start가 음수면 거부한다', async () => {
    const storage = new S3BlobStorage({} as S3Client, 'bucket', null);

    await expect(storage.get('key', { start: -1, end: 2 })).rejects.toThrow(VfsInvalidRangeError);
  });

  it.each([
    [{ start: 2, end: 4 }, 'bytes=2-4'],
    [{ start: 7 }, 'bytes=7-'],
  ])('range %j는 Range 헤더 %s로 전달한다', async (range, header) => {
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValue({ Body: Readable.from([Buffer.from('x')]) });
    const storage = new S3BlobStorage({ send } as unknown as S3Client, 'bucket', null);

    await storage.get('key', range);

    const command = send.mock.calls[0][0] as GetObjectCommand;
    expect(command.input).toMatchObject({ Bucket: 'bucket', Key: 'key', Range: header });
  });

  it('빈 stream을 put하면 본문 없는 단일 PutObject로 생성한다', async () => {
    const { client, requests } = createStubS3Client(() => ({ statusCode: 200 }));
    const storage = new S3BlobStorage(client, 'bucket', null);

    await storage.put('key', Readable.from(Buffer.alloc(0)));

    expect(requests).toHaveLength(1);
    const request = requests[0] as { method: string; path: string; headers: Record<string, string> };
    expect(request.method).toBe('PUT');
    expect(request.path).toBe('/bucket/key');
    expect(request.headers['content-length']).toBe('0');
  });

  it('내용이 있는 stream을 put하면 내용을 그대로 보내고 Content-Type을 지정한다', async () => {
    const { client, requests } = createStubS3Client(() => ({ statusCode: 200 }));
    const storage = new S3BlobStorage(client, 'bucket', null);

    await storage.put('key', Readable.from(Buffer.from('hello')), 'text/plain');

    expect(requests).toHaveLength(1);
    const request = requests[0] as { headers: Record<string, string> };
    expect(request.headers['content-type']).toBe('text/plain');
    expect((await requestBody(requests[0])).toString()).toBe('hello');
  });

  it('contentType을 생략하면 application/octet-stream으로 저장한다', async () => {
    const { client, requests } = createStubS3Client(() => ({ statusCode: 200 }));
    const storage = new S3BlobStorage(client, 'bucket', null);

    await storage.put('key', Readable.from(Buffer.from('x')));

    expect((requests[0] as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/octet-stream',
    );
  });

  describe('getPresignedUrl', () => {
    const presignClient = new S3Client({
      endpoint: 'https://public.example.com',
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      forcePathStyle: true,
    });

    it('presign 클라이언트가 없으면 에러를 던진다', async () => {
      const storage = new S3BlobStorage({} as S3Client, 'bucket', null);

      await expect(storage.getPresignedUrl('key', 300)).rejects.toThrow(
        'STORIX_STORAGE_PUBLIC_ENDPOINT가 설정되지 않아 presigned URL을 발급할 수 없음',
      );
    });

    it('공개 endpoint·bucket·key·만료시간으로 서명한 URL을 발급한다', async () => {
      const storage = new S3BlobStorage({} as S3Client, 'bucket', presignClient);

      const url = new URL(await storage.getPresignedUrl('key', 300));

      expect(url.origin).toBe('https://public.example.com');
      expect(url.pathname).toBe('/bucket/key');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
      expect(url.searchParams.has('response-content-disposition')).toBe(false);
    });

    it('contentDisposition을 넘기면 response-content-disposition으로 서명에 포함한다', async () => {
      const storage = new S3BlobStorage({} as S3Client, 'bucket', presignClient);

      const url = new URL(await storage.getPresignedUrl('key', 300, 'attachment; filename="a.txt"'));

      expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="a.txt"');
    });

    it('contentType을 넘기면 response-content-type으로 서명에 포함한다', async () => {
      const storage = new S3BlobStorage({} as S3Client, 'bucket', presignClient);

      const url = new URL(await storage.getPresignedUrl('key', 300, undefined, 'application/pdf'));

      expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
      expect(url.searchParams.has('response-content-disposition')).toBe(false);
    });

    it('contentType을 넘기지 않으면 response-content-type을 서명하지 않는다', async () => {
      const storage = new S3BlobStorage({} as S3Client, 'bucket', presignClient);

      const url = new URL(await storage.getPresignedUrl('key', 300));

      expect(url.searchParams.has('response-content-type')).toBe(false);
    });
  });
});
