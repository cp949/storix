import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { DirectoriesController } from './directories.controller.js';

describe('DirectoriesController — POST /demo-api/directories', () => {
  let app: INestApplication;
  const createDirectory = jest.fn<StorixClient['createDirectory']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DirectoriesController],
      providers: [{ provide: StorixClient, useValue: { createDirectory } }],
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
    createDirectory.mockReset();
  });

  it('alice가 디렉터리를 생성하면 /documents/alice 아래 경로로 변환해 StorixClient.createDirectory를 호출한다', async () => {
    createDirectory.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/demo-api/directories')
      .set('X-Demo-User', 'alice')
      .send({ path: '/reports' })
      .expect(204);

    expect(createDirectory).toHaveBeenCalledWith('/documents/alice/reports');
  });

  it('X-Demo-User 헤더가 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer()).post('/demo-api/directories').send({ path: '/reports' }).expect(400);
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it('경로가 root를 벗어나면 403을 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/directories')
      .set('X-Demo-User', 'alice')
      .send({ path: '../bob/secret' })
      .expect(403);
    expect(createDirectory).not.toHaveBeenCalled();
  });

  it.each([[{ path: ['x'] }], [{ path: 1 }], [{ path: null }], [{}]])(
    '본문 path가 문자열이 아니면(%j) 400이고 createDirectory를 호출하지 않는다',
    async (body) => {
      const response = await request(app.getHttpServer())
        .post('/demo-api/directories')
        .set('X-Demo-User', 'alice')
        .send(body)
        .expect(400);

      expect(response.body).toMatchObject({ code: 'DEMO_INVALID_REQUEST_BODY' });
      expect(createDirectory).not.toHaveBeenCalled();
    },
  );

  it('본문 path가 빈 문자열이면 사용자 root로 해석한다', async () => {
    createDirectory.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/demo-api/directories')
      .set('X-Demo-User', 'alice')
      .send({ path: '' })
      .expect(204);

    expect(createDirectory).toHaveBeenCalledWith('/documents/alice');
  });
});
