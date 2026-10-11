// 가짜 Readable에서 archive source 무결성 검증과 destroy 전파를 확인한다.
// 검증 규칙은 docs/design/16-file-archive.md의 "공개 계약", "실행과 실패 경계" 절를 따른다.
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { verifiedArchiveSource } from '../../src/vfs/archive-source-stream.js';

/** 검증 stream의 전체 출력 byte를 읽어 무결성 오류도 관측한다. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// 길이·digest 오류와 소비자 취소가 원본 stream 종료까지 전파돼야 한다.
describe('검증된 archive source', () => {
  it('길이와 SHA-256이 맞으면 같은 byte를 그대로 내보내고 정상 종료한다', async () => {
    const content = Buffer.from('archive source payload');
    const source = verifiedArchiveSource(
      Readable.from([content.subarray(0, 5), content.subarray(5)]),
      BigInt(content.length),
      createHash('sha256').update(content).digest('hex'),
    );
    await expect(collect(source)).resolves.toEqual(content);
  });

  it('길이는 같아도 SHA-256이 다르면 stream을 오류로 끝낸다', async () => {
    const source = verifiedArchiveSource(Readable.from([Buffer.from('diff')]), 4n, '0'.repeat(64));
    await expect(collect(source)).rejects.toThrow('Archive source integrity mismatch');
  });

  it('SHA-256이 맞아도 평문 길이가 다르면 오류를 낸다', async () => {
    const content = Buffer.from('four');
    const source = verifiedArchiveSource(
      Readable.from([content]),
      5n,
      createHash('sha256').update(content).digest('hex'),
    );
    await expect(collect(source)).rejects.toThrow('Archive source integrity mismatch');
  });

  it('선언 길이를 넘는 chunk가 오면 끝없는 source라도 바로 오류로 끝내고 source를 닫는다', async () => {
    const inner = new Readable({
      read() {
        this.push(Buffer.alloc(8, 1));
      },
    });
    const source = verifiedArchiveSource(inner, 4n, '0'.repeat(64));
    await expect(collect(source)).rejects.toThrow('Archive source integrity mismatch');
    expect(inner.destroyed).toBe(true);
  });

  it('inner source가 다음 chunk를 기다리는 동안 wrapper를 destroy하면 inner도 즉시 닫힌다', async () => {
    const inner = new Readable({ read: () => undefined });
    inner.push(Buffer.from('first'));
    const source = verifiedArchiveSource(inner, 100n, '0'.repeat(64));
    await new Promise<void>((resolve) => source.once('data', () => resolve()));

    source.destroy(new Error('consumer stopped'));

    await new Promise<void>((resolve) => inner.once('close', resolve));
    expect(inner.destroyed).toBe(true);
  });
  // wrapper 종료가 실제 Blob source의 비동기 정리보다 앞서면 gate 슬롯을 너무 일찍 반환한다.
  it.each([true, false])(
    'emitClose=%s 원본의 destroy callback이 끝날 때까지 wrapper 종료를 기다린다',
    async (emitClose) => {
      let finishDestroy: (() => void) | undefined;
      const inner = new Readable({
        emitClose,
        read: () => undefined,
        destroy(error, callback) {
          finishDestroy = () => callback(error);
        },
      });
      const source = verifiedArchiveSource(inner, 100n, '0'.repeat(64));
      const closed = new Promise<void>((resolve) => source.once('close', resolve));
      source.destroy(new Error('consumer stopped'));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(inner.destroyed).toBe(true);
        expect(source.closed).toBe(false);
      } finally {
        finishDestroy?.();
        await closed;
      }
      expect(inner.closed).toBe(true);
    },
  );
});
