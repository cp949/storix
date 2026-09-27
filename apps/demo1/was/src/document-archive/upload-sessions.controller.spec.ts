import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StorixApiError } from '../storix-client/storix-client.errors.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import type { UploadSessionStatus } from '../storix-client/storix-client.types.js';
import { DocumentsController } from './documents.controller.js';

const session: UploadSessionStatus = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  state: 'OPEN',
  path: '/documents/alice/large.bin',
  sizeBytes: '4',
  mimeType: 'application/octet-stream',
  condition: { ifAbsent: true },
  partSizeBytes: 4,
  partCount: 1,
  expiresAt: '2026-09-28T00:00:00.000Z',
  maxExpiresAt: '2026-10-04T00:00:00.000Z',
  parts: [],
};

describe('DocumentsController — upload sessions', () => {
  let app: INestApplication;
  const createUploadSession = jest.fn<StorixClient['createUploadSession']>();
  const getUploadSession = jest.fn<StorixClient['getUploadSession']>();
  const putUploadSessionPart = jest.fn<StorixClient['putUploadSessionPart']>();
  const completeUploadSession = jest.fn<StorixClient['completeUploadSession']>();
  const cancelUploadSession = jest.fn<StorixClient['cancelUploadSession']>();
  const id = session.sessionId;
  const route = `/demo-api/documents/upload-sessions/${id}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: {
        createUploadSession, getUploadSession, putUploadSessionPart, completeUploadSession, cancelUploadSession,
      } }],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    app.useGlobalFilters(new DomainErrorFilter());
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'req-1';
      next();
    });
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    for (const mock of [createUploadSession, getUploadSession, putUploadSessionPart, completeUploadSession, cancelUploadSession]) {
      mock.mockReset();
    }
  });

  it('생성 경로를 사용자 내부 경로로 바꾸고 사용자별 mutation scope를 보낸다', async () => {
    createUploadSession.mockResolvedValue({
      sessionId: id, state: 'OPEN', partSizeBytes: 4, partCount: 1,
      expiresAt: session.expiresAt, maxExpiresAt: session.maxExpiresAt,
    });
    await request(app.getHttpServer())
      .post('/demo-api/documents/upload-sessions')
      .set('X-Demo-User', 'alice')
      .set('Idempotency-Key', id)
      .send({ path: '/large.bin', sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true })
      .expect(201);
    expect(createUploadSession).toHaveBeenCalledWith(
      { path: '/documents/alice/large.bin', sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true },
      id, 'demo1-was:upload:alice',
    );
  });

  it.each([
    { path: 7, sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true },
    { path: { nested: true }, sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true },
    { path: '/large.bin', mimeType: 'application/octet-stream', ifAbsent: true },
    { path: '/large.bin', sizeBytes: '4', mimeType: 'application/octet-stream' },
  ])('생성 필수 필드가 잘못되면 400으로 거절한다: %j', async (body) => {
    const response = await request(app.getHttpServer())
      .post('/demo-api/documents/upload-sessions')
      .set('X-Demo-User', 'alice')
      .set('Idempotency-Key', id)
      .send(body)
      .expect(400);
    expect(response.body.code).toBe('UPLOAD_SESSION_INVALID_REQUEST');
    expect(createUploadSession).not.toHaveBeenCalled();
  });

  it('조회와 취소 응답에서 내부 경로를 제거한다', async () => {
    getUploadSession.mockResolvedValue(session);
    cancelUploadSession.mockResolvedValue({ ...session, state: 'CANCELLED' });
    const status = await request(app.getHttpServer()).get(route).set('X-Demo-User', 'alice').expect(200);
    const cancelled = await request(app.getHttpServer()).delete(route).set('X-Demo-User', 'alice').expect(200);
    expect(status.body.path).toBe('/large.bin');
    expect(cancelled.body.path).toBe('/large.bin');
    expect(getUploadSession).toHaveBeenCalledTimes(2);
  });

  it('모든 sessionId 라우트에서 타 사용자 세션을 404로 숨기고 변경을 막는다', async () => {
    getUploadSession.mockResolvedValue(session);
    const requests = [
      () => request(app.getHttpServer()).get(route),
      () => request(app.getHttpServer()).put(`${route}/parts/0`).set('Content-Type', 'application/octet-stream').send(Buffer.from('test')),
      () => request(app.getHttpServer()).post(`${route}/complete`),
      () => request(app.getHttpServer()).delete(route),
    ];
    for (const makeRequest of requests) {
      const response = await makeRequest().set('X-Demo-User', 'bob').expect(404);
      expect(response.body.code).toBe('VFS_UPLOAD_SESSION_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('alice');
    }
    expect(getUploadSession).toHaveBeenCalledTimes(4);
    expect(putUploadSessionPart).not.toHaveBeenCalled();
    expect(completeUploadSession).not.toHaveBeenCalled();
    expect(cancelUploadSession).not.toHaveBeenCalled();
  });

  it('비정규 내부 경로도 다른 사용자 세션과 동일하게 숨긴다', async () => {
    getUploadSession.mockResolvedValue({ ...session, path: '/documents/alice/../bob/secret.bin' });
    await request(app.getHttpServer()).get(route).set('X-Demo-User', 'alice').expect(404);
  });

  it('없는 세션과 타 사용자 세션은 동일한 404 응답이다', async () => {
    getUploadSession.mockResolvedValueOnce(session);
    const otherUser = await request(app.getHttpServer()).get(route).set('X-Demo-User', 'bob').expect(404);
    getUploadSession.mockRejectedValueOnce(new StorixApiError(
      404, 'VFS_UPLOAD_SESSION_NOT_FOUND', 'upstream session absent', 'upstream-1',
    ));
    const absent = await request(app.getHttpServer()).get(route).set('X-Demo-User', 'bob').expect(404);
    expect(absent.body).toEqual(otherUser.body);
  });

  it('part 스트림과 Content-Length/Type을 전달한다', async () => {
    getUploadSession.mockResolvedValue(session);
    putUploadSessionPart.mockImplementation(async (_id, _index, body) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      expect(Buffer.from(bytes).toString()).toBe('test');
      return { index: 0, sizeBytes: '4', sha256: 'a'.repeat(64), replayed: false };
    });
    await request(app.getHttpServer())
      .put(`${route}/parts/0`)
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('test'))
      .expect(200);
    expect(putUploadSessionPart.mock.calls[0][0]).toBe(id);
    expect(putUploadSessionPart.mock.calls[0][1]).toBe('0');
    expect(putUploadSessionPart.mock.calls[0][3]).toBe('4');
    expect(putUploadSessionPart.mock.calls[0][4]).toBe('application/octet-stream');
  });

  it('완료 결과의 경로와 Storix 성공 상태를 전달한다', async () => {
    getUploadSession.mockResolvedValue(session);
    completeUploadSession.mockResolvedValue({
      status: 201,
      body: {
        resource: { path: session.path, name: 'large.bin', type: 'FILE', size: 4, mimeType: session.mimeType,
          createdAt: '', updatedAt: '', version: 1, revision: 'r1.test' },
        affectedRevisions: [
          { path: '/', revision: 'r1.root' },
          { path: '/documents', revision: 'r1.documents' },
          { path: '/documents/alice', revision: 'r1.alice' },
          { path: session.path, revision: 'r1.test' },
        ],
      },
    });
    const response = await request(app.getHttpServer()).post(`${route}/complete`).set('X-Demo-User', 'alice').expect(201);
    expect(response.body.resource.path).toBe('/large.bin');
    expect(response.body.affectedRevisions.map((entry: { path: string }) => entry.path)).toEqual(['/', '/large.bin']);
  });

  it('Storix 오류 상태와 코드를 그대로 전달한다', async () => {
    getUploadSession.mockResolvedValue(session);
    putUploadSessionPart.mockRejectedValue(new StorixApiError(409, 'VFS_UPLOAD_PART_CONFLICT', 'conflict', 'upstream-1'));
    const response = await request(app.getHttpServer())
      .put(`${route}/parts/0`).set('X-Demo-User', 'alice').set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('test')).expect(409);
    expect(response.body.code).toBe('VFS_UPLOAD_PART_CONFLICT');
  });

  it('Storix 429의 Retry-After를 WAS 응답에 전달한다', async () => {
    createUploadSession.mockRejectedValue(new StorixApiError(
      429, 'VFS_UPLOAD_SESSION_LIMIT_EXCEEDED', 'limit', 'upstream-1', '1',
    ));
    const response = await request(app.getHttpServer())
      .post('/demo-api/documents/upload-sessions')
      .set('X-Demo-User', 'alice')
      .set('Idempotency-Key', id)
      .send({ path: '/large.bin', sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true })
      .expect(429);
    expect(response.body.code).toBe('VFS_UPLOAD_SESSION_LIMIT_EXCEEDED');
    expect(response.headers['retry-after']).toBe('1');
  });
});
