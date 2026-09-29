import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { toWebStream } from './request-body-stream.js';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(value));
  }
}

function manualSource(): Readable {
  return new Readable({ read() {} });
}

describe('toWebStream', () => {
  it('원본 청크를 순서대로 전달하고 종료한다', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);

    const result = await readAll(toWebStream(source));

    expect(result.toString()).toBe('abcd');
  });

  it('소비자가 읽기 전에는 원본 버퍼를 소비하지 않는다', async () => {
    const source = manualSource();
    toWebStream(source);
    source.push(Buffer.alloc(8));

    await new Promise((resolve) => setImmediate(resolve));

    expect(source.readableLength).toBe(8);
  });

  it('취소하면 원본 스트림을 destroy한다', async () => {
    const source = manualSource();
    const web = toWebStream(source);
    source.push(Buffer.alloc(8));
    const reader = web.getReader();
    await reader.read();

    await reader.cancel();

    expect(source.destroyed).toBe(true);
  });

  it('원본이 오류로 끝나면 읽기만 거부하고 프로세스 예외를 만들지 않는다', async () => {
    const uncaught = jest.fn();
    process.on('uncaughtException', uncaught);
    try {
      const source = manualSource();
      const reader = toWebStream(source).getReader();
      source.push(Buffer.alloc(8));
      await reader.read();

      source.destroy(new Error('연결 끊김'));
      // 오류 뒤에도 버퍼에 남은 청크를 밀어 넣으려는 시도가 있어도 예외가 새면 안 된다.
      source.push(Buffer.alloc(8));

      await expect(reader.read()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });
});
