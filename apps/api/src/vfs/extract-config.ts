// extract 실행 한도와 API 프로세스가 본 GC grace의 설정 관계를 검사한다.
// 별도 GC 환경값·삭제 transaction 지연은 확인하지 않는다. 원본 보존을 보장하지 않는다.
import { Logger } from '@nestjs/common';
import { MAX_GRACE_PERIOD_SECONDS, parsePositiveInt } from '../common/env-parsing.js';

/** extract 실행 설정을 주입할 때 쓰는 token이다. */
export const EXTRACT_CONFIG = Symbol('EXTRACT_CONFIG');

/** extract 전용 동시 실행 gate를 주입할 때 쓰는 token이다. archive gate와 분리한다. */
export const EXTRACT_GATE = Symbol('EXTRACT_GATE');

/** extract 실행과 입력 검증에 사용하는 설정이다. */
export interface ExtractConfig {
  /** 프로세스 안에서 동시에 실행할 extract 수다. */
  readonly maxConcurrency: number;

  /** exclude 뒤 선택한 entry 수 상한이다. */
  readonly maxEntries: number;

  /** 제외 FILE을 포함한 평문 FILE 크기 합의 byte 상한이다. */
  readonly maxTotalBytes: bigint;

  /** 압축비 상한이다. 해제 크기가 압축 크기의 이 배수를 넘으면 거부한다. */
  readonly maxRatio: number;

  /** capture부터 commit까지 허용하는 초 단위 deadline이다. */
  readonly maxSeconds: number;

  /** GC가 참조 없는 Blob을 보존하는 초 단위 기간이다. */
  readonly orphanGraceSeconds: number;

  /** GC 환경변수가 없어 기본값을 가정했는지 나타낸다. */
  readonly assumedOrphanGrace: boolean;

  /** gate busy 응답에 안내할 재시도 대기 초다. */
  readonly retryAfterSeconds: number;
}

const DEFAULT_ORPHAN_GRACE_SECONDS = 86400;
const MAX_TOTAL_BYTES_CEILING = 1073741824;
const DEFAULTS = {
  maxConcurrency: 1,
  maxEntries: 1000,
  maxTotalBytes: MAX_TOTAL_BYTES_CEILING,
  maxRatio: 100,
  maxSeconds: 600,
  retryAfterSeconds: 10,
} as const;

/** grace 불변식 검사 강도를 정한다. */
export interface ExtractConfigOptions {
  /**
   * extract capability가 전역 허용 목록에 있는지다. 없으면 어떤 namespace도 extract를 실행할 수 없으므로
   * grace 불변식 위반을 부팅 거부 대신 경고로 남긴다. extract를 쓰지 않는 기존 배포가 짧은 grace 때문에
   * 업그레이드 뒤 부팅하지 못하는 일을 막는다.
   */
  readonly extractGloballyAllowed: boolean;
}

/** extract 환경변수를 읽고 상한과 GC grace 관계를 검사한다. */
export function createExtractConfig(
  read: (name: string) => string | undefined = (name) => process.env[name],
  warn: (message: string) => void = (message) => new Logger('ExtractConfig').warn(message),
  options: ExtractConfigOptions = { extractGloballyAllowed: true },
): ExtractConfig {
  const maxSeconds = parsePositiveInt(read('STORIX_EXTRACT_MAX_SECONDS'), DEFAULTS.maxSeconds, 86400);
  const configuredGrace = read('STORIX_ORPHAN_GRACE_PERIOD');
  const assumedOrphanGrace = configuredGrace === undefined || configuredGrace === '';
  const orphanGraceSeconds = parsePositiveInt(
    configuredGrace,
    DEFAULT_ORPHAN_GRACE_SECONDS,
    MAX_GRACE_PERIOD_SECONDS,
  );
  if (orphanGraceSeconds < maxSeconds + 60) {
    const graceLabel = assumedOrphanGrace
      ? `STORIX_ORPHAN_GRACE_PERIOD(미설정, GC 기본값 ${DEFAULT_ORPHAN_GRACE_SECONDS} 가정)`
      : 'STORIX_ORPHAN_GRACE_PERIOD';
    const violation = `${graceLabel}은 STORIX_EXTRACT_MAX_SECONDS + 60 이상이어야 함: ${orphanGraceSeconds} < ${maxSeconds + 60}`;
    if (options.extractGloballyAllowed) throw new Error(violation);
    warn(
      `${violation}. extract capability가 전역 허용되지 않아 경고로만 남긴다. 허용하기 전에 설정을 고친다.`,
    );
  }
  if (assumedOrphanGrace) {
    warn(
      'STORIX_ORPHAN_GRACE_PERIOD 미설정. GC 기본값 86400초를 가정한다. 별도 GC 프로세스의 실제 설정은 확인하지 못한다.',
    );
  }
  return {
    maxConcurrency: parsePositiveInt(read('STORIX_EXTRACT_MAX_CONCURRENCY'), DEFAULTS.maxConcurrency),
    maxEntries: parsePositiveInt(read('STORIX_EXTRACT_MAX_ENTRIES'), DEFAULTS.maxEntries, 10000),
    maxTotalBytes: BigInt(
      parsePositiveInt(
        read('STORIX_EXTRACT_MAX_TOTAL_BYTES'),
        DEFAULTS.maxTotalBytes,
        MAX_TOTAL_BYTES_CEILING,
      ),
    ),
    maxRatio: parsePositiveInt(read('STORIX_EXTRACT_MAX_RATIO'), DEFAULTS.maxRatio, 10000),
    maxSeconds,
    orphanGraceSeconds,
    assumedOrphanGrace,
    retryAfterSeconds: parsePositiveInt(
      read('STORIX_EXTRACT_RETRY_AFTER_SECONDS'),
      DEFAULTS.retryAfterSeconds,
      3600,
    ),
  };
}
