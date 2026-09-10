import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AppModule } from './app.module.js';
import { configureBodyParsers } from './common/body-parser.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import { requestContextMiddleware } from './common/request-context.middleware.js';

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
    configureBodyParsers(app);
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  }, 120000);

  afterAll(async () => {
    await app.close();
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
});
