// 가짜 환경변수 조회와 warning spy로 archive 설정 파싱·grace 검사 경계를 검증한다.
// 검증 규칙은 docs/design/16-file-archive.md의 원본 보존 전제를 따른다.
import { jest } from '@jest/globals';
import { createArchiveConfig } from '../../src/vfs/archive-config.js';

// API가 읽은 값만 검사하며 별도 GC 설정은 확인하지 못하는 전제를 고정한다.
describe('createArchiveConfig 설정 검증', () => {
  const ignoreWarning = jest.fn();

  it('기본 한도와 기본 orphan grace 가정을 사용한다', () => {
    const warning = jest.fn();
    const result = createArchiveConfig(() => undefined, warning);
    expect(result).toMatchObject({
      maxConcurrency: 1,
      maxEntries: 1000,
      maxSourceBytes: 1073741824n,
      maxResultBytes: 2147483648n,
      maxSeconds: 600,
      orphanGraceSeconds: 86400,
      compressionLevel: 1,
    });
    expect(result.assumedOrphanGrace).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('별도 GC 프로세스'));
  });

  it('명시된 grace가 deadline 여유보다 짧으면 거부한다', () => {
    expect(() =>
      createArchiveConfig(
        (key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '659' })[key],
        ignoreWarning,
      ),
    ).toThrow(/STORIX_ORPHAN_GRACE_PERIOD/);
  });

  it('deadline에 60초를 더한 grace 경계값은 허용한다', () => {
    const result = createArchiveConfig(
      (key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '660' })[key],
      ignoreWarning,
    );
    expect(result.orphanGraceSeconds).toBe(660);
    expect(result.assumedOrphanGrace).toBe(false);
  });

  it('양의 정수 설정이 아닌 값은 거부한다', () => {
    expect(() =>
      createArchiveConfig((key) => (key === 'STORIX_ARCHIVE_MAX_ENTRIES' ? '0' : undefined), ignoreWarning),
    ).toThrow();
  });

  it('압축 수준은 0부터 9까지 받는다', () => {
    expect(
      createArchiveConfig(
        (key) => (key === 'STORIX_ARCHIVE_COMPRESSION_LEVEL' ? '9' : undefined),
        ignoreWarning,
      ).compressionLevel,
    ).toBe(9);
    expect(() =>
      createArchiveConfig(
        (key) => (key === 'STORIX_ARCHIVE_COMPRESSION_LEVEL' ? '10' : undefined),
        ignoreWarning,
      ),
    ).toThrow();
  });

  it('archive가 전역 허용되지 않으면 grace 위반을 경고로만 남기고 부팅을 허용한다', () => {
    const warning = jest.fn();
    const result = createArchiveConfig(
      (key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '1' })[key],
      warning,
      { archiveGloballyAllowed: false },
    );
    expect(result.orphanGraceSeconds).toBe(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('전역 허용되지 않아'));
  });

  it('archive가 전역 허용되면 같은 설정을 거부한다', () => {
    expect(() =>
      createArchiveConfig(
        (key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '600', STORIX_ORPHAN_GRACE_PERIOD: '1' })[key],
        ignoreWarning,
        { archiveGloballyAllowed: true },
      ),
    ).toThrow(/STORIX_ORPHAN_GRACE_PERIOD/);
  });

  it('grace 미설정 상태의 위반 메시지는 기본값 가정을 밝힌다', () => {
    expect(() =>
      createArchiveConfig((key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '86400' })[key], ignoreWarning),
    ).toThrow(/미설정, GC 기본값 86400 가정/);
  });

  it('grace를 명시하면 기본값 가정 경고를 내지 않는다', () => {
    const warning = jest.fn();
    createArchiveConfig((key) => ({ STORIX_ORPHAN_GRACE_PERIOD: '86400' })[key], warning);
    expect(warning).not.toHaveBeenCalled();
  });

  it('실행 상한은 86400초를 넘지 못한다', () => {
    expect(() =>
      createArchiveConfig((key) => ({ STORIX_ARCHIVE_MAX_SECONDS: '86401' })[key], ignoreWarning),
    ).toThrow();
  });
});
