import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  paginateListObjectsV2,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { BlobObjectInfo, BlobRange, BlobStorage } from './blob-storage.js';
import { VfsInvalidRangeError } from './storage.errors.js';
import { StorageFailureError } from '../common/storage-failure.errors.js';
import { classifyBlobFailure } from './storage-failure.js';

// 크기를 모르는 stream 업로드의 멀티파트 크기. lib-storage는 전송 중인 파트와 누적 중인 잔여분을
// 함께 들고 있고, 파트를 자를 때 chunk를 Buffer.concat으로 합친다. 버퍼 메모리는 파일 크기와 무관하며
// QUEUE_SIZE=1에서 arrayBuffers 증가 피크가 64MiB(PART_SIZE의 4배, 회수 전 버퍼 포함)로 실측됐다.
const PART_SIZE = 16 * 1024 * 1024;
const QUEUE_SIZE = 1;

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

export class S3BlobStorage implements BlobStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly presignClient: S3Client | null,
  ) {}

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    const ContentType = contentType ?? 'application/octet-stream';
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
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: Buffer.alloc(0), ContentType }),
        );
        return;
      }

      await new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: Readable.from(prependChunk(first.value, iterator)),
          ContentType,
        },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      }).done();
    } catch (error) {
      if (sourceError !== undefined) throw sourceError;
      throw sdkFailure(error);
    } finally {
      stream.off('error', rememberSourceError);
    }
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    let Range: string | undefined;
    if (range) {
      if (range.start < 0 || (range.end !== undefined && range.end < range.start)) {
        throw new VfsInvalidRangeError(range.start, range.end ?? range.start);
      }
      Range = `bytes=${range.start}-${range.end ?? ''}`;
    }
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range }));
      return classifyReturnedStream(response.Body as Readable);
    } catch (error) {
      throw sdkFailure(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw sdkFailure(error);
    }
  }

  async *list(prefix?: string): AsyncIterable<BlobObjectInfo> {
    const pages = paginateListObjectsV2({ client: this.client }, { Bucket: this.bucket, Prefix: prefix });
    for await (const page of pages) {
      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified) {
          yield { key: item.Key, lastModified: item.LastModified };
        }
      }
    }
  }

  async getPresignedUrl(
    key: string,
    expirySeconds: number,
    contentDisposition?: string,
    contentType?: string,
  ): Promise<string> {
    if (!this.presignClient) {
      throw new StorageFailureError(
        'STORIX_STORAGE_PUBLIC_ENDPOINT가 설정되지 않아 presigned URL을 발급할 수 없음',
      );
    }
    try {
      return await getSignedUrl(
        this.presignClient,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentDisposition: contentDisposition,
          ResponseContentType: contentType,
        }),
        { expiresIn: expirySeconds },
      );
    } catch (error) {
      throw sdkFailure(error);
    }
  }
}
