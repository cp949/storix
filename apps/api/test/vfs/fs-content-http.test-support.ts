import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { MAX_FILE_SIZE_BYTES, postChunked } from './fs-http-fixture.test-support.js';

export function registerFsContentHttpContract(ctx: FsHttpContext) {
  describe('POST/GET content', () => {
    it('없는 file에 내용을 올리면 201과 함께 size/mimeType이 반영된다', async () => {
      const namespaceId = await ctx.createNamespace('put-create-ns');

      const putResponse = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      expect(putResponse.body).toMatchObject({ path: '/a.txt', size: 12, mimeType: 'text/plain' });

      const getResponse = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('hello storix');
      expect(getResponse.headers['content-type']).toBe('text/plain');
      const stat = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(getResponse.headers['x-storix-file-id']).toBe(stat.body.id);
      expect(getResponse.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(getResponse.headers['x-storix-sha256']).toBe(
        createHash('sha256').update(getResponse.text).digest('hex'),
      );
      expect(getResponse.headers['x-storix-sha256']).toBe(stat.body.sha256);

      const range = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-4')
        .expect(206);
      expect(range.text).toBe('hello');
      expect(range.headers['content-range']).toBe('bytes 0-4/12');
      expect(range.headers['content-length']).toBe('5');
      expect(range.headers['accept-ranges']).toBe('bytes');
      expect(range.headers['x-storix-file-id']).toBe(stat.body.id);
      expect(range.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(range.headers['x-storix-sha256']).toBeUndefined();

      const rangeDownload = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-4')
        .expect(206);
      expect(rangeDownload.text).toBe('hello');
      expect(rangeDownload.headers['content-range']).toBe('bytes 0-4/12');
      expect(rangeDownload.headers['content-length']).toBe('5');
      expect(rangeDownload.headers['accept-ranges']).toBe('bytes');
      expect(rangeDownload.headers['x-storix-file-id']).toBe(stat.body.id);
      expect(rangeDownload.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(rangeDownload.headers['x-storix-sha256']).toBeUndefined();

      const download = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(download.text).toBe('hello storix');
      expect(download.headers['x-storix-file-id']).toBeUndefined();
      expect(download.headers['x-storix-revision']).toBeUndefined();
      expect(download.headers['x-storix-sha256']).toBeUndefined();
    });

    it('조회가 노드와 Blob을 읽은 뒤 교체되어도 이전 헤더와 이전 바이트를 함께 보낸다', async () => {
      const namespaceId = await ctx.createNamespace('content-read-replace-race');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const path = '/race.txt';
      const oldBytes = 'first content';
      const newBytes = 'replacement content';
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send(oldBytes)
        .expect(201);
      const oldStat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;

      const repo = ctx.app.get(VfsNodeRepository);
      const originalRead = repo.readContentFile.bind(repo);
      let signalCaptured!: () => void;
      let releaseRead!: () => void;
      const captured = new Promise<void>((resolve) => {
        signalCaptured = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let pauseOnce = true;
      const readSpy = jest
        .spyOn(repo, 'readContentFile')
        .mockImplementation(async (readNamespaceId, rootId, segments) => {
          const result = await originalRead(readNamespaceId, rootId, segments);
          if (pauseOnce && readNamespaceId === namespaceId && segments.join('/') === 'race.txt') {
            pauseOnce = false;
            signalCaptured();
            await held;
          }
          return result;
        });

      const pendingGet = request(ctx.httpServer)
        .get(`${base}/content`)
        .query({ path })
        .then((response) => response);
      try {
        await captured;
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path, force: 'true' })
          .set('Content-Type', 'text/plain')
          .send(newBytes)
          .expect(200);
      } finally {
        releaseRead();
        readSpy.mockRestore();
      }

      const raced = await pendingGet;
      expect(raced.status).toBe(200);
      expect(raced.text).toBe(oldBytes);
      expect(raced.headers['x-storix-file-id']).toBe(oldStat.id);
      expect(raced.headers['x-storix-revision']).toBe(oldStat.revision);
      expect(raced.headers['x-storix-sha256']).toBe(createHash('sha256').update(oldBytes).digest('hex'));
      expect(raced.headers['x-storix-sha256']).toBe(oldStat.sha256);

      const currentStat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200))
        .body;
      const current = await request(ctx.httpServer).get(`${base}/content`).query({ path }).expect(200);
      expect(current.text).toBe(newBytes);
      expect(current.headers['x-storix-file-id']).toBe(oldStat.id);
      expect(current.headers['x-storix-file-id']).toBe(currentStat.id);
      expect(current.headers['x-storix-revision']).toBe(currentStat.revision);
      expect(current.headers['x-storix-revision']).not.toBe(oldStat.revision);
      expect(current.headers['x-storix-sha256']).toBe(createHash('sha256').update(newBytes).digest('hex'));
      expect(current.headers['x-storix-sha256']).toBe(currentStat.sha256);
    });

    it('Range 읽기 캡처 뒤 교체되어도 206 bytes와 ID/revision이 구 버전을 가리킨다', async () => {
      const namespaceId = await ctx.createNamespace('content-range-replace-race');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const path = '/range-race.txt';
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send('old content')
        .expect(201);
      const oldStat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;

      const repo = ctx.app.get(VfsNodeRepository);
      const originalRead = repo.readContentFile.bind(repo);
      let signalCaptured!: () => void;
      let releaseRead!: () => void;
      const captured = new Promise<void>((resolve) => {
        signalCaptured = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let pauseOnce = true;
      const readSpy = jest
        .spyOn(repo, 'readContentFile')
        .mockImplementation(async (readNamespaceId, rootId, segments) => {
          const result = await originalRead(readNamespaceId, rootId, segments);
          if (pauseOnce && readNamespaceId === namespaceId && segments.join('/') === 'range-race.txt') {
            pauseOnce = false;
            signalCaptured();
            await held;
          }
          return result;
        });
      const pendingGet = request(ctx.httpServer)
        .get(`${base}/content`)
        .query({ path })
        .set('Range', 'bytes=0-2')
        .then((response) => response);
      try {
        await captured;
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path, force: 'true' })
          .set('Content-Type', 'text/plain')
          .send('new content')
          .expect(200);
      } finally {
        releaseRead();
        readSpy.mockRestore();
      }

      const raced = await pendingGet;
      expect(raced.status).toBe(206);
      expect(raced.text).toBe('old');
      expect(raced.headers['content-range']).toBe('bytes 0-2/11');
      expect(raced.headers['content-length']).toBe('3');
      expect(raced.headers['accept-ranges']).toBe('bytes');
      expect(raced.headers['x-storix-file-id']).toBe(oldStat.id);
      expect(raced.headers['x-storix-revision']).toBe(oldStat.revision);
      expect(raced.headers['x-storix-sha256']).toBeUndefined();
      const currentStat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200))
        .body;
      expect(currentStat.revision).not.toBe(oldStat.revision);
    });

    it('GET content 응답에 nosniff와 CSP 헤더가 포함된다', async () => {
      // 공개 경로뿐 아니라 인증 경로도 sendContent()를 공유하므로 같은 하드닝
      // 헤더가 적용되는지 이 표면에서도 고정해 둔다.
      const namespaceId = await ctx.createNamespace('content-header-ns');

      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      const getResponse = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.headers['x-content-type-options']).toBe('nosniff');
      expect(getResponse.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    });

    it('같은 새 경로에 동시 업로드하면 하나만 생성하고 나머지는 version conflict를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-concurrent-create-ns');
      const path = '/same-path.txt';

      const responses = await Promise.all(
        ['first', 'second'].map((content) =>
          request(ctx.httpServer)
            .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
            .query({ path })
            .set('Content-Type', 'text/plain')
            .send(content),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(responses.find((response) => response.status === 409)?.body.code).toBe('VFS_VERSION_CONFLICT');
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-no-parent-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a/b.txt' })
        .send('x')
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('directory 대상에 업로드하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-dir-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .send('x')
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('If-Match 없이 기존 file을 덮어쓰려 하면 409 VFS_VERSION_CONFLICT를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-no-if-match-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v2')
        .expect(409);

      expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
    });

    it('올바른 If-Match version이면 덮어쓴다', async () => {
      const namespaceId = await ctx.createNamespace('put-if-match-ns');
      const created = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const overwritten = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('If-Match', String(created.body.version))
        .send('version 2 content')
        .expect(200);

      expect(overwritten.body.size).toBe(Buffer.byteLength('version 2 content'));

      const getResponse = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('version 2 content');
      const stat = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(getResponse.headers['x-storix-file-id']).toBe(created.body.id);
      expect(getResponse.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(getResponse.headers['x-storix-sha256']).toBe(stat.body.sha256);
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespaceId = await ctx.createNamespace('put-force-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt', force: 'true' })
        .send('forced overwrite')
        .expect(200);

      expect(response.body.size).toBe(Buffer.byteLength('forced overwrite'));
    });

    it('If-Match가 있는데 대상이 없으면 409 VFS_VERSION_CONFLICT를 반환하고 파일을 만들지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('put-missing-if-match-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/gone.txt' })
        .set('If-Match', '3')
        .send('resurrected')
        .expect(409);

      expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/gone.txt' })
        .expect(404);
    });

    it('force=true여도 If-Match가 현재 version과 다르면 409 VFS_VERSION_CONFLICT를 반환하고 내용을 바꾸지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('put-force-mismatch-ns');
      const created = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt', force: 'true' })
        .set('If-Match', String(created.body.version + 1))
        .send('forced overwrite')
        .expect(409);

      expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
      const read = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(read.text).toBe('v1');
    });

    it('정수가 아닌 If-Match는 대상이 없어도 409 VFS_VERSION_CONFLICT를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-invalid-if-match-ns');

      for (const value of ['*', 'W/"3"']) {
        const response = await request(ctx.httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
          .query({ path: '/new.txt' })
          .set('If-Match', value)
          .send('x')
          .expect(409);
        expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
      }
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/new.txt' })
        .expect(404);
    });

    it('Content-Type이 없으면 application/octet-stream으로 저장한다', async () => {
      const namespaceId = await ctx.createNamespace('put-default-mime-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.bin' })
        .send(Buffer.from([1, 2, 3]))
        .expect(201);

      expect(response.body.mimeType).toBe('application/octet-stream');
    });

    it('Content-Length가 STORIX_MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('put-length-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/big.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(oversized)
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('chunked stream이 STORIX_MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE로 중단한다', async () => {
      const namespaceId = await ctx.createNamespace('put-chunked-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024, 1);
      const midpoint = Math.floor(oversized.length / 2);

      const response = await postChunked(
        ctx.serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big.bin')}`,
        [oversized.subarray(0, midpoint), oversized.subarray(midpoint)],
      );

      expect(response.status).toBe(413);
      expect((response.body as { code: string }).code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('namespace의 max_file_size_bytes가 전역 한도보다 작으면 그 값을 넘는 요청을 413 VFS_FILE_TOO_LARGE로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('put-namespace-limit-ns');
      const namespaceLimit = 100;
      // 전역 한도(STORIX_MAX_FILE_SIZE_BYTES=1MiB)보다는 훨씬 작지만 namespace 한도보다는 큰
      // 크기로 요청해, 실제로 namespace 한도가 적용되는지(전역 한도만 걸리는 게 아닌지)를
      // HTTP 스택 전체(라우팅~DB~에러 필터)를 통해 검증한다.
      await ctx.migrationDataSource
        .getRepository(NamespaceEntity)
        .update(namespaceId, { maxFileSizeBytes: String(namespaceLimit) });
      const root = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/ns-limited.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(namespaceLimit + 1))
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
      expect(
        await ctx.migrationDataSource
          .getRepository(VfsNodeEntity)
          .findOneBy({ namespaceId, name: 'ns-limited.bin' }),
      ).toBeNull();
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).countBy({ namespaceId })).toBe(0);
      expect(
        (await ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version,
      ).toBe(root.version);
      expect(
        String(
          (await ctx.migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId }))
            .liveFileByteCount,
        ),
      ).toBe('0');
    });

    it('GET content 대상이 없으면 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('get-missing-ns');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/nope.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('GET content 대상이 directory면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('get-dir-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('빈 body로 POST content를 호출하면 0-byte file을 생성한다', async () => {
      const namespaceId = await ctx.createNamespace('put-empty-body-ns');

      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/empty.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(201);

      expect(response.body.size).toBe(0);

      const getResponse = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/empty.bin' })
        .expect(200);

      // application/octet-stream 응답은 superagent가 res.text가 아닌 res.body(Buffer)로 파싱한다.
      expect(Buffer.isBuffer(getResponse.body)).toBe(true);
      expect(getResponse.body).toHaveLength(0);
      expect(getResponse.headers['content-length']).toBe('0');
    });

    it('업로드 도중 클라이언트가 연결을 끊어도 서버 프로세스는 살아남고 이후 요청을 정상 처리한다', async () => {
      const namespaceId = await ctx.createNamespace('put-client-abort-ns');

      await new Promise<void>((resolve) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: ctx.serverPort,
          path: `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/aborted.bin')}`,
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
        });
        // 클라이언트 쪽에서 강제로 소켓을 끊었을 때 발생하는 오류 이벤트는 이 테스트의
        // 관심사가 아니다(리스너가 없으면 Node가 미처리 예외로 취급해 테스트 프로세스가
        // 죽으므로 반드시 무시하는 리스너를 달아둔다).
        req.on('error', () => undefined);

        req.write(Buffer.alloc(64 * 1024, 1));
        req.write(Buffer.alloc(64 * 1024, 2));

        // 서버가 실제로 요청을 라우팅하고(네임스페이스/경로 조회 등 실제 DB 왕복 포함)
        // body를 소비하기 시작할 시간을 준 뒤 소켓을 강제로 파괴해, 업로드가 실제로
        // 진행되는 도중에 클라이언트 연결이 끊기는 상황(네트워크 단절, LB 타임아웃 등)을
        // 재현한다 — 너무 빨리 끊으면 서버가 요청을 라우팅하기도 전에 연결이 끊겨
        // 버그를 재현하지 못한다.
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 200);
      });

      // 서버 프로세스가 죽지 않았는지는, 완전히 무관한 이후 요청이 같은 서버에서
      // 정상적으로 처리되는지로 검증한다 — 프로세스가 죽었다면 이 요청 자체가 실패한다.
      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/still-alive.txt' })
        .expect(201);

      expect(response.body).toMatchObject({
        path: '/still-alive.txt',
        name: 'still-alive.txt',
        type: 'FILE',
      });
    });
  });

  describe('Range 요청', () => {
    async function putText(namespaceId: string, path: string, text: string) {
      return request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send(text)
        .expect(201);
    }

    it('유효한 range는 206과 Content-Range를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-valid-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=2-4')
        .expect(206);

      expect(response.text).toBe('234');
      expect(response.headers['content-range']).toBe('bytes 2-4/10');
    });

    it('열린 끝 range(bytes=5-)는 나머지 전체를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-open-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=5-')
        .expect(206);

      expect(response.text).toBe('56789');
    });

    it('suffix range(bytes=-3)는 마지막 N byte를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-suffix-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=-3')
        .expect(206);

      expect(response.text).toBe('789');
    });

    it('여러 range를 요청하면 416을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-multi-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-1,3-4')
        .expect(416);

      expect(response.body.code).toBe('VFS_RANGE_NOT_SATISFIABLE');
      expect(response.headers['content-range']).toBe('bytes */10');
      expect(response.body).toEqual({
        code: 'VFS_RANGE_NOT_SATISFIABLE',
        message: '처리할 수 없는 Range: bytes=0-1,3-4',
        requestId: response.headers['x-request-id'],
      });
    });

    it('유효하지 않은 Range 문법은 416과 전체 길이를 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-malformed-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=abc-def')
        .expect(416);

      expect(response.headers['content-range']).toBe('bytes */10');
      expect(response.body).toEqual({
        code: 'VFS_RANGE_NOT_SATISFIABLE',
        message: '처리할 수 없는 Range: bytes=abc-def',
        requestId: response.headers['x-request-id'],
      });
    });

    it('범위를 벗어난 range는 416을 반환한다', async () => {
      const namespaceId = await ctx.createNamespace('range-oob-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=100-200')
        .expect(416);

      expect(response.body.code).toBe('VFS_RANGE_NOT_SATISFIABLE');
      expect(response.headers['content-range']).toBe('bytes */10');
      expect(response.body).toEqual({
        code: 'VFS_RANGE_NOT_SATISFIABLE',
        message: '처리할 수 없는 Range: bytes=100-200',
        requestId: response.headers['x-request-id'],
      });
    });
  });

  describe('download', () => {
    it('Content-Disposition에 안전하게 인코딩한 filename을 담는다', async () => {
      const namespaceId = await ctx.createNamespace('download-ns');
      await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/보고서.txt' })
        .set('Content-Type', 'text/plain')
        .send('내용')
        .expect(201);

      const response = await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/보고서.txt' })
        .expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="___.txt"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt`,
      );
    });

    it('다운로드 도중 클라이언트가 연결을 끊어도 서버 프로세스는 살아남고 이후 요청을 정상 처리한다', async () => {
      const namespaceId = await ctx.createNamespace('download-client-abort-ns');
      // STORIX_MAX_FILE_SIZE_BYTES(1MiB) 이하에서 스트리밍 도중 끊을 시간을 벌기 위해 큼직하게 채운다.
      const content = Buffer.alloc(900 * 1024, 7);

      await postChunked(
        ctx.serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
        [content],
      );

      await new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: ctx.serverPort,
            path: `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
            method: 'GET',
          },
          () => {
            // 응답 body를 전혀 소비하지 않아(res.resume()을 호출하지 않음) 서버 쪽에
            // backpressure가 걸린 채로 스트리밍이 진행 중인 상태를 유지한 뒤 소켓을
            // 강제로 파괴해 다운로드 도중 클라이언트 연결이 끊기는 상황을 재현한다.
            setTimeout(() => {
              req.destroy();
              resolve();
            }, 100);
          },
        );
        req.on('error', () => undefined);
        req.end();
      });

      // 서버 프로세스가 죽지 않았는지는, 완전히 무관한 이후 요청이 같은 서버에서
      // 정상적으로 처리되는지로 검증한다 — 프로세스가 죽었다면 이 요청 자체가 실패한다.
      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/still-alive-after-download-abort.txt' })
        .expect(201);

      expect(response.body).toMatchObject({
        path: '/still-alive-after-download-abort.txt',
        name: 'still-alive-after-download-abort.txt',
        type: 'FILE',
      });
    });
  });
}
