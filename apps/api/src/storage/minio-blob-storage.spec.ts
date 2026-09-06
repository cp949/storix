import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import type { Client } from 'minio';
import { MinioBlobStorage } from './minio-blob-storage.js';
import { VfsInvalidRangeError } from './storage.errors.js';

describe('MinioBlobStorage', () => {
  it('range.end가 range.start보다 작으면 거부한다', async () => {
    const client = {} as Client;
    const storage = new MinioBlobStorage(client, 'bucket');

    await expect(storage.get('key', { start: 5, end: 2 })).rejects.toThrow(VfsInvalidRangeError);
  });

  it('range.start가 음수면 거부한다', async () => {
    const client = {} as Client;
    const storage = new MinioBlobStorage(client, 'bucket');

    await expect(storage.get('key', { start: -1, end: 2 })).rejects.toThrow(VfsInvalidRangeError);
  });

  it('빈 stream을 put하면 size=0을 명시해 단일 객체로 생성한다', async () => {
    const putObject = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const client = { putObject } as unknown as Client;
    const storage = new MinioBlobStorage(client, 'bucket');

    await storage.put('key', Readable.from(Buffer.alloc(0)));

    expect(putObject).toHaveBeenCalledTimes(1);
    const [bucket, key, body, size] = putObject.mock.calls[0] as unknown as [
      string,
      string,
      Buffer,
      number,
      unknown,
    ];
    expect(bucket).toBe('bucket');
    expect(key).toBe('key');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBe(0);
    expect(size).toBe(0);
  });

  it('내용이 있는 stream을 put하면 size를 알 수 없는 채로 스트리밍 업로드한다', async () => {
    const putObject = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const client = { putObject } as unknown as Client;
    const storage = new MinioBlobStorage(client, 'bucket');

    await storage.put('key', Readable.from(Buffer.from('hello')));

    expect(putObject).toHaveBeenCalledTimes(1);
    const [, , body, size] = putObject.mock.calls[0] as unknown as [
      string,
      string,
      AsyncIterable<Buffer>,
      number | undefined,
      unknown,
    ];
    expect(size).toBeUndefined();

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});
