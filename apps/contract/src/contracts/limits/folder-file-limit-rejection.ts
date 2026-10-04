// 소비자 기대: 폴더가 직접 담는 파일 수 상한을 넘는 생성·이동·복사·복구는 한도 유형을 알 수 있는 오류로 거부되고 아무것도 바뀌지 않는다. 디렉터리 생성과 기존 파일 교체는 상한에 걸리지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

export default defineContract({
  id: 'folder-file-limit-rejection',
  title:
    '폴더 파일 수 상한을 넘는 생성·이동·복사·복구는 413 VFS_FOLDER_FILE_LIMIT_EXCEEDED로 거부하고 무변경이다',
  rq: ['RQ-017', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const settings = await ctx.client.request('PATCH', `/api/v2/admin/namespaces/${ns}/settings`, {
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ maxFilesPerFolder: '2', trashEnabled: true }),
    });
    assert.equal(settings.status, 200, settings.text());

    const store = async (path: string, text: string): Promise<ApiResponse> =>
      ctx.client.putConditionalContent(ns, path, Buffer.from(text, 'utf-8'), { ifAbsent: true });
    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const assertFolderLimit = (response: ApiResponse, label: string): void => {
      assert.equal(response.status, 413, `${label}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_FOLDER_FILE_LIMIT_EXCEEDED', label);
    };

    // /full은 직접 하위 파일 두 개로 가득 찬다. 밖에는 이동·복사 원본이 있다.
    assert.equal((await ctx.client.mkdir(ns, '/full')).status, 201);
    assert.equal((await store('/full/a.txt', 'a')).status, 201);
    assert.equal((await store('/full/b.txt', 'b')).status, 201);
    assert.equal((await store('/outside.txt', 'out')).status, 201);
    const fullRevision = await revisionOf('/full');

    // 세 번째 파일은 어떤 경로로 만들어도 거부되고 경로가 생기지 않는다.
    const touched = await ctx.client.request('POST', `/api/v2/namespaces/${ns}/fs/touch`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/full/c.txt' }),
    });
    assertFolderLimit(touched, 'touch');
    assertFolderLimit(await store('/full/c.txt', 'c'), '조건부 저장');
    assertFolderLimit(
      await ctx.client.move(ns, { source: '/outside.txt', destination: '/full/moved.txt' }),
      'mv',
    );
    assertFolderLimit(
      await ctx.client.copy(ns, { source: '/outside.txt', destination: '/full/copied.txt' }),
      'cp',
    );
    assertFolderLimit(
      await ctx.client.postMutation(ns, {
        kind: 'move',
        source: '/outside.txt',
        destination: '/full/moved.txt',
        sourceRevision: await revisionOf('/outside.txt'),
        destinationAbsent: true,
        destinationResolution: 'exact',
      }),
      'mutations move',
    );
    for (const path of ['/full/c.txt', '/full/moved.txt', '/full/copied.txt']) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 404, `${path}가 생기면 안 된다`);
    }
    assert.equal((await ctx.client.getStat(ns, '/outside.txt')).status, 200);
    assert.equal(await revisionOf('/full'), fullRevision);

    // 디렉터리 생성과 기존 파일 교체는 파일 수를 늘리지 않으므로 상한에 걸리지 않는다.
    assert.equal((await ctx.client.mkdir(ns, '/full/sub')).status, 201);
    const replaced = await ctx.client.putConditionalContent(ns, '/full/a.txt', Buffer.from('교체', 'utf-8'), {
      ifRevision: await revisionOf('/full/a.txt'),
    });
    assert.equal(replaced.status, 200, replaced.text());

    // 휴지통에서 복구한 파일이 가득 찬 폴더에 다시 들어가려 해도 거부되고 항목이 남는다.
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/full/b.txt',
      ifRevision: await revisionOf('/full/b.txt'),
      recursive: false,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const trashId = deleted.json<{ trashId: string }>().trashId;
    assert.equal((await store('/full/d.txt', 'd')).status, 201);
    assertFolderLimit(await ctx.client.restoreTrash(ns, trashId, {}), '휴지통 복구');
    assert.equal((await ctx.client.getStat(ns, '/full/b.txt')).status, 404);
    const items = (await ctx.client.listTrash(ns)).json<{ items: Array<{ trashId: string }> }>().items;
    assert.deepEqual(
      items.map((item) => item.trashId),
      [trashId],
    );
  },
});
