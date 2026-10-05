// 가짜 BlobStorage를 사용해 공통 content-ingress provider의 stream·암호화 경계를 검증한다.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { BlobObjectInfo, BlobRange, BlobStorage } from '../../src/storage/blob-storage.js';
import { getEncrypted } from '../../src/encryption/encrypted-content.js';
import { VfsFileTooLargeError } from '../../src/storage/storage.errors.js';
import { ContentIngressService } from '../../src/vfs/content-ingress.service.js';

describe('ContentIngressService', () => {
  it('평문을 저장하고 평문 size와 SHA-256을 반환한다', async () => {
    const storage = new MemoryBlobStorage();
    const ingress = new ContentIngressService(storage, Buffer.alloc(32, 7));
    const bytes = Buffer.from('plain content');

    const result = await ingress.upload('plain/key', Readable.from([bytes]), 'text/plain', 100, false);

    expect(result).toEqual({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      encryptionIv: null,
    });
    expect(storage.objects.get('plain/key')?.toString()).toBe('plain content');
  });

  it('암호문을 저장하고 복호화에 필요한 IV와 평문 digest를 반환한다', async () => {
    const storage = new MemoryBlobStorage();
    const masterKey = Buffer.alloc(32, 7);
    const ingress = new ContentIngressService(storage, masterKey);
    const bytes = Buffer.from('encrypted content');

    const result = await ingress.upload('encrypted/key', Readable.from([bytes]), 'text/plain', 100, true);

    expect(result.size).toBe(bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.encryptionIv).toHaveLength(16);
    expect(storage.objects.get('encrypted/key')).not.toEqual(bytes);
    const decrypted = await getEncrypted(storage, 'encrypted/key', result.encryptionIv!, masterKey);
    const chunks: Buffer[] = [];
    for await (const chunk of decrypted as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it('저장 없는 hash에도 평문 byte cap을 적용한다', async () => {
    const ingress = new ContentIngressService(new MemoryBlobStorage(), Buffer.alloc(32, 7));

    await expect(ingress.hash(Readable.from([Buffer.from('too long')]), 3)).rejects.toBeInstanceOf(
      VfsFileTooLargeError,
    );
  });

  it('암호화 업로드 byte cap을 넘으면 불완전 객체를 정리한다', async () => {
    const storage = new MemoryBlobStorage();
    const ingress = new ContentIngressService(storage, Buffer.alloc(32, 7));

    await expect(
      ingress.upload('encrypted/key', Readable.from([Buffer.from('too long')]), 'text/plain', 3, true),
    ).rejects.toBeInstanceOf(VfsFileTooLargeError);

    expect(storage.deletedKeys).toEqual(['encrypted/key']);
    expect(storage.objects.has('encrypted/key')).toBe(false);
  });

  it('source 오류를 그대로 전파하고 이미 쓴 불완전 객체를 정리한다', async () => {
    const storage = new MemoryBlobStorage();
    const ingress = new ContentIngressService(storage, Buffer.alloc(32, 7));
    const sourceError = new Error('source disconnected');
    async function* failingSource() {
      yield Buffer.from('partial');
      throw sourceError;
    }

    await expect(
      ingress.upload('plain/key', Readable.from(failingSource()), 'text/plain', 100, false),
    ).rejects.toBe(sourceError);

    expect(storage.deletedKeys).toEqual(['plain/key']);
    expect(storage.objects.has('plain/key')).toBe(false);
  });

  it('storage.put의 즉시 실패를 전파한다', async () => {
    const storageError = new Error('put failed immediately');
    const storage = new MemoryBlobStorage({ mode: 'immediate', error: storageError });
    const ingress = new ContentIngressService(storage, Buffer.alloc(32, 7));

    await expect(
      ingress.upload('plain/key', Readable.from([Buffer.alloc(64 * 1024)]), 'text/plain', 100_000, false),
    ).rejects.toBe(storageError);
  });

  it('backpressure 대기 중 storage.put 실패로 대기가 풀리고 오류를 전파한다', async () => {
    const storageError = new Error('put failed while draining');
    const storage = new MemoryBlobStorage({ mode: 'after-read', error: storageError });
    const ingress = new ContentIngressService(storage, Buffer.alloc(32, 7));

    await expect(
      ingress.upload('plain/key', Readable.from(Buffer.alloc(256 * 1024)), 'text/plain', 300_000, false),
    ).rejects.toBe(storageError);
  });
});

class MemoryBlobStorage implements BlobStorage {
  readonly objects = new Map<string, Buffer>();
  readonly deletedKeys: string[] = [];

  constructor(private readonly failure?: { mode: 'immediate' | 'after-read'; error: Error }) {}

  async put(key: string, stream: Readable): Promise<void> {
    if (this.failure?.mode === 'immediate') throw this.failure.error;
    const chunks: Buffer[] = [];
    if (this.failure?.mode === 'after-read') {
      const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (!first.done) chunks.push(first.value);
      await new Promise((resolve) => setImmediate(resolve));
      throw this.failure.error;
    }
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    this.objects.set(key, Buffer.concat(chunks));
  }

  async get(key: string, _range?: BlobRange): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new Error('객체 없음');
    return Readable.from([object]);
  }

  async getPresignedUrl(_key: string, _expirySeconds: number, _contentDisposition?: string): Promise<string> {
    throw new Error('구현되지 않음');
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }

  async *list(): AsyncIterable<BlobObjectInfo> {}

  async listPage(): Promise<{ items: []; nextAfter: null }> {
    return { items: [], nextAfter: null };
  }

  async listIncompleteUploadsPage(): Promise<{ items: []; next: null }> {
    return { items: [], next: null };
  }

  async abortIncompleteUpload(): Promise<void> {}
}
