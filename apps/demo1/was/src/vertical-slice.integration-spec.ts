import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from './app.module.js';
import { configureHttpPipeline } from './common/http-pipeline.js';
import { StorixClient } from './storix-client/storix-client.service.js';
import { StorixHttpClient } from './storix-client/storix-http.client.js';
import type { UploadSessionCreated, UploadSessionStatus } from './storix-client/storix-client.types.js';

const REQUIRED_ENV = ['DEMO_WAS_STORIX_BASE_URL', 'DEMO_WAS_STORIX_API_KEY'] as const;

function ensureRealStorixConfigured(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `실제 Storix 인스턴스 정보가 없음(${missing.join(', ')} 미설정). 먼저 기존 product compose로 ` +
        'Storix를 띄운 뒤(docker compose -f docker-compose.yml -f docker-compose.postgres.yml ' +
        '-f docker-compose.versitygw.yml up -d --wait) 이 값들을 설정하고 다시 실행한다.',
    );
  }
}

describe('Demo WAS ↔ 실제 Storix vertical slice', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ensureRealStorixConfigured();
    // 고정 Idempotency-Key(프로덕션 요구사항)로 namespace를 생성하므로, namespace 이름도
    // 고정해야 재실행 시 같은 요청 본문이 되어 IdempotencyKeyReusedError를 피할 수 있다.
    process.env.DEMO_WAS_NAMESPACE_NAME ??= 'demo-it';
    process.env.DEMO_WAS_PUBLIC_NAMESPACE_NAME ??= 'demo-it-public';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpPipeline(app);
    await app.init();
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('업로드 → 인가된 presigned 다운로드 → 공개 발행 → 무인증 다운로드 → 발행 취소 → 404', async () => {
    // namespace를 고정 재사용하므로, 파일 경로까지 고정이면 이전 실행의 잔여 상태와 부딪힌다.
    const documentPath = `/report-${Date.now()}.txt`;
    const content = Buffer.from('storix demo vertical slice fixture');
    const expectedSha256 = createHash('sha256').update(content).digest('hex');

    await request(app.getHttpServer())
      .put(`/demo-api/documents/content?path=${documentPath}`)
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'text/plain')
      .send(content)
      .expect(201);

    const downloadResponse = await request(app.getHttpServer())
      .post('/demo-api/documents/download')
      .set('X-Demo-User', 'alice')
      .send({ path: documentPath })
      .expect(201);

    const presignedGet = await fetch(downloadResponse.body.url as string);
    expect(presignedGet.status).toBe(200);
    const presignedBytes = Buffer.from(await presignedGet.arrayBuffer());
    expect(createHash('sha256').update(presignedBytes).digest('hex')).toBe(expectedSha256);

    const publishResponse = await request(app.getHttpServer())
      .post(`/demo-api/documents/publish?path=${documentPath}`)
      .set('X-Demo-User', 'alice')
      .expect(201);

    const publicGet = await fetch(publishResponse.body.url as string);
    expect(publicGet.status).toBe(200);
    const publicBytes = Buffer.from(await publicGet.arrayBuffer());
    expect(createHash('sha256').update(publicBytes).digest('hex')).toBe(expectedSha256);

    await request(app.getHttpServer())
      .delete(`/demo-api/documents/publish?path=${documentPath}`)
      .set('X-Demo-User', 'alice')
      .expect(204);

    const afterUnpublish = await fetch(publishResponse.body.url as string);
    expect(afterUnpublish.status).toBe(404);
  }, 60000);

  it('Alice의 문서를 X-Demo-User 없이 요청하면 400이다(공개 발행 전까지는 인증 필요)', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/documents/download')
      .send({ path: '/report.txt' })
      .expect(400);
  });

  it('디렉터리 생성 → 업로드 → MIME 변경 → 목록 → 검색 → 복사 → 이동 → bob의 경로 이탈 요청은 403 → 재귀 삭제', async () => {
    const dirPath = `/reports-${Date.now()}`;
    const filePath = `${dirPath}/big.bin`;
    const copyPath = `${dirPath}/big-copy.bin`;
    const movedPath = `${dirPath}/renamed.bin`;
    const content = Buffer.from('storix demo entries vertical slice fixture');

    await request(app.getHttpServer())
      .post('/demo-api/directories')
      .set('X-Demo-User', 'alice')
      .send({ path: dirPath })
      .expect(204);

    await request(app.getHttpServer())
      .put(`/demo-api/documents/content?path=${filePath}`)
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'application/octet-stream')
      .send(content)
      .expect(201);

    const mimeTypeUpdate = await request(app.getHttpServer())
      .patch('/demo-api/documents/mime-type')
      .set('X-Demo-User', 'alice')
      .send({ path: filePath, mimeType: 'application/pdf' })
      .expect(200);
    expect(mimeTypeUpdate.body.path).toBe(filePath);
    expect(mimeTypeUpdate.body.mimeType).toBe('application/pdf');

    const listResponse = await request(app.getHttpServer())
      .get(`/demo-api/documents?path=${dirPath}`)
      .set('X-Demo-User', 'alice')
      .expect(200);
    expect(
      listResponse.body.items.some(
        (item: { path: string; mimeType: string }) =>
          item.path === filePath && item.mimeType === 'application/pdf',
      ),
    ).toBe(true);

    const searchResponse = await request(app.getHttpServer())
      .get('/demo-api/documents/search?path=/&name=big.bin')
      .set('X-Demo-User', 'alice')
      .expect(200);
    expect(searchResponse.body.items.map((item: { path: string }) => item.path)).toContain(filePath);

    await request(app.getHttpServer())
      .post('/demo-api/entries/copy')
      .set('X-Demo-User', 'alice')
      .send({ source: filePath, destination: copyPath })
      .expect(204);

    await request(app.getHttpServer())
      .post('/demo-api/entries/move')
      .set('X-Demo-User', 'alice')
      .send({ source: copyPath, destination: movedPath })
      .expect(204);

    await request(app.getHttpServer())
      .post('/demo-api/documents/download')
      .set('X-Demo-User', 'bob')
      .send({ path: `../alice${filePath}` })
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/demo-api/entries?path=${dirPath}&recursive=true`)
      .set('X-Demo-User', 'alice')
      .expect(204);

    const afterDelete = await request(app.getHttpServer())
      .get(`/demo-api/documents?path=${dirPath}`)
      .set('X-Demo-User', 'alice')
      .expect(404);
    expect(afterDelete.body.code).toBe('VFS_NODE_NOT_FOUND');
  }, 60000);

  it('capability 확인 → 조각 재전송 → 상태 기반 재개 → 완료 → 전체 바이트·SHA-256 확인 → 정리', async () => {
    const namespaceId = await app.get(StorixClient).ensureDemoNamespace();
    const discovery = await app.get(StorixHttpClient).requestJson<{ capabilities: string[] }>({
      method: 'GET',
      path: `/api/v2/namespaces/${namespaceId}/capabilities`,
    });
    if (!discovery.capabilities.includes('resumable-upload')) {
      throw new Error(
        '실제 Storix vertical-slice 사전 조건 실패: private namespace에 resumable-upload capability가 활성화되어야 한다. apps/demo1/README.md의 설정 절차를 확인한다.',
      );
    }

    const dirPath = `/resumable-it-${randomUUID()}`;
    const filePath = `${dirPath}/resumed.bin`;
    const activeSessions = new Set<string>();
    let directoryCreationAttempted = false;
    const server = app.getHttpServer();
    const createSession = async (
      path: string,
      sizeBytes: number,
      sha256?: string,
    ): Promise<UploadSessionCreated> => {
      const response = await request(server)
        .post('/demo-api/documents/upload-sessions')
        .set('X-Demo-User', 'alice')
        .set('Idempotency-Key', randomUUID())
        .send({
          path,
          sizeBytes: String(sizeBytes),
          mimeType: 'application/octet-stream',
          ifAbsent: true,
          ...(sha256 ? { sha256 } : {}),
        })
        .expect(201);
      const created = response.body as UploadSessionCreated;
      activeSessions.add(created.sessionId);
      return created;
    };
    const sessionRoute = (sessionId: string) => `/demo-api/documents/upload-sessions/${sessionId}`;

    try {
      const beforeCreate = await request(server)
        .get('/demo-api/documents')
        .query({ path: dirPath })
        .set('X-Demo-User', 'alice')
        .expect(404);
      expect(beforeCreate.body.code).toBe('VFS_NODE_NOT_FOUND');
      directoryCreationAttempted = true;
      await request(server)
        .post('/demo-api/directories')
        .set('X-Demo-User', 'alice')
        .send({ path: dirPath })
        .expect(204);

      // 서버 정책의 partSizeBytes를 WAS를 통해 얻는다. 2개 조각을 만드는 데 필요한
      // 테스트 바이트가 과도하면 로컬 데모 정책을 조정하도록 명확히 실패한다.
      const probe = await createSession(`${dirPath}/probe.bin`, 1);
      const partSize = probe.partSizeBytes;
      await request(server).delete(sessionRoute(probe.sessionId)).set('X-Demo-User', 'alice').expect(200);
      activeSessions.delete(probe.sessionId);
      if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 32 * 1024 * 1024) {
        throw new Error(
          '실제 Storix vertical-slice 사전 조건 실패: partSizeBytes는 1~33554432이어야 한다. 테스트용 upload-session 정책을 확인한다.',
        );
      }

      const content = Buffer.alloc(partSize + 1, 0x61);
      content[partSize] = 0x62;
      const expectedSha256 = createHash('sha256').update(content).digest('hex');
      const firstPart = content.subarray(0, partSize);
      const firstPartSha256 = createHash('sha256').update(firstPart).digest('hex');
      const created = await createSession(filePath, content.length, expectedSha256);
      expect(created.state).toBe('OPEN');
      expect(created.partSizeBytes).toBe(partSize);
      expect(created.partCount).toBe(2);
      const route = sessionRoute(created.sessionId);

      const saved = await request(server)
        .put(`${route}/parts/0`)
        .set('X-Demo-User', 'alice')
        .set('Content-Type', 'application/octet-stream')
        .send(firstPart)
        .expect(200);
      expect(saved.body).toMatchObject({
        index: 0,
        sizeBytes: String(partSize),
        sha256: firstPartSha256,
        replayed: false,
      });

      const replayed = await request(server)
        .put(`${route}/parts/0`)
        .set('X-Demo-User', 'alice')
        .set('Content-Type', 'application/octet-stream')
        .send(firstPart)
        .expect(200);
      expect(replayed.body).toMatchObject({
        index: 0,
        sizeBytes: String(partSize),
        sha256: firstPartSha256,
        replayed: true,
      });

      // index 1은 보내지 않은 채 상태를 다시 조회해 서버에 저장된 index만 재사용한다.
      const resumed = await request(server).get(route).set('X-Demo-User', 'alice').expect(200);
      const status = resumed.body as UploadSessionStatus;
      expect(status).toMatchObject({
        state: 'OPEN',
        path: filePath,
        sizeBytes: String(content.length),
        partCount: 2,
      });
      expect(status.parts).toEqual([{ index: 0, sizeBytes: String(partSize) }]);
      const storedIndexes = new Set(status.parts.map((part) => part.index));
      for (let index = 0; index < created.partCount; index += 1) {
        if (storedIndexes.has(index)) continue;
        const part = content.subarray(index * partSize, Math.min(content.length, (index + 1) * partSize));
        const result = await request(server)
          .put(`${route}/parts/${index}`)
          .set('X-Demo-User', 'alice')
          .set('Content-Type', 'application/octet-stream')
          .send(part)
          .expect(200);
        expect(result.body).toMatchObject({ index, sizeBytes: String(part.length), replayed: false });
      }

      const complete = await request(server)
        .post(`${route}/complete`)
        .set('X-Demo-User', 'alice')
        .expect(201);
      activeSessions.delete(created.sessionId);
      expect(complete.body.resource.path).toBe(filePath);
      const listed = await request(server)
        .get('/demo-api/documents')
        .query({ path: dirPath })
        .set('X-Demo-User', 'alice')
        .expect(200);
      expect(listed.body.items.map((item: { path: string }) => item.path)).toContain(filePath);

      const download = await request(server)
        .post('/demo-api/documents/download')
        .set('X-Demo-User', 'alice')
        .send({ path: filePath })
        .expect(201);
      const downloaded = await fetch(download.body.url as string);
      expect(downloaded.status).toBe(200);
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      expect(bytes.equals(content)).toBe(true);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    } finally {
      try {
        for (const sessionId of activeSessions) {
          await request(server).delete(sessionRoute(sessionId)).set('X-Demo-User', 'alice').expect(200);
        }
      } finally {
        if (directoryCreationAttempted) {
          const remaining = await request(server)
            .get('/demo-api/documents')
            .query({ path: dirPath })
            .set('X-Demo-User', 'alice');
          if (remaining.status === 200) {
            await request(server)
              .delete('/demo-api/entries')
              .query({ path: dirPath, recursive: true })
              .set('X-Demo-User', 'alice')
              .expect(204);
          } else {
            expect(remaining.status).toBe(404);
          }
        }
      }
    }
  }, 120000);
});
