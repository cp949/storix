import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { EntriesController } from './entries.controller.js';

describe('EntriesController', () => {
  let app: INestApplication;
  const move = jest.fn<StorixClient['move']>();
  const copy = jest.fn<StorixClient['copy']>();
  const remove = jest.fn<StorixClient['remove']>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EntriesController],
      providers: [{ provide: StorixClient, useValue: { move, copy, remove } }],
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
    move.mockReset();
    copy.mockReset();
    remove.mockReset();
  });

  it('alice가 이동을 요청하면 source/destination을 alice root 아래로 변환한다', async () => {
    move.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/demo-api/entries/move')
      .set('X-Demo-User', 'alice')
      .send({ source: '/a.txt', destination: '/archive/a.txt' })
      .expect(204);

    expect(move).toHaveBeenCalledWith('/documents/alice/a.txt', '/documents/alice/archive/a.txt');
  });

  it('destination이 root를 벗어나면 403이고 move를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/entries/move')
      .set('X-Demo-User', 'alice')
      .send({ source: '/a.txt', destination: '../bob/a.txt' })
      .expect(403);

    expect(move).not.toHaveBeenCalled();
  });

  it('bob이 복사를 요청하면 source/destination을 bob root 아래로 변환한다', async () => {
    copy.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post('/demo-api/entries/copy')
      .set('X-Demo-User', 'bob')
      .send({ source: '/notes/a.txt', destination: '/notes/a-copy.txt' })
      .expect(204);

    expect(copy).toHaveBeenCalledWith('/documents/bob/notes/a.txt', '/documents/bob/notes/a-copy.txt');
  });

  it('recursive=true를 boolean으로 변환해 remove를 호출한다', async () => {
    remove.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .delete('/demo-api/entries?path=/archive&recursive=true')
      .set('X-Demo-User', 'alice')
      .expect(204);

    expect(remove).toHaveBeenCalledWith('/documents/alice/archive', true);
  });

  it('recursive 쿼리가 없으면 false로 remove를 호출한다', async () => {
    remove.mockResolvedValue(undefined);

    await request(app.getHttpServer()).delete('/demo-api/entries?path=/a.txt').set('X-Demo-User', 'alice').expect(204);

    expect(remove).toHaveBeenCalledWith('/documents/alice/a.txt', false);
  });

  it('move의 source가 root를 벗어나면 403이고 move를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/entries/move')
      .set('X-Demo-User', 'alice')
      .send({ source: '../bob/a.txt', destination: '/archive/a.txt' })
      .expect(403);

    expect(move).not.toHaveBeenCalled();
  });

  it('copy의 source가 root를 벗어나면 403이고 copy를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/entries/copy')
      .set('X-Demo-User', 'bob')
      .send({ source: '../alice/a.txt', destination: '/notes/a-copy.txt' })
      .expect(403);

    expect(copy).not.toHaveBeenCalled();
  });

  it('copy의 destination이 root를 벗어나면 403이고 copy를 호출하지 않는다', async () => {
    await request(app.getHttpServer())
      .post('/demo-api/entries/copy')
      .set('X-Demo-User', 'bob')
      .send({ source: '/notes/a.txt', destination: '../alice/a-copy.txt' })
      .expect(403);

    expect(copy).not.toHaveBeenCalled();
  });
});
