import { jest } from '@jest/globals';
import { bootstrapWithEnv, loadEnvFile } from '../../src/common/bootstrap-with-env.js';

describe('loadEnvFile', () => {
  it('.env 파일이 없으면(ENOENT) 조용히 넘어간다', () => {
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const error = new Error('no such file') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    expect(() => loadEnvFile()).not.toThrow();
    spy.mockRestore();
  });

  it('ENOENT가 아닌 에러는 그대로 던진다', () => {
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    expect(() => loadEnvFile()).toThrow('permission denied');
    spy.mockRestore();
  });
});

describe('bootstrapWithEnv', () => {
  // 호스트 환경의 비밀값 변수를 해석하지 않도록 비밀값 해석을 비운다.
  const noopResolve = async (): Promise<void> => undefined;

  it('.env를 로드한 뒤 loadModule()의 결과를 반환한다', async () => {
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined as never);
    const loadModule = jest.fn<() => Promise<{ value: number }>>().mockResolvedValue({ value: 42 });

    const result = await bootstrapWithEnv(loadModule, noopResolve);

    expect(result).toEqual({ value: 42 });
    expect(loadModule).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('loadModule()보다 loadEnvFile()을 먼저 호출한다', async () => {
    const callOrder: string[] = [];
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      callOrder.push('loadEnvFile');
      return undefined as never;
    });
    const loadModule = jest.fn<() => Promise<object>>().mockImplementation(async () => {
      callOrder.push('loadModule');
      return {};
    });

    await bootstrapWithEnv(loadModule, noopResolve);

    expect(callOrder).toEqual(['loadEnvFile', 'loadModule']);
    spy.mockRestore();
  });

  it('loadEnvFile(), 비밀값 해석, loadModule() 순으로 호출한다', async () => {
    const callOrder: string[] = [];
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      callOrder.push('loadEnvFile');
      return undefined as never;
    });
    const resolve = jest.fn<() => Promise<void>>().mockImplementation(async () => {
      callOrder.push('resolveSecrets');
    });
    const loadModule = jest.fn<() => Promise<object>>().mockImplementation(async () => {
      callOrder.push('loadModule');
      return {};
    });

    await bootstrapWithEnv(loadModule, resolve);

    expect(callOrder).toEqual(['loadEnvFile', 'resolveSecrets', 'loadModule']);
    spy.mockRestore();
  });

  it('비밀값 해석이 실패하면 loadModule()을 호출하지 않는다', async () => {
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined as never);
    const resolve = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('비밀값 해석 실패'));
    const loadModule = jest.fn<() => Promise<object>>().mockResolvedValue({});

    await expect(bootstrapWithEnv(loadModule, resolve)).rejects.toThrow('비밀값 해석 실패');
    expect(loadModule).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
