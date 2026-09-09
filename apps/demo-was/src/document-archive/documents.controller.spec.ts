import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { DocumentsController } from './documents.controller.js';

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
    upload.mockResolvedValue({ path: '/documents/alice/a.txt', name: 'a.txt', type: 'FILE', size: 5, mimeType: 'text/plain', createdAt: '', updatedAt: '', version: 1 });

    const response = await request(app.getHttpServer())
      .put('/demo-api/documents/content?path=/a.txt')
      .set('X-Demo-User', 'alice')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(201);

    expect(response.body.path).toBe('/documents/alice/a.txt');
    expect(upload).toHaveBeenCalledTimes(1);
    const [internalPath, , metadata] = upload.mock.calls[0];
    expect(internalPath).toBe('/documents/alice/a.txt');
    expect(metadata).toEqual({ mimeType: 'text/plain', contentLength: 5 });
  });

  it('X-Demo-User 헤더가 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .put('/demo-api/documents/content?path=/a.txt')
      .send('hello')
      .expect(400);
    expect(upload).not.toHaveBeenCalled();
  });
});
