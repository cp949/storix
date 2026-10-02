import { readNamespaceGlobalLimits } from '../../src/namespace/namespace-global-limits.js';
import type { ConfigService } from '@nestjs/config';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('namespace 전역 default와 ceiling', () => {
  it('두 제한 모두 내장 기본값을 사용한다', () => {
    const limits = readNamespaceGlobalLimits(config({}));
    expect(limits.defaultMaxFileSizeBytes).toBe(5368709120);
    expect(limits.maxFileSizeBytes).toBe(5368709120);
    expect(limits.defaultMaxTotalLogicalBytes).toBe(53687091200n);
    expect(limits.maxTotalLogicalBytes).toBe(53687091200n);
    expect(limits.defaultMaxLiveNodes).toBe(1_000_000);
    expect(limits.maxLiveNodes).toBe(1_000_000);
    expect(limits.defaultMaxFilesPerFolder).toBe(10_000);
    expect(limits.maxFilesPerFolder).toBe(10_000);
  });

  it('MAX만 지정하면 기존처럼 기본값과 ceiling이 같다', () => {
    const limits = readNamespaceGlobalLimits(
      config({ STORIX_MAX_FILE_SIZE_BYTES: '1000', STORIX_MAX_TOTAL_LOGICAL_BYTES: '2000' }),
    );
    expect(limits.defaultMaxFileSizeBytes).toBe(1000);
    expect(limits.maxFileSizeBytes).toBe(1000);
    expect(limits.defaultMaxTotalLogicalBytes).toBe(2000n);
    expect(limits.maxTotalLogicalBytes).toBe(2000n);
  });

  it('DEFAULT만 지정하면 ceiling도 같은 값으로 설정한다', () => {
    const limits = readNamespaceGlobalLimits(
      config({
        STORIX_DEFAULT_FILE_SIZE_BYTES: '3000',
        STORIX_DEFAULT_TOTAL_LOGICAL_BYTES: '4000',
      }),
    );
    expect(limits.defaultMaxFileSizeBytes).toBe(3000);
    expect(limits.maxFileSizeBytes).toBe(3000);
    expect(limits.defaultMaxTotalLogicalBytes).toBe(4000n);
    expect(limits.maxTotalLogicalBytes).toBe(4000n);
  });

  it('DEFAULT와 더 큰 MAX를 별도로 적용한다', () => {
    const limits = readNamespaceGlobalLimits(
      config({
        STORIX_DEFAULT_FILE_SIZE_BYTES: '3000',
        STORIX_MAX_FILE_SIZE_BYTES: '5000',
        STORIX_DEFAULT_TOTAL_LOGICAL_BYTES: '4000',
        STORIX_MAX_TOTAL_LOGICAL_BYTES: '6000',
      }),
    );
    expect(limits.defaultMaxFileSizeBytes).toBe(3000);
    expect(limits.maxFileSizeBytes).toBe(5000);
    expect(limits.defaultMaxTotalLogicalBytes).toBe(4000n);
    expect(limits.maxTotalLogicalBytes).toBe(6000n);
  });

  it('DEFAULT가 MAX를 넘으면 시작 설정을 거부한다', () => {
    expect(() =>
      readNamespaceGlobalLimits(
        config({ STORIX_DEFAULT_FILE_SIZE_BYTES: '5000', STORIX_MAX_FILE_SIZE_BYTES: '4000' }),
      ),
    ).toThrow(/default.*ceiling/i);
    expect(() =>
      readNamespaceGlobalLimits(
        config({ STORIX_DEFAULT_TOTAL_LOGICAL_BYTES: '5000', STORIX_MAX_TOTAL_LOGICAL_BYTES: '4000' }),
      ),
    ).toThrow(/default.*ceiling/i);
  });

  it('파일 ceiling이 구조상한을 넘으면 시작 설정을 거부한다', () => {
    expect(() => readNamespaceGlobalLimits(config({ STORIX_MAX_FILE_SIZE_BYTES: '167772160001' }))).toThrow(
      /maximum object size/i,
    );
  });
});
