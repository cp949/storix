import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type { BlobRange, BlobStorage } from '../storage/blob-storage.js';

export const IV_LENGTH = 16;
const BLOCK_SIZE = 16;
const ALGORITHM = 'aes-256-ctr';

// AES-CTR은 16바이트 IV 전체를 128비트 빅엔디안 카운터로 취급해 블록마다 1씩
// 증가시킨다. range 요청의 시작 지점이 블록 경계가 아니어도 임의 오프셋부터
// 복호화를 시작하려면, 그 오프셋이 속한 블록 번호만큼 미리 증가시킨 카운터로
// decipher를 초기화해야 한다.
export function incrementCounter(iv: Buffer, blocks: number): Buffer {
  const counter = Buffer.from(iv);
  let carry = blocks;
  for (let i = counter.length - 1; i >= 0 && carry > 0; i -= 1) {
    const sum = counter[i] + carry;
    counter[i] = sum & 0xff;
    carry = Math.floor(sum / 256);
  }
  return counter;
}

function dropLeadingBytes(source: Readable, count: number): Readable {
  if (count === 0) {
    return source;
  }

  let remaining = count;
  return source.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (remaining === 0) {
          callback(null, chunk);
          return;
        }
        if (chunk.length <= remaining) {
          remaining -= chunk.length;
          callback();
          return;
        }
        const sliced = chunk.subarray(remaining);
        remaining = 0;
        callback(null, sliced);
      },
    }),
  );
}

export class EncryptingPutTarget {
  private iv: Buffer | null = null;

  constructor(
    private readonly inner: Pick<BlobStorage, 'put' | 'delete'>,
    private readonly masterKey: Buffer,
  ) {}

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    await this.inner.put(key, stream.pipe(cipher), contentType);
    this.iv = iv;
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  getIv(): Buffer {
    if (!this.iv) {
      throw new Error('put()을 호출하기 전에는 IV가 없음');
    }
    return this.iv;
  }
}

export async function getEncrypted(
  inner: Pick<BlobStorage, 'get'>,
  key: string,
  iv: Buffer,
  masterKey: Buffer,
  range?: BlobRange,
): Promise<Readable> {
  if (!range) {
    const cipherStream = await inner.get(key);
    return cipherStream.pipe(createDecipheriv(ALGORITHM, masterKey, iv));
  }

  const blockOffset = Math.floor(range.start / BLOCK_SIZE) * BLOCK_SIZE;
  const discard = range.start - blockOffset;
  const cipherStream = await inner.get(key, { start: blockOffset, end: range.end });
  const counter = incrementCounter(iv, blockOffset / BLOCK_SIZE);
  const decrypted = cipherStream.pipe(createDecipheriv(ALGORITHM, masterKey, counter));
  return dropLeadingBytes(decrypted, discard);
}
