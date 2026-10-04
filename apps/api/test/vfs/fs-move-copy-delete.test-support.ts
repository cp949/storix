import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import request from 'supertest';

export function registerFsMoveCopyDeleteContract(ctx: FsHttpContext) {
  describe('mv', () => {
    it('같은 디렉터리 내에서 이름을 바꾸면 200과 새 경로를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-rename-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-nest-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(200);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-parents-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(200);

      expect(response.body.path).toBe('/x/y/a.txt');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/x' })
        .expect(200);
    });

    it('destinationParents 기본값 false로 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-no-parents-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/a.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('목적지 경로가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-conflict-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 이동하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-subtree-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('source가 root(/)이면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-root-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('STORIX_MAX_SYNC_MOVE_NODES를 넘는 디렉터리 이동은 시작 전에 413을 반환하고 아무것도 옮기지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('mv-limit-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(ctx.httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/big', destination: '/moved' })
        .expect(413);

      expect(response.body.code).toBe('VFS_MOVE_LIMIT_EXCEEDED');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/moved' })
        .expect(404);
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/big/5.txt' })
        .expect(200);
    });

    it('존재하지 않는 source는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('mv-missing-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/missing.txt', destination: '/x.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('cp', () => {
    it('file을 복사하면 201과 새 경로를 반환하고 원본은 그대로 남는다', async () => {
      const namespaceId = await ctx.createNamespace('cp-file-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
    });

    it('복사본이 원본과 같은 content를 서빙하고, 복사본에 write해도 원본 content는 그대로다', async () => {
      const namespaceId = await ctx.createNamespace('cp-content-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      const copiedContent = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedContent.text).toBe('hello storix');

      const stat = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/b.txt' })
        .expect(200);

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .set('If-Match', String(stat.body.version))
        .set('Content-Type', 'text/plain')
        .send('changed')
        .expect(200);

      const originalAfterWrite = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(originalAfterWrite.text).toBe('hello storix');

      const copiedAfterWrite = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedAfterWrite.text).toBe('changed');
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await ctx.createNamespace('cp-nest-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(201);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await ctx.createNamespace('cp-parents-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(201);

      expect(response.body.path).toBe('/x/y/a.txt');
    });

    it('목적지가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('cp-conflict-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('cp-subtree-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('디렉터리를 재귀적으로 복사하면 하위 file마다 새 Node를 만들고 원본은 그대로 남는다', async () => {
      const namespaceId = await ctx.createNamespace('cp-recursive-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/src/nested', parents: true })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/a.txt' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/nested/b.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/src', destination: '/dst' })
        .expect(201);

      expect(response.body.path).toBe('/dst');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/a.txt' })
        .expect(200);
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/nested/b.txt' })
        .expect(200);
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/src/a.txt' })
        .expect(200);
    });

    it('STORIX_MAX_SYNC_COPY_NODES를 넘는 recursive 복사는 시작 전에 413을 반환하고 아무것도 만들지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('cp-limit-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(ctx.httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/big', destination: '/copy' })
        .expect(413);

      expect(response.body.code).toBe('VFS_COPY_LIMIT_EXCEEDED');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/copy' })
        .expect(404);
    });

    it('root는 복사할 수 없다', async () => {
      const namespaceId = await ctx.createNamespace('cp-root-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rmdir', () => {
    it('빈 디렉터리를 삭제하면 204를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('rmdir-empty-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(204);

      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('비어 있지 않은 디렉터리는 409 VFS_DIRECTORY_NOT_EMPTY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('rmdir-nonempty-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_DIRECTORY_NOT_EMPTY');
    });

    it('FILE 대상이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('rmdir-file-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await ctx.createNamespace('rmdir-root-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rm', () => {
    it('file을 삭제하면 204를 반환하고 이후 조회에서 사라진다', async () => {
      const namespaceId = await ctx.createNamespace('rm-file-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a.txt' })
        .expect(204);

      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('recursive=false로 directory를 삭제하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('rm-dir-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('recursive=true면 하위 트리를 모두 삭제한다', async () => {
      const namespaceId = await ctx.createNamespace('rm-recursive-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a', recursive: 'true' })
        .expect(204);

      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('STORIX_MAX_SYNC_DELETE_NODES를 넘는 recursive 삭제는 시작 전에 413을 반환하고 아무것도 지우지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('rm-limit-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(ctx.httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/big', recursive: 'true' })
        .expect(413);

      expect(response.body.code).toBe('VFS_DELETE_LIMIT_EXCEEDED');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/big/1.txt' })
        .expect(200);
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await ctx.createNamespace('rm-root-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/', recursive: 'true' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });
}
