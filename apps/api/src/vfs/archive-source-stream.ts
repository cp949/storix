// 캡처한 Blob metadata와 실제 평문 stream 길이·SHA-256을 대조한다.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/** source를 순차 소비하면서 평문 길이와 digest를 확인하는 stream이다. */
export function verifiedArchiveSource(
  source: Readable,
  expectedBytes: bigint,
  expectedSha256: string,
): Readable {
  return Readable.from(
    (async function* () {
      const hash = createHash('sha256');
      let size = 0n;
      for await (const chunk of source as AsyncIterable<Buffer>) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += BigInt(bytes.length);
        hash.update(bytes);
        yield bytes;
      }
      if (size !== expectedBytes || hash.digest('hex') !== expectedSha256) {
        throw new Error('Archive source integrity mismatch');
      }
    })(),
  );
}
