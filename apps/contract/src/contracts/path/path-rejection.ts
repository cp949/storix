// 소비자 기대: 허용하지 않는 경로는 파일 트리를 바꾸지 않고 400 `VFS_INVALID_PATH`로 거부되며, 없는 부모는 자동으로 만들어지지 않는다.
// 대응 요구사항: RQ-003(경로 계약). 규칙 출처는 docs/design/05-vfs-path-contract.md.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

const NFD_NAME = '한글'.normalize('NFD');

/** 거부 대상 경로와 사유. 사유는 실패 메시지에만 쓴다. */
const INVALID_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['/a/../b.txt', '`..` 구간'],
  ['/../escape.txt', '루트 위로 벗어나는 `..`'],
  ['relative.txt', '선행 `/` 없음'],
  ['/back\\slash.txt', '백슬래시'],
  ['/nul\u0000.txt', 'NUL'],
  ['/ctrl\u0001.txt', 'C0 제어 문자'],
  ['/del\u007f.txt', 'DEL'],
  ['/c1\u0085.txt', 'C1 제어 문자'],
  ['/bidi‮.txt', 'Bidi 제어 문자'],
  [`/${NFD_NAME}.txt`, 'NFC가 아닌 이름'],
  [`/${'a'.repeat(256)}.txt`, 'UTF-8 255바이트 초과 이름'],
  [`/${Array.from({ length: 21 }, () => 'a'.repeat(200)).join('/')}`, '정규 경로 4096바이트 초과'],
];

interface ErrorBody {
  code: string;
}

export default defineContract({
  id: 'path-rejection',
  title: '허용하지 않는 경로는 트리를 바꾸지 않고 400 VFS_INVALID_PATH로 거부한다',
  rq: ['RQ-003'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    for (const [invalidPath, reason] of INVALID_PATHS) {
      const label = `${reason}: ${JSON.stringify(invalidPath.slice(0, 40))}`;

      const write = await ctx.client.putConditionalContent(ns, invalidPath, Buffer.from('x'), {
        ifAbsent: true,
      });
      assert.equal(write.status, 400, `쓰기 ${label}`);
      assert.equal(write.json<ErrorBody>().code, 'VFS_INVALID_PATH', `쓰기 ${label}`);

      const read = await ctx.client.getStat(ns, invalidPath);
      assert.equal(read.status, 400, `읽기 ${label}`);
      assert.equal(read.json<ErrorBody>().code, 'VFS_INVALID_PATH', `읽기 ${label}`);
    }

    // 거부한 요청은 어떤 노드도 만들지 않는다.
    const listing = await ctx.client.request(
      'GET',
      `/api/v2/namespaces/${ns}/fs/ls?path=${encodeURIComponent('/')}`,
    );
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.json<{ items: unknown[] }>().items, []);

    // 부모가 없으면 404이고 부모를 자동으로 만들지 않는다.
    const orphan = await ctx.client.putConditionalContent(ns, '/no-parent/child.txt', Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(orphan.status, 404);
    assert.equal(orphan.json<ErrorBody>().code, 'VFS_NODE_NOT_FOUND');
    assert.equal((await ctx.client.getStat(ns, '/no-parent')).status, 404);

    // 경계값: 이름이 UTF-8 255바이트면 허용한다.
    const boundary = `/${'a'.repeat(255)}`;
    const accepted = await ctx.client.putConditionalContent(ns, boundary, Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(accepted.status, 201);
  },
});
