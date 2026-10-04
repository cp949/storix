/** GET·HEAD의 공통 응답 함수가 헤더와 본문을 처리하는 방식을 Express로 검증한다. HEAD 동작은 CHANGELOG.md [Unreleased] Fixed에 기록되어 있다. */
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { isHeadRequest, sendContent } from '../../src/vfs/content-response.js';
import type { ContentHeadPayload, ContentPayload } from '../../src/vfs/content.service.js';

const head: ContentHeadPayload = {
  name: 'a.txt',
  mimeType: 'text/plain',
  status: 200,
  contentLength: 5,
  identity: { fileId: 'file-1', revision: 'r1', sha256: 'hash' },
};

// HEAD에는 stream 없는 메타데이터를 넘기고 GET에는 실제 stream을 넘긴다.
describe('sendContent HEAD 응답', () => {
  /** 같은 경로의 GET·HEAD를 비교할 Express 앱을 만든다. */
  function appWith(payload: () => ContentPayload | ContentHeadPayload) {
    const app = express();
    app.get('/is-head', (_req, res) => {
      res.send(String(isHeadRequest(res)));
    });
    app.get('/content', async (_req, res) => {
      await sendContent(res, payload(), false);
    });
    return app;
  }

  it('HEAD 요청이면 isHeadRequest가 true이고 GET 요청이면 false다', async () => {
    const app = appWith(() => head);

    expect((await request(app).get('/is-head')).text).toBe('false');
    // HEAD 응답은 body가 없으므로 'true'(4 byte)의 Content-Length로 확인한다
    expect((await request(app).head('/is-head')).headers['content-length']).toBe('4');
  });

  it('stream 없는 payload는 헤더만 쓰고 body 없이 끝낸다', async () => {
    const response = await request(appWith(() => head)).head('/content');

    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe('5');
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['x-storix-sha256']).toBe('hash');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.text ?? '').toBe('');
  });

  it('GET 요청의 stream payload는 기존대로 본문을 보낸다', async () => {
    const response = await request(
      appWith(() => ({ ...head, stream: Readable.from(Buffer.from('hello')) })),
    ).get('/content');

    expect(response.text).toBe('hello');
    expect(response.headers['content-length']).toBe('5');
  });
});
