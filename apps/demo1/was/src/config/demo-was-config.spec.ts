import { loadDemoWasConfig } from './demo-was-config.js';

const REQUIRED_KEYS = ['DEMO_WAS_STORIX_BASE_URL', 'DEMO_WAS_STORIX_API_KEY'] as const;
const ALL_KEYS = [
  ...REQUIRED_KEYS,
  'DEMO_WAS_PORT',
  'DEMO_WAS_NAMESPACE_NAME',
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
      publicNamespaceName: 'demo-custom-public',
      publicUrlBase: 'http://localhost:8080',
    });
  });
});
