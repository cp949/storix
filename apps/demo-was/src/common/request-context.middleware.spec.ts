import express from 'express';
import request from 'supertest';
import { requestContextMiddleware } from './request-context.middleware.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createApp() {
  const app = express();
  app.use(requestContextMiddleware);
  app.get('/probe', (req, res) => {
    res.json({ requestId: req.requestId });
  });
  return app;
}

describe('requestContextMiddleware', () => {
  it('유효한 x-request-id 헤더가 있으면 그 값을 그대로 req.requestId와 응답 헤더에 싣는다', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/probe')
      .set('x-request-id', 'client-request-id-123')
      .expect(200);

    expect(response.body).toEqual({ requestId: 'client-request-id-123' });
    expect(response.headers['x-request-id']).toBe('client-request-id-123');
  });

  it('x-request-id 헤더가 없으면 UUID를 생성해 req.requestId와 응답 헤더에 싣는다', async () => {
    const app = createApp();

    const response = await request(app).get('/probe').expect(200);

    expect(response.body.requestId).toMatch(UUID_PATTERN);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it('VALID_REQUEST_ID 정규식을 벗어나는 헤더(200자 초과)는 무시하고 UUID로 대체한다', async () => {
    const app = createApp();
    const tooLong = 'a'.repeat(201);

    const response = await request(app).get('/probe').set('x-request-id', tooLong).expect(200);

    expect(response.body.requestId).toMatch(UUID_PATTERN);
    expect(response.body.requestId).not.toBe(tooLong);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });
});
