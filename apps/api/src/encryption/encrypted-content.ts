import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import type { Duplex, Readable } from 'node:stream';
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

// Node의 Readable.pipe()는 destination에만 'error' 리스너를 붙인다. 그래서 source
// (실제로는 MinIO HTTP 응답 스트림)가 중간에 실패하면 그 오류가 destination으로
// 전파되지 않아 소비자는 영원히 대기하고, 아무도 처리하지 않은 source의 'error'는
// uncaughtException이 되어 프로세스를 죽인다. 반대로 소비자가 결과 스트림을 파괴해도
// source는 살아남아 MinIO HTTP 소켓이 샌다. pipeline()은 양방향으로 오류를 전파하고
// 한쪽이 끝나거나 파괴되면 나머지도 파괴하므로 두 문제를 모두 없앤다.
// 콜백은 비워둔다 — 오류는 destination에도 그대로 전파되므로 호출자가 처리한다.
function pipeThrough<T extends Duplex>(source: Readable, destination: T): T {
  pipeline(source, destination, () => undefined);
  return destination;
}

function dropLeadingBytes(source: Readable, count: number): Readable {
  if (count === 0) {
    return source;
  }

  let remaining = count;
  return pipeThrough(
    source,
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
    await this.inner.put(key, pipeThrough(stream, cipher), contentType);
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
    return pipeThrough(cipherStream, createDecipheriv(ALGORITHM, masterKey, iv));
  }

  const blockOffset = Math.floor(range.start / BLOCK_SIZE) * BLOCK_SIZE;
  const discard = range.start - blockOffset;
  const cipherStream = await inner.get(key, { start: blockOffset, end: range.end });
  const counter = incrementCounter(iv, blockOffset / BLOCK_SIZE);
  const decrypted = pipeThrough(cipherStream, createDecipheriv(ALGORITHM, masterKey, counter));
  return dropLeadingBytes(decrypted, discard);
}
