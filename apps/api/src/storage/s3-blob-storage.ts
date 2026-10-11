import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  paginateListObjectsV2,
  S3ServiceException,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { finished, PassThrough, Readable } from 'node:stream';
import type {
  BlobObjectInfo,
  BlobPage,
  BlobPageOptions,
  BlobRange,
  BlobStorage,
  IncompleteUploadInfo,
  IncompleteUploadPage,
  IncompleteUploadPageOptions,
} from './blob-storage.js';
import { VfsInvalidRangeError } from './storage.errors.js';
import { StorageFailureError } from '../common/storage-failure.errors.js';
import { S3_MULTIPART_PART_SIZE_BYTES } from '../common/resource-limit.js';
import { classifyBlobFailure } from './storage-failure.js';

// 크기를 모르는 stream 업로드의 멀티파트 크기. lib-storage는 전송 중인 파트와 누적 중인 잔여분을
// 함께 들고 있고, 파트를 자를 때 chunk를 Buffer.concat으로 합친다. 버퍼 메모리는 파일 크기와 무관하며
// QUEUE_SIZE=1에서 arrayBuffers 증가 피크가 64MiB(PART_SIZE의 4배, 회수 전 버퍼 포함)로 실측됐다.
const PART_SIZE = S3_MULTIPART_PART_SIZE_BYTES;
const QUEUE_SIZE = 1;

function sdkFailure(error: unknown): unknown {
  return classifyBlobFailure(error) ?? error;
}

// lib-storage는 취소 뒤 AbortMultipartUpload를 같은 client로 보낸다. 이 요청에도 이미 abort된 signal을
// 붙이면 node-http-handler가 전송 없이 거부해 조각이 GC 회수(grace + 업로드 상한)까지 남는다.
// 그래서 AbortMultipartUpload만 signal 없이 보낸다. 이 정리는 put이 끝난 뒤 배경에서 완료되며,
// 프로세스가 그 전에 죽으면 GC가 회수한다.
function clientWithAbortSignal(client: S3Client, signal: AbortSignal): S3Client {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'send') {
        return (command: unknown, options?: Record<string, unknown>) =>
          command instanceof AbortMultipartUploadCommand
            ? target.send(command as never, options)
            : target.send(command as never, { ...options, abortSignal: signal });
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

// 반환 stream은 소비자가 destroy하면 원본(SDK 응답)도 바로 destroy해야 한다. Readable.from(async
// generator)로 감싸면 generator가 원본의 다음 chunk를 기다리는 동안 destroy가 미뤄져, S3가 멈춘 채
// 클라이언트가 끊겨도 소켓과 요청 처리가 다음 chunk 도착까지 남는다.
function classifyReturnedStream(source: Readable): Readable {
  const out = new PassThrough();
  // 정상 종료는 pipe가 out.end()로 전달한다. 오류와 중간 닫힘은 분류한 오류로 out을 끝낸다.
  finished(source, (error) => {
    if (error) out.destroy(sdkFailure(error) as Error);
  });
  out.once('close', () => source.destroy());
  source.pipe(out);
  return out;
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

  async put(key: string, stream: Readable, contentType?: string, signal?: AbortSignal): Promise<void> {
    const ContentType = contentType ?? 'application/octet-stream';
    const uploadAbortController = signal ? new AbortController() : undefined;
    let sourceError: unknown;
    const rememberSourceError = (error: Error): void => {
      sourceError = error;
    };
    const abortUpload = () => {
      const reason = signal?.reason;
      uploadAbortController?.abort(reason);
      if (!stream.destroyed) stream.destroy(reason instanceof Error ? reason : new Error('PUT aborted'));
    };
    stream.on('error', rememberSourceError);
    if (signal) {
      if (signal.aborted) abortUpload();
      else signal.addEventListener('abort', abortUpload, { once: true });
    }
    try {
      const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();

      let first = await iterator.next();
      while (!first.done && first.value.length === 0) {
        first = await iterator.next();
      }

      if (first.done) {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: Buffer.alloc(0), ContentType }),
          uploadAbortController ? { abortSignal: uploadAbortController.signal } : undefined,
        );
        return;
      }

      await new Upload({
        client: uploadAbortController
          ? clientWithAbortSignal(this.client, uploadAbortController.signal)
          : this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: Readable.from(prependChunk(first.value, iterator)),
          ContentType,
        },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
        ...(uploadAbortController ? { abortController: uploadAbortController } : {}),
      }).done();
    } catch (error) {
      if (sourceError !== undefined) throw sourceError;
      // lib-storage의 AbortError보다 호출자가 넘긴 취소 사유가 먼저다. stream.destroy의 error 이벤트는
      // 다음 tick이라 sourceError에 아직 담기지 않는다.
      if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
      throw sdkFailure(error);
    } finally {
      stream.off('error', rememberSourceError);
      signal?.removeEventListener('abort', abortUpload);
    }
  }

  async get(key: string, range?: BlobRange, signal?: AbortSignal): Promise<Readable> {
    let Range: string | undefined;
    if (range) {
      if (range.start < 0 || (range.end !== undefined && range.end < range.start)) {
        throw new VfsInvalidRangeError(range.start, range.end ?? range.start);
      }
      Range = `bytes=${range.start}-${range.end ?? ''}`;
    }
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range }),
        signal ? { abortSignal: signal } : undefined,
      );
      const body = classifyReturnedStream(response.Body as Readable);
      if (signal) {
        const abort = () =>
          body.destroy(signal.reason instanceof Error ? signal.reason : new Error('GET aborted'));
        const cleanup = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else {
          signal.addEventListener('abort', abort, { once: true });
          body.once('end', cleanup);
          body.once('close', cleanup);
          body.once('error', cleanup);
        }
      }
      return body;
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

  async listPage(prefix: string, options: BlobPageOptions): Promise<BlobPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
      throw new Error('listPage limit은 1 이상 1000 이하의 정수여야 한다');
    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          StartAfter: options.startAfter,
          MaxKeys: options.limit,
        }),
      );
      const items: BlobObjectInfo[] = [];
      for (const item of response.Contents ?? []) {
        if (item.Key && item.LastModified) items.push({ key: item.Key, lastModified: item.LastModified });
      }
      return {
        items,
        nextAfter: response.IsTruncated === true && items.length > 0 ? items[items.length - 1].key : null,
      };
    } catch (error) {
      throw sdkFailure(error);
    }
  }

  async listIncompleteUploadsPage(
    prefix: string,
    options: IncompleteUploadPageOptions,
  ): Promise<IncompleteUploadPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
      throw new Error('listIncompleteUploadsPage limit은 1 이상 1000 이하의 정수여야 한다');
    try {
      const response = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: options.after,
          MaxUploads: options.limit,
        }),
      );
      const items: IncompleteUploadInfo[] = [];
      for (const upload of response.Uploads ?? []) {
        if (upload.Key && upload.UploadId && upload.Initiated) {
          items.push({ key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated });
        }
      }
      return {
        items,
        next: response.IsTruncated === true && response.NextKeyMarker ? response.NextKeyMarker : null,
      };
    } catch (error) {
      throw sdkFailure(error);
    }
  }

  async abortIncompleteUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // 완료되었거나 다른 GC가 먼저 지운 upload는 목표 상태에 이미 도달했다.
      if (error instanceof S3ServiceException && error.name === 'NoSuchUpload') return;
      throw sdkFailure(error);
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
