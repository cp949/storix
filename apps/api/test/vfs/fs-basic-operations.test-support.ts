import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IsNull } from 'typeorm';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';

export function registerFsBasicOperationsContract(ctx: FsHttpContext) {
  describe('공통 검증', () => {
    it('존재하지 않는 namespace는 404를 반환한다', async () => {
      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${randomUUID()}/fs/stat`)
        .query({ path: '/' })
        .expect(404);

      expect(response.body).toEqual({
        code: 'NAMESPACE_NOT_FOUND',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('경로에 ..이 있으면 400 VFS_INVALID_PATH를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('invalid-path-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/a/../b' })
        .expect(400);

      expect(response.body).toEqual({
        code: 'VFS_INVALID_PATH',
        message: expect.any(String),
        path: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('복수 query path를 500 대신 400 VFS_INVALID_PATH로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('invalid-query-path-ns');
      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat?path=%2Fa&path=%2Fb`)
        .expect(400);
      expect(response.body.code).toBe('VFS_INVALID_PATH');
    });

    it('ls·stat·exists·find에서 path를 생략하면 namespace root를 대상으로 한다', async () => {
      const namespaceId = await ctx.createNamespace('omitted-path-root-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/a/b', parents: true }).expect(201);

      const listed = await request(ctx.httpServer).get(`${base}/ls`).expect(200);
      expect(listed.body.items.map((i: { name: string }) => i.name)).toEqual(['a']);
      const stat = await request(ctx.httpServer).get(`${base}/stat`).expect(200);
      expect(stat.body).toMatchObject({ path: '/', type: 'DIRECTORY' });
      expect((await request(ctx.httpServer).get(`${base}/exists`).expect(200)).body).toEqual({
        exists: true,
      });
      const found = await request(ctx.httpServer).get(`${base}/find`).expect(200);
      expect(found.body.items.map((i: { path: string }) => i.path).sort()).toEqual(['/a', '/a/b']);
    });

    it('ls·stat·exists·find에서 빈 path는 상대경로처럼 400 VFS_INVALID_PATH로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('empty-path-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const route of ['ls', 'stat', 'exists', 'find']) {
        const response = await request(ctx.httpServer).get(`${base}/${route}?path=`).expect(400);
        expect(response.body.code).toBe('VFS_INVALID_PATH');
      }
    });

    it('일반 파일 경로도 alias를 정규화하고 NFD·길이 초과를 무변경으로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('global-path-contract-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer)
        .post(`${base}/mkdir`)
        .send({ path: '/a//./b/', parents: true })
        .expect(201);
      await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a/b' }).expect(200);

      for (const path of ['/e\u0301', `/${'가'.repeat(86)}`, '/a\u0085', '/a\u202e']) {
        expect(
          (await request(ctx.httpServer).post(`${base}/mkdir`).send({ path, parents: true }).expect(400)).body
            .code,
        ).toBe('VFS_INVALID_PATH');
      }
      expect(
        (await request(ctx.httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200)).body.items.map(
          (x: { name: string }) => x.name,
        ),
      ).toEqual(['a']);
    });

    it('이동 결과 경로만 4096바이트를 넘으면 기존 파일을 보존한다', async () => {
      const namespaceId = await ctx.createNamespace('result-path-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const destination = `/${[...Array(15).fill('a'.repeat(255)), 'a'.repeat(254)].join('/')}`;
      await request(ctx.httpServer)
        .post(`${base}/mkdir`)
        .send({ path: destination, parents: true })
        .expect(201);
      await request(ctx.httpServer).post(`${base}/touch`).send({ path: '/a' }).expect(201);

      expect(
        (await request(ctx.httpServer).post(`${base}/mv`).send({ source: '/a', destination }).expect(400))
          .body.code,
      ).toBe('VFS_INVALID_PATH');
      await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200);
      expect(
        (await request(ctx.httpServer).get(`${base}/ls`).query({ path: destination }).expect(200)).body.items,
      ).toEqual([]);
    });
  });

  describe('mkdir', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성하면 201을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mkdir-basic-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/docs' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/docs', name: 'docs', type: 'DIRECTORY' });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mkdir-default-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 mkdir -p처럼 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespaceId = await ctx.createNamespace('mkdir-p-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b/c', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b/c', name: 'c' });

      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a/b' })
        .expect(200);
    });

    it('이미 존재하는 디렉터리를 parents=false로 다시 만들면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mkdir-conflict-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });
  });

  describe('ls', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespaceId = await ctx.createNamespace('ls-order-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/b' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { name: string }) => i.name)).toEqual(['a', 'b']);
      expect(response.body.nextCursor).toBeNull();
    });

    it('limit을 넘는 항목이 있으면 nextCursor로 다음 페이지를 조회할 수 있다', async () => {
      const namespaceId = await ctx.createNamespace('ls-cursor-ns');
      for (const name of ['a', 'b', 'c']) {
        await request(ctx.httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
          .send({ path: `/${name}` })
          .expect(201);
      }

      const first = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2 })
        .expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2, cursor: first.body.nextCursor })
        .expect(200);

      expect(second.body.items.map((i: { name: string }) => i.name)).toEqual(['c']);
      expect(second.body.nextCursor).toBeNull();
    });

    it.each([
      ['UUID가 아닌 id', { name: 'a', id: 'not-uuid' }],
      ['NUL이 든 name', { name: 'a\u0000b', id: '11111111-1111-4111-8111-111111111111' }],
    ])('cursor가 %s를 담으면 SQL 실행 전에 400 VFS_INVALID_CURSOR를 반환한다', async (_label, position) => {
      const namespaceId = await ctx.createNamespace('ls-invalid-position-ns');
      const cursor = Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', cursor })
        .expect(400);

      expect(response.body.code).toBe('VFS_INVALID_CURSOR');
    });

    it('cursor를 중복해서 보내면 400 VFS_INVALID_CURSOR를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('ls-duplicate-cursor-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls?path=%2F&cursor=a&cursor=b`)
        .expect(400);

      expect(response.body.code).toBe('VFS_INVALID_CURSOR');
    });

    it('잘못된 형식의 cursor는 400 VFS_INVALID_CURSOR를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('ls-invalid-cursor-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', cursor: 'not-a-valid-cursor' })
        .expect(400);

      expect(response.body).toEqual({
        code: 'VFS_INVALID_CURSOR',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('대상이 FILE이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('ls-on-file-ns');
      const rootStat = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });

      await ctx.createFileDirectly(namespaceId, rootStat.id, 'file.txt');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('존재하지 않는 경로는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('ls-missing-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/nope' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('stat / exists', () => {
    it('stat이 생성한 디렉터리 정보를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('stat-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/a', name: 'a', type: 'DIRECTORY' });
    });

    it('exists는 없는 경로에 대해 404 대신 exists:false를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('exists-false-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/nope' })
        .expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    it('exists는 있는 경로에 대해 exists:true를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('exists-true-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toEqual({ exists: true });
    });
  });

  describe('find', () => {
    it('시작 경로 하위를 재귀적으로 검색한다', async () => {
      const namespaceId = await ctx.createNamespace('find-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { path: string }) => i.path).sort()).toEqual(['/a', '/a/b']);
    });

    it('name/match/type 필터를 조합해 검색한다', async () => {
      const namespaceId = await ctx.createNamespace('find-filter-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/report-2026', parents: true })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/notes', parents: true })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/', name: 'report', match: 'contains', type: 'DIRECTORY' })
        .expect(200);

      expect(response.body.items.map((i: { name: string }) => i.name)).toEqual(['report-2026']);
    });

    it.each([
      ['UUID가 아닌 id', { name: 'a', id: 'not-uuid' }],
      ['NUL이 든 name', { name: 'a\u0000b', id: '11111111-1111-4111-8111-111111111111' }],
    ])('cursor가 %s를 담으면 SQL 실행 전에 400 VFS_INVALID_CURSOR를 반환한다', async (_label, position) => {
      const namespaceId = await ctx.createNamespace('find-invalid-position-ns');
      const cursor = Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/', cursor })
        .expect(400);

      expect(response.body.code).toBe('VFS_INVALID_CURSOR');
    });

    it('cursor를 중복해서 보내면 400 VFS_INVALID_CURSOR를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('find-duplicate-cursor-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find?path=%2F&cursor=a&cursor=b`)
        .expect(400);

      expect(response.body.code).toBe('VFS_INVALID_CURSOR');
    });

    it.each([
      ['contains', 'name=a&name=b&match=contains'],
      ['exact', 'name=a&name=b&match=exact'],
      ['match 생략', 'name=a&name=b'],
    ])('name을 중복해서 보내면(%s) 400 VFS_INVALID_QUERY를 반환한다', async (_label, query) => {
      const namespaceId = await ctx.createNamespace('find-duplicate-name-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find?path=%2F&${query}`)
        .expect(400);

      expect(response.body.code).toBe('VFS_INVALID_QUERY');
    });

    it.each(['contains', 'exact', 'prefix', 'suffix'])(
      'name에 NUL이 있으면(match=%s) SQL 실행 전에 400 VFS_INVALID_QUERY를 반환한다',
      async (match) => {
        const namespaceId = await ctx.createNamespace('find-nul-name-ns');

        const response = await request(ctx.httpServer)
          .get(`/api/v2/namespaces/${namespaceId}/fs/find?path=%2F&name=a%00b&match=${match}`)
          .expect(400);

        expect(response.body.code).toBe('VFS_INVALID_QUERY');
      },
    );

    it('빈 name은 이름 필터 없이 200을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('find-empty-name-ns');

      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find?path=%2F&name=`)
        .expect(200);
    });

    it('시작 경로가 FILE이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('find-on-file-ns');
      const rootStat = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      await ctx.createFileDirectly(namespaceId, rootStat.id, 'file.txt');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });
  });

  describe('touch', () => {
    it('없는 file을 0-byte로 생성하면 201을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('touch-create-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a.txt', name: 'a.txt', type: 'FILE', size: 0 });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('touch-no-parent-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 중간 디렉터리를 생성하며 file을 만든다', async () => {
      const namespaceId = await ctx.createNamespace('touch-parents-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b.txt', name: 'b.txt' });
    });

    it('기존 file을 다시 touch하면 200과 함께 version이 올라간다', async () => {
      const namespaceId = await ctx.createNamespace('touch-existing-ns');
      const first = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const second = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(200);

      expect(second.body.version).toBe(first.body.version + 1);
    });

    it('directory를 touch하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('touch-dir-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });
  });
}
