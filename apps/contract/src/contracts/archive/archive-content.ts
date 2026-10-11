// 소비자 기대: 암호화 namespace의 ZIP을 다운로드하면 요청 순서·내부 이름·원본 평문 바이트가 보존된다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'archive-content',
  title: 'archive 다운로드는 입력 순서와 ZIP 내부 이름 및 원본 평문 바이트를 보존한다',
  rq: ['RQ-035'],
  profile: 'archive',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const sources = [Buffer.from([0, 1, 127, 128, 255]), Buffer.from('한글 archive 원본\n')];
    const names = ['폴더/첫째.bin', '둘째.txt'];
    const entries = [];
    for (const [index, source] of sources.entries()) {
      const path = `/source-${index}`;
      const saved = await ctx.client.putConditionalContent(ns, path, source, { ifAbsent: true });
      assert.equal(saved.status, 201, saved.text());
      const statResponse = await ctx.client.getStat(ns, path);
      assert.equal(statResponse.status, 200, statResponse.text());
      const stat = statResponse.json<{ id: string; revision: string }>();
      entries.push({ id: stat.id, revision: stat.revision, name: names[index] });
    }
    const created = await ctx.client.createArchive(ns, { target: '/content.zip', entries });
    assert.equal(created.status, 201, created.text());
    const result = created.json<{ resource: { revision: string; sha256: string }; entryCount: number }>();
    assert.match(result.resource.revision, /^r1\./);
    assert.equal(result.entryCount, sources.length);
    const existing = await ctx.client.createArchive(ns, { target: '/content.zip', entries });
    assert.equal(existing.status, 412, existing.text());
    const downloaded = await ctx.client.getContent(ns, '/content.zip');
    assert.equal(downloaded.status, 200, downloaded.text());
    const zip = downloaded.bytes;
    assert.equal(result.resource.sha256, createHash('sha256').update(zip).digest('hex'));

    // Zip64·comment 없는 ZIP의 central directory에서 크기와 순서를 읽는다. API 구현은 참조하지 않는다.
    const end = zip.length - 22;
    assert.ok(end >= 0, 'ZIP end record가 있어야 한다');
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    assert.equal(zip.readUInt16LE(end + 20), 0);
    assert.equal(zip.readUInt16LE(end + 10), sources.length);
    let offset = zip.readUInt32LE(end + 16);
    for (const [index, expected] of sources.entries()) {
      assert.equal(zip.readUInt32LE(offset), 0x02014b50);
      const method = zip.readUInt16LE(offset + 10);
      const compressedSize = zip.readUInt32LE(offset + 20);
      const nameLength = zip.readUInt16LE(offset + 28);
      const extraLength = zip.readUInt16LE(offset + 30);
      const commentLength = zip.readUInt16LE(offset + 32);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      assert.equal(name, names[index]);
      assert.equal(zip.readUInt32LE(offset + 24), expected.length);
      const local = zip.readUInt32LE(offset + 42);
      assert.equal(zip.readUInt32LE(local), 0x04034b50);
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(dataStart, dataStart + compressedSize);
      assert.ok(method === 0 || method === 8, 'STORED 또는 DEFLATE여야 한다');
      assert.deepEqual(method === 8 ? inflateRawSync(compressed) : compressed, expected);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(offset, end, 'central directory 뒤에는 end record만 있어야 한다');
  },
});
