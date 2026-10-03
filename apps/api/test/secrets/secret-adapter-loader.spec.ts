import { jest } from '@jest/globals';
import {
  loadSecretAdapters,
  parseAdapterSpecifiers,
  SecretAdapterLoadError,
  type AdapterLoadFailure,
  type ImportModule,
} from '../../src/secrets/secret-adapter-loader.js';

const fakeSource = (scheme: string) => ({ scheme, resolve: async () => 'v' });

async function loadFailures(promise: Promise<unknown>): Promise<readonly AdapterLoadFailure[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SecretAdapterLoadError) {
      return error.failures;
    }
    throw error;
  }
  throw new Error('SecretAdapterLoadError가 발생하지 않음');
}

describe('parseAdapterSpecifiers', () => {
  it('쉼표로 나누고 공백과 빈 항목을 버린다', () => {
    expect(parseAdapterSpecifiers(' a , @org/b ,, ')).toEqual(['a', '@org/b']);
  });

  it('미설정과 빈 문자열은 빈 목록이다', () => {
    expect(parseAdapterSpecifiers(undefined)).toEqual([]);
    expect(parseAdapterSpecifiers('')).toEqual([]);
  });
});

describe('loadSecretAdapters', () => {
  it('bare 패키지 이름의 기본 export를 SecretSource로 돌려준다', async () => {
    const importModule = jest.fn<ImportModule>(async (specifier) => ({
      default: fakeSource(specifier === 'storix-secret-a' ? 'fake' : 'other'),
    }));

    const sources = await loadSecretAdapters(['storix-secret-a', '@org/storix-secret-b'], importModule);

    expect(sources.map((source) => source.scheme)).toEqual(['fake', 'other']);
    expect(importModule).toHaveBeenCalledWith('storix-secret-a');
    expect(importModule).toHaveBeenCalledWith('@org/storix-secret-b');
  });

  it('경로·URL·내장 모듈·하위 경로 지정자는 import하지 않고 거부한다', async () => {
    const importModule = jest.fn<ImportModule>(async () => ({ default: fakeSource('fake') }));
    const specifiers = [
      './adapter.js',
      '/backups/adapter.mjs',
      'file:///tmp/a.mjs',
      'data:text/javascript,export default 1',
      'node:fs',
      'https://example.com/a.mjs',
      'pkg/sub',
      'Upper',
    ];

    const failures = await loadFailures(loadSecretAdapters(specifiers, importModule));

    expect(failures).toEqual(specifiers.map((specifier) => ({ specifier, kind: 'invalid-specifier' })));
    expect(importModule).not.toHaveBeenCalled();
  });

  it('설치되지 않은 패키지는 not-found로 실패한다', async () => {
    const failures = await loadFailures(loadSecretAdapters(['storix-secret-not-installed-xyz']));

    expect(failures).toEqual([{ specifier: 'storix-secret-not-installed-xyz', kind: 'not-found' }]);
  });

  it('import 오류 메시지를 옮기지 않는다', async () => {
    const importModule: ImportModule = async () => {
      throw new Error('token=import-secret-555');
    };

    const promise = loadSecretAdapters(['storix-secret-a'], importModule);

    await expect(promise).rejects.toThrow('storix-secret-a: import-failed');
    await expect(promise).rejects.not.toThrow(/import-secret-555/);
  });

  it('import가 null을 던져도 import-failed로 분류한다', async () => {
    const importModule: ImportModule = async () => {
      throw null;
    };

    const failures = await loadFailures(loadSecretAdapters(['storix-secret-a'], importModule));

    expect(failures).toEqual([{ specifier: 'storix-secret-a', kind: 'import-failed' }]);
  });

  it('기본 export가 SecretSource 구조가 아니면 invalid-export로 실패한다', async () => {
    const exports: Record<string, unknown> = {
      'no-default': {},
      'no-resolve': { default: { scheme: 'fake' } },
      'bad-scheme': { default: { scheme: 'Bad Scheme', resolve: async () => 'v' } },
    };
    const importModule: ImportModule = async (specifier) => exports[specifier];

    const failures = await loadFailures(loadSecretAdapters(Object.keys(exports), importModule));

    expect(failures.map((failure) => failure.kind)).toEqual([
      'invalid-export',
      'invalid-export',
      'invalid-export',
    ]);
  });

  it('file scheme은 reserved-scheme, 같은 scheme 중복은 duplicate-scheme으로 실패한다', async () => {
    const schemes: Record<string, string> = {
      'adapter-file': 'file',
      'adapter-a': 'fake',
      'adapter-b': 'fake',
    };
    const importModule: ImportModule = async (specifier) => ({ default: fakeSource(schemes[specifier]) });

    const failures = await loadFailures(loadSecretAdapters(Object.keys(schemes), importModule));

    expect(failures).toEqual([
      { specifier: 'adapter-file', kind: 'reserved-scheme' },
      { specifier: 'adapter-b', kind: 'duplicate-scheme' },
    ]);
  });
});
