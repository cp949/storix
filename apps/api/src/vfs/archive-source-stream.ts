// 캡처한 Blob metadata와 실제 평문 stream 길이·SHA-256을 대조한다.
// 반환 stream을 destroy하면 pipeline이 원본 source까지 즉시 destroy한다.
// Readable.from(async generator)로 감싸면 generator가 다음 chunk를 기다리는 동안 destroy가 미뤄져
// 원본이 다음 chunk 도착까지 열린 채 남는다(s3-blob-storage.ts 머리 주석과 같은 함정). 그래서 쓰지 않는다.
import { createHash } from 'node:crypto';
import { pipeline, Readable, Transform } from 'node:stream';
import { waitForClose } from '../common/stream-close.js';

/** source를 순차 소비하면서 평문 길이와 digest를 확인하는 stream이다. */
export function verifiedArchiveSource(
  source: Readable,
  expectedBytes: bigint,
  expectedSha256: string,
): Readable {
  const hash = createHash('sha256');
  let size = 0n;
  const verifier = new Transform({
    destroy(error, callback) {
      // writer가 wrapper 종료를 관측할 때 원본의 비동기 정리도 완료돼 있어야 한다.
      source.destroy(error ?? undefined);
      void waitForClose(source).then(() => callback(error));
    },
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += BigInt(bytes.length);
      // 선언 길이를 넘는 순간 멈춘다. 끝까지 읽어도 결과는 같은 실패다.
      if (size > expectedBytes) {
        callback(new Error('Archive source integrity mismatch'));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      if (size !== expectedBytes || hash.digest('hex') !== expectedSha256) {
        callback(new Error('Archive source integrity mismatch'));
        return;
      }
      callback();
    },
  });
  // 오류는 verifier의 error 이벤트로 소비자에게 전달되므로 pipeline 콜백은 비워 둔다.
  pipeline(source, verifier, () => undefined);
  return verifier;
}
