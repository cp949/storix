// 소비자 기대: 같은 의미의 경로 표기는 하나의 파일을 가리키고, 대소문자와 허용된 유니코드 이름은 그대로 보존된다.
// 대응 요구사항: RQ-003(경로 계약). 규칙 출처는 docs/design/05-vfs-path-contract.md.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; path: string };
}

export default defineContract({
  id: 'path-normalization',
  title: '중복 구분자·`.`·끝 `/`는 같은 파일로 정규화하고, 대소문자와 NFC 이름은 보존한다',
  rq: ['RQ-003'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const body = Buffer.from('정규화 본문', 'utf-8');

    assert.equal((await ctx.client.mkdir(ns, '/docs')).status, 201);

    // 중복 `/`, `.` 구간, 끝 `/`가 있는 표기로 만들어도 정규 경로로 식별된다.
    const created = await ctx.client.putConditionalContent(ns, '/docs//./note.txt/', body, {
      ifAbsent: true,
    });
    assert.equal(created.status, 201);
    const resource = created.json<ConditionalResult>().resource;
    assert.equal(resource.path, '/docs/note.txt');

    // 같은 의미의 다른 표기는 같은 파일 ID로 읽힌다.
    for (const spelling of ['/docs/note.txt', '/docs//note.txt', '/docs/./note.txt', '/docs/note.txt/']) {
      const read = await ctx.client.getContent(ns, spelling);
      assert.equal(read.status, 200, spelling);
      assert.deepEqual(read.bytes, body, spelling);
      assert.equal(read.headers.get('x-storix-file-id'), resource.id, spelling);
    }
    const stat = await ctx.client.getStat(ns, '/docs//./note.txt/');
    assert.equal(stat.json<{ path: string }>().path, '/docs/note.txt');

    // 정규화한 경로에 이미 있으므로 다른 표기로 다시 만들 수 없다.
    const again = await ctx.client.putConditionalContent(ns, '/docs/./note.txt', body, { ifAbsent: true });
    assert.equal(again.status, 412);

    // 대소문자는 구별한다.
    const lower = await ctx.client.putConditionalContent(ns, '/case.txt', Buffer.from('lower'), {
      ifAbsent: true,
    });
    const upper = await ctx.client.putConditionalContent(ns, '/CASE.txt', Buffer.from('UPPER'), {
      ifAbsent: true,
    });
    assert.equal(lower.status, 201);
    assert.equal(upper.status, 201);
    assert.notEqual(lower.json<ConditionalResult>().resource.id, upper.json<ConditionalResult>().resource.id);
    assert.equal((await ctx.client.getContent(ns, '/case.txt')).text(), 'lower');
    assert.equal((await ctx.client.getContent(ns, '/CASE.txt')).text(), 'UPPER');

    // NFC 한글, 공백, 이모지 이름은 변환 없이 보존된다.
    assert.equal((await ctx.client.mkdir(ns, '/한글 폴더', false)).status, 201);
    for (const name of ['/한글 폴더/문서 1.txt', '/이모지-😀.txt']) {
      assert.equal(name, name.normalize('NFC'));
      const put = await ctx.client.putConditionalContent(ns, name, Buffer.from(name), { ifAbsent: true });
      assert.equal(put.status, 201, name);
      assert.equal(put.json<ConditionalResult>().resource.path, name);
      assert.equal((await ctx.client.getContent(ns, name)).text(), name);
    }
  },
});
