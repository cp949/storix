// 소비자 기대: 어떤 바이트열을 저장해도 콘텐츠 종류와 무관하게 읽을 때 바이트와 SHA-256이 입력과 같다.
// 대응 요구사항: RQ-004(바이트 무손실 보존).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 해석·정규화되기 쉬운 바이트열. 이름은 실패 메시지에만 쓴다. */
const PAYLOADS: ReadonlyArray<readonly [string, Buffer]> = [
  ['빈 파일', Buffer.alloc(0)],
  ['0x00~0xff 전체', Buffer.from(Array.from({ length: 256 }, (_, index) => index))],
  ['UTF-8 BOM과 한글', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('한글 본문', 'utf-8')])],
  ['CRLF·LF·CR 혼합, 끝 개행 없음', Buffer.from('a\r\nb\nc\rd', 'utf-8')],
  ['공백·중복 키가 있는 JSON', Buffer.from('{"b": 1,  "a":2, "a":3}\n\n\n', 'utf-8')],
  ['유효하지 않은 UTF-8', Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1])],
  ['NUL로 채운 바이트', Buffer.alloc(4096)],
  ['1MiB 무작위', randomBytes(1024 * 1024)],
];

/** 서버가 내용을 해석할 여지가 있는 Content-Type. */
const CONTENT_TYPES = ['application/octet-stream', 'application/json', 'text/plain; charset=euc-kr'];

export default defineContract({
  id: 'byte-roundtrip',
  title: '저장한 바이트는 콘텐츠 종류와 무관하게 읽을 때 바이트와 SHA-256이 그대로다',
  rq: ['RQ-004'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    for (const [index, [name, bytes]] of PAYLOADS.entries()) {
      const contentType = CONTENT_TYPES[index % CONTENT_TYPES.length];
      const filePath = `/payload-${index}.bin`;
      const expected = sha256(bytes);

      const created = await ctx.client.putConditionalContent(
        ns,
        filePath,
        bytes,
        { ifAbsent: true },
        { contentType },
      );
      assert.equal(created.status, 201, name);

      const read = await ctx.client.getContent(ns, filePath);
      assert.equal(read.status, 200, name);
      assert.deepEqual(read.bytes, bytes, name);
      assert.equal(read.headers.get('x-storix-sha256'), expected, name);

      const stat = await ctx.client.getStat(ns, filePath);
      assert.equal(stat.json<{ sha256: string }>().sha256, expected, name);
      assert.equal(stat.json<{ size: number }>().size, bytes.length, name);
    }

    // 조건 없이 저장하는 경로(`POST /fs/content`)도 같은 바이트를 보존한다.
    for (const [index, [name, bytes]] of PAYLOADS.entries()) {
      const filePath = `/plain-${index}.bin`;
      const written = await ctx.client.request(
        'POST',
        `/api/v2/namespaces/${ns}/fs/content?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes },
      );
      assert.equal(written.status, 201, name);
      const read = await ctx.client.getContent(ns, filePath);
      assert.deepEqual(read.bytes, bytes, name);
      assert.equal(read.headers.get('x-storix-sha256'), sha256(bytes), name);
    }
  },
});
