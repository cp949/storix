import { Readable } from 'node:stream';
import type { Client } from 'minio';
import type { BlobObjectInfo, BlobRange, BlobStorage } from './blob-storage.js';
import { VfsInvalidRangeError } from './storage.errors.js';

async function* prependChunk(first: Buffer, rest: AsyncIterator<Buffer>): AsyncGenerator<Buffer> {
  yield first;
  let result = await rest.next();
  while (!result.done) {
    yield result.value;
    result = await rest.next();
  }
}

export class MinioBlobStorage implements BlobStorage {
  constructor(
    private readonly client: Client,
    private readonly bucket: string,
    private readonly presignedClient: Client | null,
  ) {}

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    const metaData = { 'Content-Type': contentType ?? 'application/octet-stream' };
    const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();

    let first = await iterator.next();
    while (!first.done && first.value.length === 0) {
      first = await iterator.next();
    }

    if (first.done) {
      await this.client.putObject(this.bucket, key, Buffer.alloc(0), 0, metaData);
      return;
    }

    await this.client.putObject(
      this.bucket,
      key,
      Readable.from(prependChunk(first.value, iterator)),
      undefined,
      metaData,
    );
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    if (range) {
      if (range.start < 0 || (range.end !== undefined && range.end < range.start)) {
        throw new VfsInvalidRangeError(range.start, range.end ?? range.start);
      }
      const length = range.end !== undefined ? range.end - range.start + 1 : undefined;
      return this.client.getPartialObject(this.bucket, key, range.start, length);
    }
    return this.client.getObject(this.bucket, key);
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async *list(prefix?: string): AsyncIterable<BlobObjectInfo> {
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    for await (const item of stream) {
      if (item.name && item.lastModified) {
        yield { key: item.name, lastModified: item.lastModified };
      }
    }
  }

  async getPresignedUrl(key: string, expirySeconds: number, contentDisposition?: string): Promise<string> {
    if (!this.presignedClient) {
      throw new Error('STORIX_STORAGE_PUBLIC_ENDPOINT가 설정되지 않아 presigned URL을 발급할 수 없음');
    }
    const reqParams = contentDisposition ? { 'response-content-disposition': contentDisposition } : undefined;
    return this.presignedClient.presignedGetObject(this.bucket, key, expirySeconds, reqParams);
  }
}
