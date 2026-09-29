import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { DocumentsController } from './documents.controller.js';

describe('DocumentsController — PATCH MIME type', () => {
  let app: INestApplication;
  const setMimeType = jest.fn<StorixClient['setMimeType']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { setMimeType } }],
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

  beforeEach(() => setMimeType.mockReset());

  it('사용자 경로로 조건부 MIME 변경을 호출하고 결과 경로를 외부 경로로 반환한다', async () => {
    setMimeType.mockResolvedValue({
      path: '/documents/alice/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 5,
      mimeType: 'application/json',
      createdAt: '',
      updatedAt: '',
      version: 2,
    });

    const response = await request(app.getHttpServer())
      .patch('/demo-api/documents/mime-type')
      .set('X-Demo-User', 'alice')
      .send({ path: '/a.txt', mimeType: 'application/json' })
      .expect(200);

    expect(response.body).toMatchObject({ path: '/a.txt', mimeType: 'application/json' });
    expect(setMimeType).toHaveBeenCalledWith('/documents/alice/a.txt', 'application/json');
  });

  it('다른 사용자 경로 수정 요청을 거부하고 StorixClient를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .patch('/demo-api/documents/mime-type')
      .set('X-Demo-User', 'alice')
      .send({ path: '../bob/a.txt', mimeType: 'application/json' })
      .expect(403);

    expect(setMimeType).not.toHaveBeenCalled();
  });
});

describe('DocumentsController — PUT content', () => {
  let app: INestApplication;
  const upload = jest.fn<StorixClient['upload']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { upload } }],
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    upload.mockReset();
  });

  it('alice가 업로드하면 /documents/alice 아래 경로로 변환해 StorixClient.upload를 호출한다', async () => {
    upload.mockResolvedValue({
      path: '/documents/alice/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 5,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    const response = await request(app.getHttpServer())
      .put('/demo-api/documents/content?path=/a.txt')
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(201);

    expect(response.body.path).toBe('/a.txt');
    expect(upload).toHaveBeenCalledTimes(1);
    const [internalPath, , metadata] = upload.mock.calls[0];
    expect(internalPath).toBe('/documents/alice/a.txt');
    expect(metadata).toEqual({ mimeType: 'text/plain', contentLength: 5 });
  });

  it('같은 path 쿼리가 중복되어 배열로 들어와도 500이 아니라 첫 번째 값을 사용한다', async () => {
    upload.mockResolvedValue({
      path: '/documents/alice/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 5,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    const response = await request(app.getHttpServer())
      .put('/demo-api/documents/content?path=/a.txt&path=/b.txt')
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(201);

    expect(response.body.path).toBe('/a.txt');
    const [internalPath] = upload.mock.calls[0];
    expect(internalPath).toBe('/documents/alice/a.txt');
  });

  it('X-Demo-User 헤더가 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .put('/demo-api/documents/content?path=/a.txt')
      .send('hello')
      .expect(400);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('DocumentsController — POST download', () => {
  let app: INestApplication;
  const createDownload = jest.fn<StorixClient['createDownload']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { createDownload } }],
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createDownload.mockReset();
  });

  it('bob이 자신의 문서를 요청하면 presigned URL을 그대로 반환한다', async () => {
    createDownload.mockResolvedValue({
      url: 'http://storage.test/signed',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await request(app.getHttpServer())
      .post('/demo-api/documents/download')
      .set('X-Demo-User', 'bob')
      .send({ path: '/notes/a.txt' })
      .expect(201);

    expect(response.body).toEqual({
      url: 'http://storage.test/signed',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(createDownload).toHaveBeenCalledWith('/documents/bob/notes/a.txt');
  });

  it('body를 아예 보내지 않아도 500이 아니라 정상 처리된다', async () => {
    createDownload.mockResolvedValue({
      url: 'http://storage.test/signed',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await request(app.getHttpServer())
      .post('/demo-api/documents/download')
      .set('X-Demo-User', 'bob')
      .send();

    expect(response.status).not.toBe(500);
    expect(createDownload).toHaveBeenCalledWith('/documents/bob');
  });
});

describe('DocumentsController — publish/unpublish', () => {
  let app: INestApplication;
  const publish = jest.fn<StorixClient['publish']>();
  const unpublish = jest.fn<StorixClient['unpublish']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { publish, unpublish } }],
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    publish.mockReset();
    unpublish.mockReset();
  });

  it('alice가 자신의 문서를 발행하면 PublicLink를 반환한다', async () => {
    publish.mockResolvedValue({ url: 'http://public.test/x', publicPath: '/documents/alice/a.txt' });

    const response = await request(app.getHttpServer())
      .post('/demo-api/documents/publish?path=/a.txt')
      .set('X-Demo-User', 'alice')
      .expect(201);

    expect(response.body).toEqual({ url: 'http://public.test/x', publicPath: '/documents/alice/a.txt' });
    expect(publish).toHaveBeenCalledWith('/documents/alice/a.txt');
  });

  it('발행 취소는 204를 반환하고 원본 경로 그대로 unpublish를 호출한다', async () => {
    unpublish.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .delete('/demo-api/documents/publish?path=/a.txt')
      .set('X-Demo-User', 'alice')
      .expect(204);

    expect(unpublish).toHaveBeenCalledWith('/documents/alice/a.txt');
  });

  it('publish 경로가 root를 벗어나면 403이고 StorixClient.publish를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/documents/publish?path=../bob/secret.txt')
      .set('X-Demo-User', 'alice')
      .expect(403);

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('DocumentsController — GET list', () => {
  let app: INestApplication;
  const list = jest.fn<StorixClient['list']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { list } }],
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    list.mockReset();
  });

  it('alice의 목록 응답에서 root prefix가 제거된다', async () => {
    list.mockResolvedValue({
      items: [
        {
          path: '/documents/alice/a.txt',
          name: 'a.txt',
          type: 'FILE',
          size: 1,
          mimeType: 'text/plain',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ],
      nextCursor: 'cursor-1',
    });

    const response = await request(app.getHttpServer())
      .get('/demo-api/documents?path=/')
      .set('X-Demo-User', 'alice')
      .expect(200);

    expect(list).toHaveBeenCalledWith('/documents/alice', undefined);
    expect(response.body).toEqual({
      items: [
        {
          path: '/a.txt',
          name: 'a.txt',
          type: 'FILE',
          size: 1,
          mimeType: 'text/plain',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ],
      nextCursor: 'cursor-1',
    });
  });
});

describe('DocumentsController — GET search', () => {
  let app: INestApplication;
  const find = jest.fn<StorixClient['find']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: StorixClient, useValue: { find } }],
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    find.mockReset();
  });

  it('bob의 검색 결과에서도 root prefix가 제거된다', async () => {
    find.mockResolvedValue({
      items: [
        {
          path: '/documents/bob/notes/a.txt',
          name: 'a.txt',
          type: 'FILE',
          size: 2,
          mimeType: 'text/plain',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ],
      nextCursor: null,
    });

    const response = await request(app.getHttpServer())
      .get('/demo-api/documents/search?path=/&name=a.txt')
      .set('X-Demo-User', 'bob')
      .expect(200);

    expect(find).toHaveBeenCalledWith('/documents/bob', 'a.txt', undefined);
    expect(response.body.items[0].path).toBe('/notes/a.txt');
  });
});
