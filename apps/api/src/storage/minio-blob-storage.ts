import { Readable } from 'node:stream';
import type { Client } from 'minio';
import type { BlobObjectInfo, BlobRange, BlobStorage } from './blob-storage.js';
import { VfsInvalidRangeError } from './storage.errors.js';
import { StorageFailureError } from '../common/storage-failure.errors.js';
import { classifyBlobFailure } from './storage-failure.js';

function sdkFailure(error: unknown): unknown {
  return classifyBlobFailure(error) ?? error;
}

function classifyReturnedStream(source: Readable): Readable {
  return Readable.from(
    (async function* () {
      try {
        for await (const chunk of source) yield chunk;
      } catch (error) {
        throw sdkFailure(error);
      }
    })(),
  );
}

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
    let sourceError: unknown;
    const rememberSourceError = (error: Error): void => {
      sourceError = error;
    };
    stream.on('error', rememberSourceError);
    try {
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
    } catch (error) {
      if (sourceError !== undefined) throw sourceError;
      throw sdkFailure(error);
    } finally {
      stream.off('error', rememberSourceError);
    }
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    if (range) {
      if (range.start < 0 || (range.end !== undefined && range.end < range.start)) {
        throw new VfsInvalidRangeError(range.start, range.end ?? range.start);
      }
      const length = range.end !== undefined ? range.end - range.start + 1 : undefined;
      try {
        return classifyReturnedStream(
          await this.client.getPartialObject(this.bucket, key, range.start, length),
        );
      } catch (error) {
        throw sdkFailure(error);
      }
    }
    try {
      return classifyReturnedStream(await this.client.getObject(this.bucket, key));
    } catch (error) {
      throw sdkFailure(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (error) {
      throw sdkFailure(error);
    }
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
      throw new StorageFailureError(
        'STORIX_STORAGE_PUBLIC_ENDPOINT가 설정되지 않아 presigned URL을 발급할 수 없음',
      );
    }
    const reqParams = contentDisposition ? { 'response-content-disposition': contentDisposition } : undefined;
    try {
      return await this.presignedClient.presignedGetObject(this.bucket, key, expirySeconds, reqParams);
    } catch (error) {
      throw sdkFailure(error);
    }
  }
}
