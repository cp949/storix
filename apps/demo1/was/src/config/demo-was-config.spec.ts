import { loadDemoWasConfig } from './demo-was-config.js';

const REQUIRED_KEYS = ['DEMO_WAS_STORIX_BASE_URL', 'DEMO_WAS_STORIX_API_KEY'] as const;
const ALL_KEYS = [
  ...REQUIRED_KEYS,
  'DEMO_WAS_PORT',
  'DEMO_WAS_NAMESPACE_NAME',
  'DEMO_WAS_NAMESPACE_ID',
  'DEMO_WAS_PUBLIC_NAMESPACE_NAME',
  'DEMO_WAS_PUBLIC_URL_BASE',
] as const;

describe('loadDemoWasConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ALL_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('필수 값이 없으면 예외를 던진다', () => {
    expect(() => loadDemoWasConfig()).toThrow();
  });

  it('필수 값만 있으면 기본값으로 나머지를 채운다', () => {
    process.env.DEMO_WAS_STORIX_BASE_URL = 'http://localhost:3000';
    process.env.DEMO_WAS_STORIX_API_KEY = 'test-key';

    expect(loadDemoWasConfig()).toEqual({
      port: 4000,
      storixBaseUrl: 'http://localhost:3000',
      storixApiKey: 'test-key',
      namespaceName: 'demo',
      namespaceId: undefined,
      publicNamespaceName: 'demo-public',
      publicUrlBase: 'http://localhost:3000',
    });
  });

  it('오버라이드 값을 그대로 사용한다', () => {
    process.env.DEMO_WAS_STORIX_BASE_URL = 'http://storix:3000';
    process.env.DEMO_WAS_STORIX_API_KEY = 'key';
    process.env.DEMO_WAS_PORT = '5000';
    process.env.DEMO_WAS_NAMESPACE_NAME = 'demo-custom';
    process.env.DEMO_WAS_PUBLIC_NAMESPACE_NAME = 'demo-custom-public';
    process.env.DEMO_WAS_PUBLIC_URL_BASE = 'http://localhost:8080';

    expect(loadDemoWasConfig()).toEqual({
      port: 5000,
      storixBaseUrl: 'http://storix:3000',
      storixApiKey: 'key',
      namespaceName: 'demo-custom',
      namespaceId: undefined,
      publicNamespaceName: 'demo-custom-public',
      publicUrlBase: 'http://localhost:8080',
    });
  });

  it.each(['4000abc', '0x1F90', '1e3', '65536'])('DEMO_WAS_PORT가 %j면 설정 로딩을 거부한다', (value) => {
    process.env.DEMO_WAS_STORIX_BASE_URL = 'http://localhost:3000';
    process.env.DEMO_WAS_STORIX_API_KEY = 'test-key';
    process.env.DEMO_WAS_PORT = value;

    expect(() => loadDemoWasConfig()).toThrow('잘못된 정수 환경변수 값');
  });

  it('고정 private namespace UUID를 읽는다', () => {
    process.env.DEMO_WAS_STORIX_BASE_URL = 'http://localhost:3000';
    process.env.DEMO_WAS_STORIX_API_KEY = 'test-key';
    process.env.DEMO_WAS_NAMESPACE_ID = '63f238da-3f8d-482d-a384-7995994271dc';

    expect(loadDemoWasConfig().namespaceId).toBe('63f238da-3f8d-482d-a384-7995994271dc');
  });

  it.each(['not-a-uuid', ' 63f238da-3f8d-482d-a384-7995994271dc', '63F238DA-3F8D-482D-A384-7995994271DC'])(
    '잘못된 private namespace ID 형식 %s는 시작 시 거부한다',
    (value) => {
      process.env.DEMO_WAS_STORIX_BASE_URL = 'http://localhost:3000';
      process.env.DEMO_WAS_STORIX_API_KEY = 'test-key';
      process.env.DEMO_WAS_NAMESPACE_ID = value;

      expect(() => loadDemoWasConfig()).toThrow(/DEMO_WAS_NAMESPACE_ID/);
    },
  );
});
