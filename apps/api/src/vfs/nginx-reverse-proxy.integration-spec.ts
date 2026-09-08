import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { VfsModule } from './vfs.module.js';

const MASTER_KEY_HEX = 'cd'.repeat(32);
const __dirname = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF_PATH = resolve(__dirname, '../../../../docs/deployment/nginx-reverse-proxy.conf');

function generateSelfSignedCert(): { certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'storix-nginx-cert-'));
  const certPath = join(dir, 'nginx.crt');
  const keyPath = join(dir, 'nginx.key');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return { certPath, keyPath };
}

interface InsecureResponse {
  readonly status: number;
  text(): Promise<string>;
}

// self-signed 테스트 인증서 전용. 전역 fetch() + NODE_TLS_REJECT_UNAUTHORIZED
// 토글은 이 저장소의 Jest(ts-jest ESM) 환경에서 undici의 전역 dispatcher가 그
// env var 변경 시점보다 먼저 초기화돼 있어 반영되지 않는다(Task2 구현 중
// 실측 확인). node:https에 요청별로 rejectUnauthorized:false를 직접 넘기면
// 전역 상태를 건드리지 않고도 이 호출 하나만 범위를 좁혀 우회할 수 있다.
function fetchInsecure(url: string, init?: { method?: string }): Promise<InsecureResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: init?.method ?? 'GET', rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('nginx reverse-proxy 경유 presigned download (STORAGE-03)', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let nginxContainer: StartedTestContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    minioContainer = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();

    // 커스텀 Network()를 만들지 않는다 — 새 CNI 네트워크 생성이 일부 podman
    // 환경(예: cniVersion 불일치)에서 깨질 수 있다. 대신 minio/postgres가 기본으로
    // 붙는 default 네트워크에서 minio의 실제 IP를 읽어(getNetworkNames()로 이름을
    // 하드코딩하지 않는다 — docker의 기본 네트워크 이름 "bridge"와 podman의 "podman"이
    // 다르다) nginx 컨테이너에 /etc/hosts 항목으로 주입한다. nginx.conf의
    // `proxy_pass http://minio:9000;`는 그대로 두고, "minio"가 어디로 풀리는지만
    // 컨테이너별로 바꾼다 — DNS 별칭 대신 정적 hosts 매핑이라 커스텀 네트워크가
    // 필요 없다.
    const minioNetworkName = minioContainer.getNetworkNames()[0];
    const minioIp = minioContainer.getIpAddress(minioNetworkName);

    const { certPath, keyPath } = generateSelfSignedCert();
    nginxContainer = await new GenericContainer('nginx:1.27-alpine')
      // nginx:1.27-alpine 이미지 자체가 Config.ExposedPorts에 80을 선언하고 있어서
      // (base 이미지 Dockerfile의 EXPOSE 80), 443만 요청해도 컨테이너 준비 판정
      // 로직이 80의 host binding까지 기다리는 환경이 있다 — 80도 같이 요청해
      // 그 경로를 피한다. 커스텀 conf가 80을 리슨하지 않으므로 기본
      // HostPortWaitStrategy(포트 TCP 접속 대기) 대신 nginx 워커 기동 로그로
      // 준비 완료를 판정한다.
      .withExposedPorts(80, 443)
      .withExtraHosts([{ host: 'minio', ipAddress: minioIp }])
      .withCopyFilesToContainer([
        { source: certPath, target: '/etc/nginx/certs/nginx.crt' },
        { source: keyPath, target: '/etc/nginx/certs/nginx.key' },
        { source: NGINX_CONF_PATH, target: '/etc/nginx/conf.d/default.conf' },
      ])
      .withWaitStrategy(Wait.forLogMessage(/start worker process/))
      .start();

    process.env.STORIX_DB_HOST = postgresContainer.getHost();
    process.env.STORIX_DB_PORT = String(postgresContainer.getPort());
    process.env.STORIX_DB_USERNAME = postgresContainer.getUsername();
    process.env.STORIX_DB_PASSWORD = postgresContainer.getPassword();
    process.env.STORIX_DB_NAME = postgresContainer.getDatabase();
    process.env.STORIX_STORAGE_ENDPOINT = minioContainer.getHost();
    process.env.STORIX_STORAGE_PORT = String(minioContainer.getPort());
    process.env.STORIX_STORAGE_USE_SSL = 'false';
    process.env.STORIX_STORAGE_ACCESS_KEY = minioContainer.getUsername();
    process.env.STORIX_STORAGE_SECRET_KEY = minioContainer.getPassword();
    process.env.STORIX_STORAGE_BUCKET = 'storix-nginx-proxy-test';
    // 이 값들이 presigned URL 서명에 들어간다 — 이 테스트가 nginx에 접근할 때
    // 쓰는 host/port/scheme과 반드시 일치해야 한다.
    process.env.STORIX_STORAGE_PUBLIC_ENDPOINT = nginxContainer.getHost();
    process.env.STORIX_STORAGE_PUBLIC_PORT = String(nginxContainer.getMappedPort(443));
    process.env.STORIX_STORAGE_PUBLIC_USE_SSL = 'true';
    // STORIX_STORAGE_REGION을 비워두면 minio-js가 리전 자동조회(getBucketRegionAsync)를
    // presignedClient(자체 self-signed 인증서를 쓰는 nginx)로 실제 HTTPS 요청해
    // rejectUnauthorized 기본값(true) 때문에 인증서 검증에서 그대로 실패한다
    // (Task 1이 컨테이너 loopback 시나리오에서 같은 근본 원인의 다른 증상을
    // 실측했다). region을 명시하면 이 요청 자체가 스킵된다.
    process.env.STORIX_STORAGE_REGION = 'us-east-1';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(1024 * 1024 * 1024);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '1000';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '1000';
    process.env.STORIX_PRESIGNED_URL_EXPIRY_SECONDS = '300';
    process.env.STORIX_ENCRYPTION_MASTER_KEY = MASTER_KEY_HEX;

    const minioClient = new MinioClient({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await minioClient.makeBucket(process.env.STORIX_STORAGE_BUCKET);

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: postgresContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [
        InitSchema1788637362016,
        AddIdempotencyKey1788700000000,
        AddBlobZeroSince1788800000000,
        AddNamespaceResourceLimits1789000000000,
        AddEncryptionSupport1789100000000,
      ],
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    httpServer = app.getHttpServer();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
    await nginxContainer.stop();
  });

  async function createNamespace(name: string): Promise<string> {
    const response = await request(httpServer)
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    return response.body.id;
  }

  it('nginx를 경유해도 presigned URL로 원본 콘텐츠를 받을 수 있다(Host 헤더/쿼리스트링 통과, scheme/port 일치)', async () => {
    const namespaceId = await createNamespace(`nginx-proxy-ok-${randomUUID()}`);
    const content = 'hello through nginx';

    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/report.txt' })
      .set('Content-Type', 'text/plain')
      .send(content)
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/report.txt' })
      .expect(200);

    const presignedUrl = response.body.url as string;
    expect(presignedUrl.startsWith('https://')).toBe(true);

    const fetched = await fetchInsecure(presignedUrl);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(content);
  });

  it('GET 이외 메서드는 nginx가 403으로 차단한다', async () => {
    const namespaceId = await createNamespace(`nginx-proxy-method-${randomUUID()}`);
    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/report.txt' })
      .set('Content-Type', 'text/plain')
      .send('irrelevant')
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/report.txt' })
      .expect(200);

    const fetched = await fetchInsecure(response.body.url as string, { method: 'DELETE' });
    expect(fetched.status).toBe(403);
  });
});
