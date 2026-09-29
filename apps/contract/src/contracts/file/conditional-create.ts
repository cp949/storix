// 소비자 기대: 지정 경로에 파일이 없을 때만 새로 만들 수 있고, 이미 있으면 기존 파일을 그대로 두고 충돌로 거부된다.
// 대응 요구사항: RQ-005(존재하지 않는 파일의 조건부 생성).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ConditionalResult {
  resource: { id: string; path: string; revision: string; updatedAt: string };
}

export default defineContract({
  id: 'conditional-create',
  title: '존재하지 않는 경로에만 파일을 생성하고, 있으면 기존 파일을 보존한다',
  rq: ['RQ-005'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const original = Buffer.from('첫 번째 내용', 'utf-8');

    // 없는 경로에는 생성되고 파일 ID·경로·revision·수정 시각을 돌려준다.
    const created = await ctx.client.putConditionalContent(namespace.id, '/a.txt', original, {
      ifAbsent: true,
    });
    assert.equal(created.status, 201);
    const resource = created.json<ConditionalResult>().resource;
    assert.match(resource.id, UUID);
    assert.equal(resource.path, '/a.txt');
    assert.match(resource.revision, /^r1\./);
    assert.ok(!Number.isNaN(Date.parse(resource.updatedAt)), 'updatedAt이 날짜 형식이어야 한다');

    // 이미 있으면 412로 거부하고, 충돌 시점의 기존 파일 정보를 돌려준다.
    const conflicting = await ctx.client.putConditionalContent(
      namespace.id,
      '/a.txt',
      Buffer.from('덮어쓰려는 내용', 'utf-8'),
      { ifAbsent: true },
    );
    assert.equal(conflicting.status, 412);
    assert.equal(conflicting.json<{ current: { id: string } }>().current.id, resource.id);

    // 거부된 뒤에도 기존 바이트가 그대로다.
    const read = await ctx.client.getContent(namespace.id, '/a.txt');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, original);
  },
});
