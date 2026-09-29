// 소비자 기대: 이동·복사의 없는 목적지 부모는 destinationParents를 true로 명시할 때만 만들어지고, 실패하면 부모도 만들어지지 않는다.
// 대응 요구사항: RQ-025(파일·디렉터리 이동), RQ-026(파일·디렉터리 복사).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'destination-parents',
  title:
    '이동·복사는 destinationParents를 명시할 때만 없는 목적지 부모를 만들고 실패하면 부모도 만들지 않는다',
  rq: ['RQ-025', 'RQ-026'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const exists = async (path: string): Promise<boolean> =>
      (await ctx.client.getStat(ns, path)).status === 200;
    const bytes = Buffer.from('내용', 'utf-8');
    for (const path of ['/move-me.txt', '/copy-me.txt', '/blocker.txt']) {
      assert.equal((await ctx.client.putConditionalContent(ns, path, bytes, { ifAbsent: true })).status, 201);
    }

    // 생략하거나 false이면 목적지 부모를 만들지 않고 404로 거부한다.
    for (const destinationParents of [undefined, false] as const) {
      const moved = await ctx.client.move(ns, {
        source: '/move-me.txt',
        destination: '/m1/m2/moved.txt',
        destinationParents,
      });
      assert.equal(moved.status, 404);
      assert.ok(!(await exists('/m1')), '이동이 부모를 만들면 안 된다');
      const copied = await ctx.client.copy(ns, {
        source: '/copy-me.txt',
        destination: '/c1/c2/copied.txt',
        destinationParents,
      });
      assert.equal(copied.status, 404);
      assert.ok(!(await exists('/c1')), '복사가 부모를 만들면 안 된다');
    }
    assert.ok(await exists('/move-me.txt'));

    // 목적지 경로 중간이 파일이면 destinationParents가 true여도 거부되고 원본과 트리가 그대로다.
    const rootNames = async (): Promise<string[]> =>
      (await ctx.client.listDirectory(ns, '/'))
        .json<{ items: Array<{ name: string }> }>()
        .items.map((item) => item.name)
        .sort();
    const rootBefore = await rootNames();
    const blocked = await ctx.client.move(ns, {
      source: '/move-me.txt',
      destination: '/blocker.txt/deeper/moved.txt',
      destinationParents: true,
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await rootNames(), rootBefore);
    assert.ok(await exists('/move-me.txt'));

    // true이면 부모와 대상이 모두 만들어진다.
    const moved = await ctx.client.move(ns, {
      source: '/move-me.txt',
      destination: '/m1/m2/moved.txt',
      destinationParents: true,
    });
    assert.equal(moved.status, 200);
    assert.deepEqual((await ctx.client.getContent(ns, '/m1/m2/moved.txt')).bytes, bytes);
    assert.ok(!(await exists('/move-me.txt')));
    const copied = await ctx.client.copy(ns, {
      source: '/copy-me.txt',
      destination: '/c1/c2/copied.txt',
      destinationParents: true,
    });
    assert.equal(copied.status, 201);
    assert.deepEqual((await ctx.client.getContent(ns, '/c1/c2/copied.txt')).bytes, bytes);
    assert.deepEqual((await ctx.client.getContent(ns, '/copy-me.txt')).bytes, bytes);
  },
});
