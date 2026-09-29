import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

// 통합 테스트용 S3 호환 스토리지. Storix의 목표 백엔드인 VersityGW(posix)를 쓴다.
// docker-compose.versitygw.yml과 같은 이미지·환경 변수 조합이다.
const VERSITYGW_IMAGE = 'docker.io/versity/versitygw:v1.8.0';
const VERSITYGW_PORT = 7070;
const ACCESS_KEY = 'storix-test';
const SECRET_KEY = 'storix-test-secret';

// 테스트가 쓰는 컨테이너 접근자만 노출한다.
export class StartedS3Container {
  constructor(private readonly container: StartedTestContainer) {}

  getHost(): string {
    return this.container.getHost();
  }

  getPort(): number {
    return this.container.getMappedPort(VERSITYGW_PORT);
  }

  getUsername(): string {
    return ACCESS_KEY;
  }

  getPassword(): string {
    return SECRET_KEY;
  }

  getNetworkNames(): string[] {
    return this.container.getNetworkNames();
  }

  getIpAddress(networkName: string): string {
    return this.container.getIpAddress(networkName);
  }

  async stop(): Promise<void> {
    await this.container.stop();
  }
}

export async function startS3Container(): Promise<StartedS3Container> {
  const container = await new GenericContainer(VERSITYGW_IMAGE)
    .withExposedPorts(VERSITYGW_PORT)
    .withEnvironment({
      ROOT_ACCESS_KEY: ACCESS_KEY,
      ROOT_SECRET_KEY: SECRET_KEY,
      VGW_BACKEND: 'posix',
      VGW_BACKEND_ARGS: '/data',
      // --health는 backend 서브커맨드보다 앞에 와야 하는 global flag라 VGW_ARGS로 전달한다.
      VGW_ARGS: '--health /health',
    })
    // posix backend는 /data가 미리 있어야 기동한다. 이미지에 없으므로 빈 파일을 복사해 디렉터리를 만든다.
    .withCopyContentToContainer([{ content: '', target: '/data/.keep' }])
    .withWaitStrategy(Wait.forHttp('/health', VERSITYGW_PORT))
    .start();
  return new StartedS3Container(container);
}
