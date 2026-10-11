// 가짜 Readable에서 archive source 무결성 검증과 destroy 전파를 확인한다.
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { verifiedArchiveSource } from '../../src/vfs/archive-source-stream.js';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

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
});
