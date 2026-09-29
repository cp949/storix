// 소비자 기대: 서버를 재시작해도 이미 완료된 파일·디렉터리·snapshot이 바이트·revision·해시까지 그대로 조회된다.
// 대응 요구사항: RQ-006(재시작 후 조회), RQ-010(재시작 후 지속성).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract, type ApiClient } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface SnapshotMetadata {
  snapshotId: string;
}

/** 재시작 전후로 비교할 파일 상태(본문 헤더와 stat)를 읽는다. */
async function readFileState(client: ApiClient, namespaceId: string, filePath: string) {
  const content = await client.getContent(namespaceId, filePath);
  return {
    bytes: content.bytes,
    fileId: content.headers.get('x-storix-file-id'),
    revision: content.headers.get('x-storix-revision'),
    sha256: content.headers.get('x-storix-sha256'),
    stat: (await client.getStat(namespaceId, filePath)).json(),
  };
}

export default defineContract({
  id: 'restart-persistence',
  title: '서버를 재시작해도 완료된 파일·디렉터리·snapshot이 재시작 전과 같게 조회된다',
  rq: ['RQ-006', 'RQ-010'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const first = Buffer.from('첫 번째 내용', 'utf-8');
    const second = Buffer.from('교체한 내용\r\n', 'utf-8');

    // 저장·교체·디렉터리 생성·snapshot 생성을 끝낸다.
    await ctx.client.mkdir(ns, '/docs');
    const created = await ctx.client.putConditionalContent(ns, '/docs/a.txt', first, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;
    const snapshotResponse = await ctx.client.createSnapshot(ns, {
      kind: 'file',
      path: '/docs/a.txt',
      sourceRevision: v1.revision,
    });
    assert.equal(snapshotResponse.status, 201);
    const snapshot = snapshotResponse.json<SnapshotMetadata>();
    const replaced = await ctx.client.putConditionalContent(ns, '/docs/a.txt', second, {
      ifRevision: v1.revision,
    });
    assert.equal(replaced.status, 200);

    const before = {
      file: await readFileState(ctx.client, ns, '/docs/a.txt'),
      directory: (await ctx.client.getStat(ns, '/docs')).json(),
      snapshot: (await ctx.client.getSnapshot(ns, snapshot.snapshotId)).json(),
      snapshotBytes: (await ctx.client.getSnapshotContent(ns, snapshot.snapshotId)).bytes,
      snapshotList: (await ctx.client.listSnapshots(ns, v1.id)).json(),
    };
    assert.deepEqual(before.file.bytes, second);
    assert.equal(before.file.sha256, createHash('sha256').update(second).digest('hex'));

    await ctx.server.restart();

    // 재시작 뒤 같은 요청의 결과가 재시작 전과 완전히 같다.
    const after = {
      file: await readFileState(ctx.client, ns, '/docs/a.txt'),
      directory: (await ctx.client.getStat(ns, '/docs')).json(),
      snapshot: (await ctx.client.getSnapshot(ns, snapshot.snapshotId)).json(),
      snapshotBytes: (await ctx.client.getSnapshotContent(ns, snapshot.snapshotId)).bytes,
      snapshotList: (await ctx.client.listSnapshots(ns, v1.id)).json(),
    };
    assert.deepEqual(after.file, before.file);
    assert.deepEqual(after.directory, before.directory);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.deepEqual(after.snapshotBytes, first);
    assert.deepEqual(after.snapshotList, before.snapshotList);

    // 재시작 뒤에도 현재 revision을 조건으로 이어서 교체할 수 있다.
    const next = await ctx.client.putConditionalContent(
      ns,
      '/docs/a.txt',
      Buffer.from('재시작 후', 'utf-8'),
      {
        ifRevision: before.file.revision!,
      },
    );
    assert.equal(next.status, 200);
  },
});
