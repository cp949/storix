// 가짜 Readable에서 archive source 무결성 검증을 확인한다.
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { verifiedArchiveSource } from '../../src/vfs/archive-source-stream.js';

describe('검증된 archive source', () => {
  it('평문 길이와 SHA-256이 다르면 stream을 오류로 끝낸다', async () => {
    const source = verifiedArchiveSource(Readable.from([Buffer.from('different')]), 4n, '0'.repeat(64));
    const chunks: Buffer[] = [];
    await expect(async () => {
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
    }).rejects.toThrow('Archive source integrity mismatch');
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it('SHA-256이 맞아도 평문 길이가 다르면 오류를 낸다', async () => {
    const content = Buffer.from('four');
    const source = verifiedArchiveSource(
      Readable.from([content]),
      5n,
      createHash('sha256').update(content).digest('hex'),
    );
    await expect(async () => {
      for await (const chunk of source) void chunk;
    }).rejects.toThrow('Archive source integrity mismatch');
  });
});
