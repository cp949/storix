// 가짜 환경변수 조회와 warning spy로 extract 설정 파싱·상한 clamp·grace 검사 경계를 검증한다.
// 검증 규칙은 archive-config.spec.ts와 같은 강도를 따른다. 별도 GC 설정은 확인하지 못하는 전제도 같다.
import { jest } from '@jest/globals';
import { createExtractConfig } from '../../src/vfs/extract-config.js';

describe('createExtractConfig 설정 검증', () => {
  const ignoreWarning = jest.fn();

  it('기본 한도와 기본 orphan grace 가정을 사용한다', () => {
    const warning = jest.fn();
    const result = createExtractConfig(() => undefined, warning);
    expect(result).toMatchObject({
      maxConcurrency: 1,
      maxEntries: 1000,
      maxTotalBytes: 1073741824n,
      maxRatio: 100,
      maxSeconds: 600,
      orphanGraceSeconds: 86400,
      retryAfterSeconds: 10,
    });
    expect(result.assumedOrphanGrace).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('별도 GC 프로세스'));
  });

  it('각 상한 경계값은 허용하고 한 칸 넘으면 거부한다', () => {
    const accepted = createExtractConfig(
      (key) =>
        ({
          STORIX_EXTRACT_MAX_ENTRIES: '10000',
          STORIX_EXTRACT_MAX_TOTAL_BYTES: '1073741824',
          STORIX_EXTRACT_MAX_RATIO: '10000',
          STORIX_EXTRACT_MAX_SECONDS: '86400',
          STORIX_EXTRACT_RETRY_AFTER_SECONDS: '3600',
          STORIX_ORPHAN_GRACE_PERIOD: '86460',
        })[key],
      ignoreWarning,
    );
    expect(accepted).toMatchObject({
      maxEntries: 10000,
      maxTotalBytes: 1073741824n,
      maxRatio: 10000,
      maxSeconds: 86400,
      retryAfterSeconds: 3600,
    });
    for (const [name, value] of [
      ['STORIX_EXTRACT_MAX_ENTRIES', '10001'],
      ['STORIX_EXTRACT_MAX_TOTAL_BYTES', '1073741825'],
      ['STORIX_EXTRACT_MAX_RATIO', '10001'],
      ['STORIX_EXTRACT_MAX_SECONDS', '86401'],
      ['STORIX_EXTRACT_RETRY_AFTER_SECONDS', '3601'],
    ] as const) {
      expect(() => createExtractConfig((key) => (key === name ? value : undefined), ignoreWarning)).toThrow(
        /잘못된 정수 환경변수 값/,
      );
    }
  });

  it('양의 정수가 아닌 값은 거부한다', () => {
    for (const value of ['0', '-1', '1e3', '0x10', ' 5', '5.0', 'abc']) {
      expect(() =>
        createExtractConfig(
          (key) => (key === 'STORIX_EXTRACT_MAX_CONCURRENCY' ? value : undefined),
          ignoreWarning,
        ),
      ).toThrow(/잘못된 정수 환경변수 값/);
    }
  });

  it('빈 문자열은 기본값으로 되돌린다', () => {
    const result = createExtractConfig(
      (key) => (key === 'STORIX_EXTRACT_MAX_ENTRIES' ? '' : undefined),
      ignoreWarning,
    );
    expect(result.maxEntries).toBe(1000);
  });

  it('명시된 grace가 deadline 여유보다 짧으면 거부한다', () => {
    expect(() =>
      createExtractConfig(
        (key) => ({ STORIX_EXTRACT_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '659' })[key],
        ignoreWarning,
      ),
    ).toThrow(/STORIX_ORPHAN_GRACE_PERIOD.*STORIX_EXTRACT_MAX_SECONDS \+ 60/);
  });

  it('deadline에 60초를 더한 grace 경계값은 허용한다', () => {
    const result = createExtractConfig(
      (key) => ({ STORIX_EXTRACT_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '660' })[key],
      ignoreWarning,
    );
    expect(result.orphanGraceSeconds).toBe(660);
    expect(result.assumedOrphanGrace).toBe(false);
  });

  it('extract가 전역 허용되지 않으면 grace 위반을 경고로만 남기고 부팅을 허용한다', () => {
    const warning = jest.fn();
    const result = createExtractConfig(
      (key) => ({ STORIX_EXTRACT_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '1' })[key],
      warning,
      { extractGloballyAllowed: false },
    );
    expect(result.orphanGraceSeconds).toBe(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('전역 허용되지 않아'));
  });

  it('extract가 전역 허용되면 같은 설정을 거부한다', () => {
    expect(() =>
      createExtractConfig(
        (key) => ({ STORIX_EXTRACT_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '1' })[key],
        ignoreWarning,
        { extractGloballyAllowed: true },
      ),
    ).toThrow(/STORIX_ORPHAN_GRACE_PERIOD/);
  });

  it('grace 미설정 상태의 위반 메시지는 기본값 가정을 밝힌다', () => {
    expect(() =>
      createExtractConfig((key) => ({ STORIX_EXTRACT_MAX_SECONDS: '86400' })[key], ignoreWarning),
    ).toThrow(/미설정, GC 기본값 86400 가정/);
  });

  it('grace를 명시하면 기본값 가정 경고를 내지 않는다', () => {
    const warning = jest.fn();
    createExtractConfig((key) => ({ STORIX_ORPHAN_GRACE_PERIOD: '86400' })[key], warning);
    expect(warning).not.toHaveBeenCalled();
  });
});
