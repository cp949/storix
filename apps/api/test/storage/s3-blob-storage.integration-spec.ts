import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { startS3Container, StartedS3Container } from './s3-container.test-support.js';
import { createTestBucket, createTestS3Client } from './s3-client.test-support.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';

describe('S3BlobStorage', () => {
  let container: StartedS3Container;
  let client: S3Client;
  let storage: S3BlobStorage;
  const bucket = 'storix-test';

  beforeAll(async () => {
    container = await startS3Container();
    client = createTestS3Client(container);
    await createTestBucket(client, bucket);
    storage = new S3BlobStorage(client, bucket, client);
  }, 120000);

  afterAll(async () => {
    await container.stop();
  });

  it('put한 content를 get으로 그대로 읽는다', async () => {
    const key = 'blobs/ab/test-1';
    await storage.put(key, Readable.from(Buffer.from('hello storix')));

    const stream = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe('hello storix');
  });

  it('range를 지정하면 해당 byte 구간만 읽는다', async () => {
    const key = 'blobs/ab/test-range';
    await storage.put(key, Readable.from(Buffer.from('0123456789')));

    const stream = await storage.get(key, { start: 2, end: 4 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe('234');
  });

  it('delete한 object는 더 이상 조회되지 않는다', async () => {
    const key = 'blobs/ab/test-delete';
    await storage.put(key, Readable.from(Buffer.from('to be deleted')));

    await storage.delete(key);

    await expect(storage.get(key)).rejects.toThrow();
  });

  it('list는 prefix에 해당하는 key와 lastModified를 모두 반환한다', async () => {
    const prefix = 'blobs/list-test/';
    const before = new Date(Date.now() - 1000);
    await storage.put(`${prefix}one`, Readable.from(Buffer.from('1')));
    await storage.put(`${prefix}two`, Readable.from(Buffer.from('2')));

    const items: { key: string; lastModified: Date }[] = [];
    for await (const item of storage.list(prefix)) items.push(item);

    expect(items.map((item) => item.key).sort()).toEqual([`${prefix}one`, `${prefix}two`]);
    for (const item of items) {
      expect(item.lastModified.getTime()).toBeGreaterThanOrEqual(before.getTime());
    }
  });

  it('listPage는 key 오름차순으로 limit개씩 startAfter 뒤에서 이어 읽고 끝에서 nextAfter가 null이다', async () => {
    const prefix = 'blobs/list-page/';
    for (const name of ['d', 'a', 'c', 'e', 'b']) {
      await storage.put(`${prefix}${name}`, Readable.from(Buffer.from(name)));
    }
    await storage.put('blobs/list-page-other/z', Readable.from(Buffer.from('z')));

    const first = await storage.listPage(prefix, { limit: 2 });
    expect(first.items.map((item) => item.key)).toEqual([`${prefix}a`, `${prefix}b`]);
    expect(first.nextAfter).toBe(`${prefix}b`);

    const second = await storage.listPage(prefix, { limit: 2, startAfter: first.nextAfter! });
    expect(second.items.map((item) => item.key)).toEqual([`${prefix}c`, `${prefix}d`]);
    expect(second.nextAfter).toBe(`${prefix}d`);

    const last = await storage.listPage(prefix, { limit: 2, startAfter: second.nextAfter! });
    expect(last.items.map((item) => item.key)).toEqual([`${prefix}e`]);
    expect(last.nextAfter).toBeNull();
    expect(last.items[0].lastModified).toBeInstanceOf(Date);
  });

  it('listPage는 limit이 SDK 한 page(1000)를 넘으면 거부한다', async () => {
    await expect(storage.listPage('blobs/', { limit: 1001 })).rejects.toThrow(/limit/);
    await expect(storage.listPage('blobs/', { limit: 0 })).rejects.toThrow(/limit/);
  });

  it('0-byte content를 put하면 0-byte object가 생성된다', async () => {
    const key = 'blobs/ab/test-empty';
    await storage.put(key, Readable.from(Buffer.alloc(0)));

    const stream = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).length).toBe(0);
  });

  it('presigned URL로 실제 콘텐츠를 직접 받을 수 있다', async () => {
    const key = 'blobs/ab/test-presigned';
    await storage.put(key, Readable.from(Buffer.from('presigned content')));

    const url = await storage.getPresignedUrl(key, 300);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('presigned content');
  });

  it('contentDisposition을 넘기면 응답 헤더에 그대로 반영된다', async () => {
    const key = 'blobs/ab/test-presigned-disposition';
    await storage.put(key, Readable.from(Buffer.from('with filename')));

    const url = await storage.getPresignedUrl(key, 300, 'attachment; filename="report.txt"');
    const response = await fetch(url);

    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.txt"');
  });

  it('contentType을 넘기면 저장된 ContentType 대신 응답 헤더에 반영된다', async () => {
    const key = 'blobs/ab/test-presigned-content-type';
    await storage.put(key, Readable.from(Buffer.from('typed')), 'text/plain');

    const url = await storage.getPresignedUrl(key, 300, undefined, 'application/pdf');
    const response = await fetch(url);

    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  it('presignedClient가 없으면 에러를 던진다', async () => {
    const storageWithoutPublicClient = new S3BlobStorage(client, bucket, null);

    await expect(storageWithoutPublicClient.getPresignedUrl('any-key', 300)).rejects.toThrow(
      'STORIX_STORAGE_PUBLIC_ENDPOINT가 설정되지 않아 presigned URL을 발급할 수 없음',
    );
  });

  it('여러 파트로 나뉘는 크기 미지정 stream을 업로드하고 그대로 읽는다', async () => {
    const key = 'blobs/ab/test-multipart';
    const total = 40 * 1024 * 1024; // 16MiB 파트 3개
    const source = Readable.from(
      (async function* () {
        for (let sent = 0; sent < total; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024, 1);
      })(),
    );

    await storage.put(key, source);

    let size = 0;
    for await (const chunk of await storage.get(key)) size += (chunk as Buffer).length;
    expect(size).toBe(total);
  }, 60000);

  it('대용량 stream 업로드 중 버퍼 메모리가 파일 크기와 무관하게 파트 크기 안팎에 머문다', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    // 업로드 경로(SDK 모듈 로딩·JIT·소켓)를 먼저 데워 콜드스타트 메모리를 측정에서 뺀다.
    const upload = async (key: string, total: number): Promise<{ rss: number; arrayBuffers: number }> => {
      const before = process.memoryUsage();
      let peakRss = before.rss;
      let peakArrayBuffers = before.arrayBuffers;
      const source = Readable.from(
        (async function* () {
          for (let sent = 0; sent < total; sent += chunk.length) {
            yield chunk;
            const usage = process.memoryUsage();
            peakRss = Math.max(peakRss, usage.rss);
            peakArrayBuffers = Math.max(peakArrayBuffers, usage.arrayBuffers);
          }
        })(),
      );
      await storage.put(key, source);
      return { rss: peakRss - before.rss, arrayBuffers: peakArrayBuffers - before.arrayBuffers };
    };
    await upload('blobs/ab/test-memory-warmup', 20 * 1024 * 1024);

    const total = 320 * 1024 * 1024;
    const growth = await upload('blobs/ab/test-memory', total);

    // Part 버퍼는 Buffer(ArrayBuffer)라 arrayBuffers로 재는 편이 RSS(GC·할당기 지연 포함)보다 안정적이다.
    // 실측 피크는 64MiB(PART_SIZE 4배, 회수 전 버퍼 포함)로 반복 실행에서 같았다. 상한 96MiB는 이 값에
    // 여유를 두면서 queueSize를 늘린 부분 버퍼링 회귀와 통버퍼링(320MiB)을 모두 잡는다.
    expect(growth.arrayBuffers).toBeLessThan(96 * 1024 * 1024);
    // RSS는 GC 지연 때문에 흔들리므로 통버퍼링만 잡는 느슨한 상한을 유지한다.
    expect(growth.rss).toBeLessThan(total / 2);
  }, 120000);

  it('list는 1000개를 넘는 object도 모두 반환한다', async () => {
    const prefix = 'blobs/list-many/';
    for (let start = 0; start < 1005; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 1005 - start) }, (_, i) =>
          storage.put(`${prefix}${String(start + i).padStart(4, '0')}`, Readable.from(Buffer.from('x'))),
        ),
      );
    }

    let count = 0;
    for await (const item of storage.list(prefix)) {
      void item;
      count += 1;
    }

    expect(count).toBe(1005);
  }, 120000);

  it('존재하지 않는 key의 get은 영구 저장 오류(STORAGE_FAILURE)다', async () => {
    await expect(storage.get('blobs/ab/no-such-key')).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});
