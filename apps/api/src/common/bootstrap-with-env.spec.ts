import { jest } from '@jest/globals';
import { bootstrapWithEnv, loadEnvFile } from './bootstrap-with-env.js';

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
  it('.env를 로드한 뒤 loadModule()의 결과를 반환한다', async () => {
    const spy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined as never);
    const loadModule = jest.fn<() => Promise<{ value: number }>>().mockResolvedValue({ value: 42 });

    const result = await bootstrapWithEnv(loadModule);

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

    await bootstrapWithEnv(loadModule);

    expect(callOrder).toEqual(['loadEnvFile', 'loadModule']);
    spy.mockRestore();
  });
});
