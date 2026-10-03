import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveSecretValues,
  SecretResolutionError,
  type SecretFailure,
} from '../../src/secrets/resolve-secret-values.js';
import type { SecretSource } from '../../src/secrets/secret-source.js';

const NO_SOURCES = { sources: [], timeoutMs: 1000 };

async function failuresOf(promise: Promise<void>): Promise<readonly SecretFailure[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      return error.failures;
    }
    throw error;
  }
  throw new Error('SecretResolutionError가 발생하지 않음');
}

describe('resolveSecretValues', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'storix-secret-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function secretFile(name: string, content: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  it('지정이 없으면 env를 바꾸지 않는다', async () => {
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY: 'plain' };

    await resolveSecretValues(env, NO_SOURCES);

    expect(env).toEqual({ STORIX_API_KEY: 'plain' });
  });

  it('X_FILE의 파일 값을 X에 쓰고 끝 줄바꿈 하나를 제거한다', async () => {
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY_FILE: secretFile('key', 'file-key\n') };

    await resolveSecretValues(env, NO_SOURCES);

    expect(env.STORIX_API_KEY).toBe('file-key');
    expect(env.STORIX_API_KEY_FILE).toBe(path.join(dir, 'key'));
  });

  it('끝의 \\r\\n 하나만 제거하고 그 밖의 공백은 보존한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_FILE: secretFile('crlf', '  key value \r\n'),
      STORIX_DB_PASSWORD_FILE: secretFile('double', 'pw\n\n'),
    };

    await resolveSecretValues(env, NO_SOURCES);

    expect(env.STORIX_API_KEY).toBe('  key value ');
    expect(env.STORIX_DB_PASSWORD).toBe('pw\n');
  });

  it('빈 X와 X_FILE을 함께 주면 파일 값으로 해석한다', async () => {
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY: '', STORIX_API_KEY_FILE: secretFile('key', 'k') };

    await resolveSecretValues(env, NO_SOURCES);

    expect(env.STORIX_API_KEY).toBe('k');
  });

  it('빈 값이 아닌 X와 X_FILE을 함께 주면 값 없이 충돌로 실패한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY: 'secret-in-env-123',
      STORIX_API_KEY_FILE: secretFile('key', 'secret-in-file-456'),
    };

    const promise = resolveSecretValues(env, NO_SOURCES);

    await expect(promise).rejects.toThrow('STORIX_API_KEY(env+file): conflict');
    await expect(promise).rejects.not.toThrow(/secret-in-(env|file)/);
  });

  it('X_FILE과 X_REF를 함께 주면 충돌로 실패한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_DB_PASSWORD_FILE: secretFile('pw', 'p'),
      STORIX_DB_PASSWORD_REF: 'fake://pw',
    };

    expect(await failuresOf(resolveSecretValues(env, NO_SOURCES))).toEqual([
      { name: 'STORIX_DB_PASSWORD', method: 'file+ref', kind: 'conflict' },
    ]);
  });

  it('없는 파일은 not-found, 디렉터리 경로는 unreadable로 실패한다', async () => {
    const subdir = path.join(dir, 'subdir');
    mkdirSync(subdir);
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_FILE: path.join(dir, 'missing'),
      STORIX_DB_PASSWORD_FILE: subdir,
    };

    expect(await failuresOf(resolveSecretValues(env, NO_SOURCES))).toEqual([
      { name: 'STORIX_API_KEY', method: 'file', kind: 'not-found' },
      { name: 'STORIX_DB_PASSWORD', method: 'file', kind: 'unreadable' },
    ]);
  });

  it('빈 파일과 줄바꿈만 있는 파일은 empty로 실패한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_FILE: secretFile('empty', ''),
      STORIX_DB_PASSWORD_FILE: secretFile('newline', '\n'),
    };

    expect(await failuresOf(resolveSecretValues(env, NO_SOURCES))).toEqual([
      { name: 'STORIX_API_KEY', method: 'file', kind: 'empty' },
      { name: 'STORIX_DB_PASSWORD', method: 'file', kind: 'empty' },
    ]);
  });

  it('실패가 하나라도 있으면 성공한 변수도 env에 쓰지 않는다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_FILE: secretFile('key', 'ok'),
      STORIX_DB_PASSWORD_FILE: path.join(dir, 'missing'),
    };

    await expect(resolveSecretValues(env, NO_SOURCES)).rejects.toThrow(SecretResolutionError);
    expect(env.STORIX_API_KEY).toBeUndefined();
  });

  it('X_REF 형식 오류, file scheme, 알 수 없는 scheme을 구분해 실패한다', async () => {
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_REF: 'no-scheme',
      STORIX_DB_PASSWORD_REF: 'file:///run/secrets/pw',
      STORIX_SENTRY_DSN_REF: 'unknown://dsn',
    };

    expect(await failuresOf(resolveSecretValues(env, NO_SOURCES))).toEqual([
      { name: 'STORIX_API_KEY', method: 'ref', kind: 'invalid-ref' },
      { name: 'STORIX_DB_PASSWORD', method: 'file', kind: 'reserved-scheme' },
      { name: 'STORIX_SENTRY_DSN', method: 'unknown', kind: 'unknown-scheme' },
    ]);
  });

  it('어댑터에 X_REF 전체와 AbortSignal을 넘기고 결과를 X에 쓴다', async () => {
    const calls: { ref: string; signal: AbortSignal }[] = [];
    const fake: SecretSource = {
      scheme: 'fake',
      resolve: async (ref, { signal }) => {
        calls.push({ ref, signal });
        return 'from-adapter';
      },
    };
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY_REF: 'fake://team/api-key' };

    await resolveSecretValues(env, { sources: [fake], timeoutMs: 1000 });

    expect(env.STORIX_API_KEY).toBe('from-adapter');
    expect(calls).toHaveLength(1);
    expect(calls[0].ref).toBe('fake://team/api-key');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('어댑터가 값을 담은 오류를 던져도 메시지에 값이 없다', async () => {
    const fake: SecretSource = {
      scheme: 'fake',
      resolve: async () => {
        throw new Error('leaked-secret-789');
      },
    };
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY_REF: 'fake://k' };

    const promise = resolveSecretValues(env, { sources: [fake], timeoutMs: 1000 });

    await expect(promise).rejects.toThrow('STORIX_API_KEY(fake): adapter-error');
    await expect(promise).rejects.not.toThrow(/leaked-secret-789/);
  });

  it('어댑터가 동기로 던지거나 문자열이 아닌 값, 빈 문자열을 돌려주면 실패한다', async () => {
    const throwsSync: SecretSource = {
      scheme: 'sync',
      resolve: () => {
        throw new Error('boom');
      },
    };
    const notString: SecretSource = { scheme: 'num', resolve: async () => 42 as unknown as string };
    const empty: SecretSource = { scheme: 'empty', resolve: async () => '' };
    const env: NodeJS.ProcessEnv = {
      STORIX_API_KEY_REF: 'sync://a',
      STORIX_DB_PASSWORD_REF: 'num://b',
      STORIX_SENTRY_DSN_REF: 'empty://c',
    };

    expect(
      await failuresOf(
        resolveSecretValues(env, { sources: [throwsSync, notString, empty], timeoutMs: 1000 }),
      ),
    ).toEqual([
      { name: 'STORIX_API_KEY', method: 'sync', kind: 'adapter-error' },
      { name: 'STORIX_DB_PASSWORD', method: 'num', kind: 'adapter-error' },
      { name: 'STORIX_SENTRY_DSN', method: 'empty', kind: 'empty' },
    ]);
  });

  it('signal을 무시하는 어댑터도 타임아웃 시점에 실패로 끝내고 signal을 abort한다', async () => {
    let received: AbortSignal | undefined;
    const hanging: SecretSource = {
      scheme: 'fake',
      resolve: (_ref, { signal }) => {
        received = signal;
        return new Promise<string>(() => undefined);
      },
    };
    const env: NodeJS.ProcessEnv = { STORIX_API_KEY_REF: 'fake://k' };

    expect(await failuresOf(resolveSecretValues(env, { sources: [hanging], timeoutMs: 20 }))).toEqual([
      { name: 'STORIX_API_KEY', method: 'fake', kind: 'timeout' },
    ]);
    expect(received?.aborted).toBe(true);
  });
});
