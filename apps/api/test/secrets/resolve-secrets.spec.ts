import { jest } from '@jest/globals';
import type { ImportModule } from '../../src/secrets/secret-adapter-loader.js';
import { resolveSecrets } from '../../src/secrets/resolve-secrets.js';

// 어댑터 계약: 테스트 전용 가짜 어댑터 모듈을 로더로 주입해 로더·해석·타임아웃·무로그를 함께 확인한다.
describe('resolveSecrets 어댑터 계약', () => {
  const fakeModule: ImportModule = async () => ({
    default: { scheme: 'fake', resolve: async (ref: string) => `value-of-${ref}` },
  });

  // 무로그 테스트의 spy가 단언 실패 때도 남지 않도록 복원한다.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('STORIX_SECRET_ADAPTERS의 어댑터로 X_REF를 해석한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_SECRET_ADAPTERS: 'storix-secret-fake',
      STORIX_DB_PASSWORD_REF: 'fake://db/password',
    };

    await resolveSecrets(env, fakeModule);

    expect(env.STORIX_DB_PASSWORD).toBe('value-of-fake://db/password');
  });

  it('어댑터를 지정하지 않으면 X_REF는 unknown-scheme으로 실패한다', async () => {
    await expect(resolveSecrets({ STORIX_API_KEY_REF: 'fake://k' })).rejects.toThrow(
      'STORIX_API_KEY(fake): unknown-scheme',
    );
  });

  it('STORIX_SECRET_RESOLVE_TIMEOUT_MS로 타임아웃을 바꾼다', async () => {
    const hangingModule: ImportModule = async () => ({
      default: { scheme: 'fake', resolve: () => new Promise<string>(() => undefined) },
    });
    const env: NodeJS.ProcessEnv = {
      STORIX_SECRET_ADAPTERS: 'storix-secret-fake',
      STORIX_SECRET_RESOLVE_TIMEOUT_MS: '30',
      STORIX_API_KEY_REF: 'fake://k',
    };

    await expect(resolveSecrets(env, hangingModule)).rejects.toThrow('STORIX_API_KEY(fake): timeout');
  });

  it('타임아웃 설정이 잘못되면 어댑터를 불러오기 전에 실패한다', async () => {
    const importModule = jest.fn<ImportModule>(fakeModule);
    const env: NodeJS.ProcessEnv = {
      STORIX_SECRET_ADAPTERS: 'storix-secret-fake',
      STORIX_SECRET_RESOLVE_TIMEOUT_MS: 'abc',
    };

    await expect(resolveSecrets(env, importModule)).rejects.toThrow('잘못된 정수 환경변수 값');
    expect(importModule).not.toHaveBeenCalled();
  });

  // setTimeout은 2^31-1 ms를 넘으면 1ms 뒤에 발화하므로 상한을 넘는 설정은 부팅 시 거부한다. GitHub 이슈 #15.
  it('타임아웃이 setTimeout 상한을 넘으면 어댑터를 불러오기 전에 실패한다', async () => {
    const importModule = jest.fn<ImportModule>(fakeModule);
    const env: NodeJS.ProcessEnv = {
      STORIX_SECRET_ADAPTERS: 'storix-secret-fake',
      STORIX_SECRET_RESOLVE_TIMEOUT_MS: '3000000000',
    };

    await expect(resolveSecrets(env, importModule)).rejects.toThrow('잘못된 정수 환경변수 값');
    expect(importModule).not.toHaveBeenCalled();
  });

  it('해석 중 콘솔과 표준 출력에 아무것도 쓰지 않는다', async () => {
    const spies = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
      jest.spyOn(process.stdout, 'write'),
    ];
    const env: NodeJS.ProcessEnv = {
      STORIX_SECRET_ADAPTERS: 'storix-secret-fake',
      STORIX_API_KEY_REF: 'fake://k',
    };

    await resolveSecrets(env, fakeModule);

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
