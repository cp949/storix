import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { snapshotPost as treePost } from './vfs-snapshot-tree.test-support.js';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

export function registerFsPrerequisiteContract(ctx: FsHttpContext) {
  it('capability 설정 경로가 없어도 기존 파일 저장, 조회, 내보내기, 삭제를 사용할 수 있다', async () => {
    expect(process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH).toBeUndefined();
    const namespaceId = await ctx.createNamespace('capability-empty-existing-file-api');
    const base = `/api/v2/namespaces/${namespaceId}/fs`;
    const path = '/still-available.txt';

    await request(ctx.httpServer)
      .post(`${base}/content`)
      .query({ path })
      .set('Content-Type', 'text/plain')
      .send('retained data')
      .expect(201);
    expect((await request(ctx.httpServer).get(`${base}/content`).query({ path }).expect(200)).text).toBe(
      'retained data',
    );
    expect((await request(ctx.httpServer).get(`${base}/download`).query({ path }).expect(200)).text).toBe(
      'retained data',
    );

    await request(ctx.httpServer).post(`${base}/rm`).query({ path }).expect(204);
    expect(
      (await request(ctx.httpServer).get(`${base}/exists`).query({ path }).expect(200)).body.exists,
    ).toBe(false);
  });

  it('긴 유효 경로의 TREE manifest를 저장하고 끝 항목까지 조회한다', async () => {
    const ns = await ctx.createNamespace('snapshot-long-path');
    const base = `/api/v2/namespaces/${ns}/fs`;
    let path = '';
    for (let i = 0; i < 16; i++) {
      path += `/${randomBytes(135).toString('base64url')}`;
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
    }
    expect(Buffer.byteLength(path)).toBeGreaterThan(2704);

    const captured = await treePost(ctx.app, base, '', { kind: 'tree', path: '/' }).expect(201);
    const page = await request(ctx.httpServer)
      .get(`${base}/snapshots/${captured.body.snapshotId}/entries`)
      .query({ limit: 100 })
      .expect(200);
    expect(page.body.items).toHaveLength(17);
    expect(page.body.items.at(-1).relativePath).toBe(path.slice(1));
    expect(page.body.nextCursor).toBeNull();
  });

  it.each(['snapshot', 'writer'] as const)(
    'TREE capture vs writer: PostgreSQL %s 선행은 완전한 한 시점만 고정한다',
    async (first) => {
      const ns = await ctx.createNamespace(`tree-race-${first}`);
      const base = `/api/v2/namespaces/${ns}/fs`;
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/old' }).expect(201);
      for (const name of ['a', 'b'])
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path: `/old/${name}` })
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(name))
          .expect(201);
      const before = (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200))
        .body;
      const holder = ctx.migrationDataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
        ns,
      ]);
      const pending: Promise<request.Response>[] = [];
      let completed = 0;
      const start = (operation: 'snapshot' | 'writer') => {
        const req =
          operation === 'snapshot'
            ? treePost(ctx.app, base, '', { kind: 'tree', path: '/' })
            : request(ctx.httpServer).post(`${base}/mv`).send({ source: '/old', destination: '/new' });
        pending.push(
          req.then((response) => {
            completed++;
            return response;
          }),
        );
      };
      const blocked = async (count: number) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = await ctx.migrationDataSource.query(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
            [holderPid],
          );
          if (rows.length >= count) {
            expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
            return;
          }
          if (completed) throw new Error('operation completed before root lock release');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`expected ${count} separate PostgreSQL waiters`);
      };
      try {
        start(first);
        await blocked(1);
        start(first === 'snapshot' ? 'writer' : 'snapshot');
        await blocked(2);
      } finally {
        await holder.commitTransaction();
        await holder.release();
        await Promise.all(pending);
      }
      const results = await Promise.all(pending);
      const captured = results[first === 'snapshot' ? 0 : 1];
      const writer = results[first === 'writer' ? 0 : 1];
      expect(captured.status).toBe(201);
      expect(writer.status).toBe(200);
      const after = (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200))
        .body;
      expect(after.revision).not.toBe(before.revision);
      expect(captured.body.sourceRevision).toBe(first === 'snapshot' ? before.revision : after.revision);
      const page = (
        await request(ctx.httpServer).get(`${base}/snapshots/${captured.body.snapshotId}/entries`).expect(200)
      ).body;
      expect(page.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(
        first === 'snapshot' ? ['.', 'old', 'old/a', 'old/b'] : ['.', 'new', 'new/a', 'new/b'],
      );
      expect(page.items[0].sourceRevision).toBe(captured.body.sourceRevision);
      for (const item of page.items.filter((item: { type: string }) => item.type === 'FILE')) {
        expect((await request(ctx.httpServer).get(item.contentPath).expect(200)).body).toEqual(
          Buffer.from(item.relativePath.endsWith('/a') ? 'a' : 'b'),
        );
      }
    },
  );
}
