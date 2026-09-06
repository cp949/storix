import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { BlobObjectInfo, BlobRange, BlobStorage } from './blob-storage.js';
import { uploadStream } from './stream-upload.js';
import { VfsFileTooLargeError } from './storage.errors.js';

class RecordingBlobStorage implements BlobStorage {
  readonly puts: { key: string; contentType?: string }[] = [];
  readonly deletedKeys: string[] = [];
  received = Buffer.alloc(0);
  putError: Error | null = null;

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    this.puts.push({ key, contentType });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    this.received = Buffer.concat(chunks);
    if (this.putError) {
      throw this.putError;
    }
  }

  async get(_key: string, _range?: BlobRange): Promise<Readable> {
    throw new Error('구현되지 않음');
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }

  async *list(): AsyncIterable<BlobObjectInfo> {}
}

// storage.put()이 스트림을 전혀 소비하지 않고 즉시 실패하는 저장소.
// backpressure 상황(drain 대기)에서 put 실패가 무한 대기를 깨우는지 검증하는 데 사용한다.
class PromptlyFailingBlobStorage implements BlobStorage {
  async put(_key: string, _stream: Readable, _contentType?: string): Promise<void> {
    throw new Error('minio 연결 실패');
  }

  async get(_key: string, _range?: BlobRange): Promise<Readable> {
    throw new Error('구현되지 않음');
  }

  async delete(_key: string): Promise<void> {}

  async *list(): AsyncIterable<BlobObjectInfo> {}
}

// 느린 소비 동작을 시뮬레이션하여 PassThrough 버퍼를 채우는 저장소
class SlowConsumingBlobStorage implements BlobStorage {
  readonly puts: { key: string; contentType?: string }[] = [];
  received = Buffer.alloc(0);
  private delayMs: number;

  constructor(delayMs: number = 10) {
    this.delayMs = delayMs;
  }

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    this.puts.push({ key, contentType });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      // 각 청크 수신 후 지연을 두어 소비 속도를 늦춤
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    this.received = Buffer.concat(chunks);
  }

  async get(_key: string, _range?: BlobRange): Promise<Readable> {
    throw new Error('구현되지 않음');
  }

  async delete(_key: string): Promise<void> {}

  async *list(): AsyncIterable<BlobObjectInfo> {}
}

function* chunksOf(text: string, chunkSize: number): Generator<Buffer> {
  const buffer = Buffer.from(text);
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, offset + chunkSize);
  }
}

// 청크 개수를 추적하는 제너레이터
function* trackingChunksOf(text: string, chunkSize: number): Generator<{
  chunk: Buffer;
  totalYielded: number;
}> {
  const buffer = Buffer.from(text);
  let count = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    count++;
    yield {
      chunk: buffer.subarray(offset, offset + chunkSize),
      totalYielded: count,
    };
  }
}

describe('uploadStream', () => {
  it('전체 content의 size와 sha256을 계산해 반환한다', async () => {
    const storage = new RecordingBlobStorage();
    const source = Readable.from(chunksOf('hello storix', 4));

    const result = await uploadStream(storage, 'blobs/00/key', source, 'text/plain', 1024);

    expect(result.size).toBe(Buffer.byteLength('hello storix'));
    expect(result.sha256).toBe(createHash('sha256').update('hello storix').digest('hex'));
    expect(storage.received.toString()).toBe('hello storix');
    expect(storage.puts).toEqual([{ key: 'blobs/00/key', contentType: 'text/plain' }]);
  });

  it('maxBytes를 초과하면 VfsFileTooLargeError를 던진다', async () => {
    const storage = new RecordingBlobStorage();
    const source = Readable.from(chunksOf('this content is too long', 4));

    await expect(uploadStream(storage, 'blobs/00/key', source, 'text/plain', 5)).rejects.toThrow(
      VfsFileTooLargeError,
    );
  });

  it('maxBytes 초과 시 이미 업로드된 부분을 정리하기 위해 storage.delete를 호출한다', async () => {
    const storage = new RecordingBlobStorage();
    const source = Readable.from(chunksOf('this content is too long', 4));

    await expect(uploadStream(storage, 'blobs/00/key', source, 'text/plain', 5)).rejects.toThrow(
      VfsFileTooLargeError,
    );

    expect(storage.deletedKeys).toEqual(['blobs/00/key']);
  });

  it('storage.put이 실패하면 해당 오류를 전파한다', async () => {
    const storage = new RecordingBlobStorage();
    storage.putError = new Error('minio down');
    const source = Readable.from(chunksOf('hello', 2));

    await expect(uploadStream(storage, 'blobs/00/key', source, 'text/plain', 1024)).rejects.toThrow(
      'minio down',
    );
  });

  it('backpressure 처리 시에도 전체 content의 size와 sha256을 정확히 계산한다', async () => {
    // PassThrough의 기본 highWaterMark는 16KB이므로, 그 이상의 데이터로 버퍼를 채워 backpressure 발생
    const largePayload = Buffer.alloc(100 * 1024, 'x').toString(); // 100KB
    const storage = new SlowConsumingBlobStorage(5); // 각 청크 수신 후 5ms 지연
    const source = Readable.from(chunksOf(largePayload, 8192)); // 8KB 청크로 분할

    const result = await uploadStream(storage, 'blobs/00/key', source, 'application/octet-stream', 200 * 1024);

    expect(result.size).toBe(Buffer.byteLength(largePayload));
    expect(result.sha256).toBe(createHash('sha256').update(largePayload).digest('hex'));
    expect(storage.received.length).toBe(Buffer.byteLength(largePayload));
  });

  it('maxBytes 초과 시 source 스트림의 추가 청크는 소비하지 않는다', async () => {
    // 많은 청크를 생성할 수 있는 소스
    const totalPayload = Buffer.alloc(1000).fill('x').toString(); // 1000 바이트
    const trackedChunks = Array.from(trackingChunksOf(totalPayload, 100)); // 10개 청크

    let maxChunksYielded = 0;
    function* countingSource() {
      for (const item of trackedChunks) {
        maxChunksYielded = Math.max(maxChunksYielded, item.totalYielded);
        yield item.chunk;
      }
    }

    const storage = new RecordingBlobStorage();
    const source = Readable.from(countingSource());

    await expect(uploadStream(storage, 'blobs/00/key', source, 'text/plain', 500)).rejects.toThrow(
      VfsFileTooLargeError,
    );

    // 전체 10개 청크 중 일부만 소비되어야 함 (500 바이트 제한으로 중단)
    expect(maxChunksYielded).toBeLessThan(trackedChunks.length);
  });

  it('storage.put이 실패한 상태에서 maxBytes도 초과하면 VfsFileTooLargeError를 우선 반환하고 delete는 호출하지 않는다', async () => {
    const storage = new RecordingBlobStorage();
    storage.putError = new Error('minio down');
    const source = Readable.from(chunksOf('this content is too long', 4));

    await expect(uploadStream(storage, 'blobs/00/key', source, 'text/plain', 5)).rejects.toThrow(
      VfsFileTooLargeError,
    );

    expect(storage.deletedKeys).toEqual([]);
  });

  it('source에서 진짜 오류가 발생하면 sink를 정상 종료시켜 원래 오류를 그대로 전파한다', async () => {
    // 클라이언트 연결 끊김 등을 흉내내기 위해, 일부 chunk만 내보낸 뒤 던지는 소스를 사용한다.
    const storage = new RecordingBlobStorage();
    const sourceError = new Error('연결 끊김');
    const text = 'hello storix world';
    const chunkSize = 4;
    const failAfter = 2;

    async function* failingChunks(): AsyncGenerator<Buffer> {
      const buffer = Buffer.from(text);
      let count = 0;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        if (count === failAfter) {
          throw sourceError;
        }
        count += 1;
        yield buffer.subarray(offset, offset + chunkSize);
      }
    }

    const source = Readable.from(failingChunks());

    let caught: unknown;
    try {
      await uploadStream(storage, 'blobs/00/key', source, 'text/plain', 1024);
    } catch (error) {
      caught = error;
    }

    // (a) 원래 오류가 그대로(대체되거나 삼켜지지 않고) 전파되어야 한다.
    expect(caught).toBe(sourceError);

    // (b) sink.destroy(error) 대신 sink.end()로 정상 종료되었다면 storage.put()의
    // for-await도 정상적으로 완료되어 그때까지 쓰여진 부분 데이터가 received에 반영된다.
    // (sink.destroy()였다면 storage.put()도 함께 오류를 전파받아 received가 비어 있게 된다.)
    expect(storage.received.toString()).toBe(text.slice(0, failAfter * chunkSize));

    // put 자체는 성공했으므로(불완전한 데이터로) 정리를 위해 delete가 호출되어야 한다.
    expect(storage.deletedKeys).toEqual(['blobs/00/key']);

    // (c) 이 지점까지 도달했다는 것 자체가 미처리 예외/rejection 없이 종료되었다는 뜻이다
    // (Jest는 기본적으로 unhandled rejection이 발생하면 테스트 실행을 실패시킨다).
  });

  it('backpressure로 대기 중 storage.put이 빠르게 실패하면 무한 대기하지 않고 즉시 그 오류로 reject한다', async () => {
    // PassThrough의 기본 highWaterMark(16KB)보다 큰 payload로 backpressure를 유도한다.
    const storage = new PromptlyFailingBlobStorage();
    const largePayload = Buffer.alloc(160 * 1024, 'x').toString(); // 160KB
    const source = Readable.from(chunksOf(largePayload, 8192)); // 8KB 청크

    await expect(
      uploadStream(storage, 'blobs/00/key', source, 'application/octet-stream', 200 * 1024),
    ).rejects.toThrow('minio 연결 실패');
  });
});
