import { Readable } from 'node:stream';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { Client } from 'minio';
import { MinioBlobStorage } from './minio-blob-storage.js';

describe('MinioBlobStorage', () => {
  let container: StartedMinioContainer;
  let client: Client;
  let storage: MinioBlobStorage;
  const bucket = 'storix-test';

  beforeAll(async () => {
    container = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();
    client = new Client({
      endPoint: container.getHost(),
      port: container.getPort(),
      useSSL: false,
      accessKey: container.getUsername(),
      secretKey: container.getPassword(),
    });
    await client.makeBucket(bucket);
    storage = new MinioBlobStorage(client, bucket);
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

  it('0-byte content를 put하면 0-byte object가 생성된다', async () => {
    const key = 'blobs/ab/test-empty';
    await storage.put(key, Readable.from(Buffer.alloc(0)));

    const stream = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).length).toBe(0);
  });
});
