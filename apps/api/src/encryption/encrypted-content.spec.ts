import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { BlobRange, BlobStorage } from '../storage/blob-storage.js';
import { EncryptingPutTarget, getEncrypted, incrementCounter } from './encrypted-content.js';

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

class FakeBlobStorage implements Pick<BlobStorage, 'put' | 'get' | 'delete'> {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, stream: Readable): Promise<void> {
    this.objects.set(key, await streamToBuffer(stream));
  }

  async get(key: string, range?: BlobRange): Promise<Readable> {
    const data = this.objects.get(key);
    if (!data) {
      throw new Error(`no object: ${key}`);
    }
    if (!range) {
      return Readable.from(data);
    }
    const end = range.end !== undefined ? range.end + 1 : data.length;
    return Readable.from(data.subarray(range.start, end));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  raw(key: string): Buffer {
    const data = this.objects.get(key);
    if (!data) {
      throw new Error(`no object: ${key}`);
    }
    return data;
  }
}

// 실제 MinIO get() 스트림처럼 일부 바이트를 흘린 뒤 중간에 실패하는 source를
// 흉내낸다(네트워크 끊김, S3 5xx, 동시 삭제 등).
class FailingBlobStorage implements Pick<BlobStorage, 'get'> {
  readonly issued: PassThrough[] = [];

  constructor(private readonly failure: Error | null) {}

  async get(): Promise<Readable> {
    const stream = new PassThrough();
    this.issued.push(stream);
    stream.write(randomBytes(64));
    if (this.failure) {
      const failure = this.failure;
      setImmediate(() => stream.destroy(failure));
    }
    return stream;
  }

  lastIssued(): PassThrough {
    const stream = this.issued.at(-1);
    if (!stream) {
      throw new Error('get()이 아직 호출되지 않음');
    }
    return stream;
  }
}

describe('incrementCounter', () => {
  it('마지막 바이트만 증가시킨다(carry 없음)', () => {
    const iv = Buffer.alloc(16, 0);

    expect(incrementCounter(iv, 1)).toEqual(Buffer.concat([Buffer.alloc(15, 0), Buffer.from([1])]));
  });

  it('마지막 바이트가 0xff를 넘으면 앞 바이트로 carry한다', () => {
    const iv = Buffer.concat([Buffer.alloc(14, 0), Buffer.from([0x00, 0xff])]);

    expect(incrementCounter(iv, 1)).toEqual(Buffer.concat([Buffer.alloc(14, 0), Buffer.from([0x01, 0x00])]));
  });

  it('여러 바이트에 걸친 carry도 올바르게 계산한다', () => {
    const iv = Buffer.concat([Buffer.alloc(13, 0), Buffer.from([0x00, 0xff, 0xff])]);

    expect(incrementCounter(iv, 1)).toEqual(Buffer.concat([Buffer.alloc(13, 0), Buffer.from([0x01, 0x00, 0x00])]));
  });

  it('블록 수가 0이면 원본과 동일하다', () => {
    const iv = randomBytes(16);

    expect(incrementCounter(iv, 0)).toEqual(iv);
  });
});

describe('EncryptingPutTarget / getEncrypted 왕복', () => {
  const masterKey = randomBytes(32);
  let storage: FakeBlobStorage;

  beforeEach(() => {
    storage = new FakeBlobStorage();
  });

  it('평문을 암호화해 저장하고, 저장된 바이트는 평문과 다르다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    const plaintext = Buffer.from('hello storix encryption');

    await target.put('blobs/00/test', Readable.from(plaintext));

    expect(storage.raw('blobs/00/test')).not.toEqual(plaintext);
    expect(storage.raw('blobs/00/test').length).toBe(plaintext.length);
  });

  it('range 없이 전체를 복호화하면 원문과 같다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    const plaintext = randomBytes(1000);
    await target.put('blobs/00/full', Readable.from(plaintext));

    const decrypted = await getEncrypted(storage, 'blobs/00/full', target.getIv(), masterKey);

    expect(await streamToBuffer(decrypted)).toEqual(plaintext);
  });

  it('블록 경계에 정렬된 range를 올바르게 복호화한다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    const plaintext = randomBytes(100);
    await target.put('blobs/00/aligned', Readable.from(plaintext));

    const decrypted = await getEncrypted(storage, 'blobs/00/aligned', target.getIv(), masterKey, {
      start: 16,
      end: 31,
    });

    expect(await streamToBuffer(decrypted)).toEqual(plaintext.subarray(16, 32));
  });

  it('블록 경계에 정렬되지 않은 range도 올바르게 복호화한다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    const plaintext = randomBytes(100);
    await target.put('blobs/00/unaligned', Readable.from(plaintext));

    const decrypted = await getEncrypted(storage, 'blobs/00/unaligned', target.getIv(), masterKey, {
      start: 10,
      end: 40,
    });

    expect(await streamToBuffer(decrypted)).toEqual(plaintext.subarray(10, 41));
  });

  it('여러 블록에 걸친 range도 올바르게 복호화한다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    const plaintext = randomBytes(10_000);
    await target.put('blobs/00/multi-block', Readable.from(plaintext));

    const decrypted = await getEncrypted(storage, 'blobs/00/multi-block', target.getIv(), masterKey, {
      start: 5000,
      end: 9999,
    });

    expect(await streamToBuffer(decrypted)).toEqual(plaintext.subarray(5000, 10000));
  });

  it('put() 전에 getIv()를 호출하면 에러를 던진다', () => {
    const target = new EncryptingPutTarget(storage, masterKey);

    expect(() => target.getIv()).toThrow();
  });

  it('delete()는 내부 storage에 위임한다', async () => {
    const target = new EncryptingPutTarget(storage, masterKey);
    await target.put('blobs/00/to-delete', Readable.from(Buffer.from('x')));

    await target.delete('blobs/00/to-delete');

    expect(() => storage.raw('blobs/00/to-delete')).toThrow();
  });
});

describe('getEncrypted 스트림 오류 전파', () => {
  const masterKey = randomBytes(32);
  const iv = randomBytes(16);

  it('range 없이 읽는 도중 source가 실패하면 반환 스트림도 error를 낸다', async () => {
    const storage = new FailingBlobStorage(new Error('minio 연결 끊김'));

    const decrypted = await getEncrypted(storage, 'blobs/00/broken', iv, masterKey);

    await expect(streamToBuffer(decrypted)).rejects.toThrow('minio 연결 끊김');
    expect(storage.lastIssued().destroyed).toBe(true);
  });

  it('range 요청 도중 source가 실패해도 반환 스트림이 error를 낸다', async () => {
    const storage = new FailingBlobStorage(new Error('minio 연결 끊김'));

    // start가 블록 경계에 정렬되지 않아 dropLeadingBytes 단계까지 거치는 경로다.
    const decrypted = await getEncrypted(storage, 'blobs/00/broken', iv, masterKey, { start: 10, end: 4000 });

    await expect(streamToBuffer(decrypted)).rejects.toThrow('minio 연결 끊김');
    expect(storage.lastIssued().destroyed).toBe(true);
  });

  it('반환 스트림을 파괴하면 source도 함께 파괴된다(다운로드 중단 시 소켓 누수 방지)', async () => {
    const storage = new FailingBlobStorage(null);

    const decrypted = await getEncrypted(storage, 'blobs/00/aborted', iv, masterKey, { start: 10, end: 4000 });
    decrypted.resume();
    decrypted.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(storage.lastIssued().destroyed).toBe(true);
  });
});
