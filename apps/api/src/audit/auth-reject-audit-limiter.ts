import { performance } from 'node:perf_hooks';

/**
 * 인증 거부(401) 감사 행의 윈도당 상한을 두는 이유와 동작을 정의한 파일이다. 규칙은 api ADR-0010에 있다.
 *
 * - 인증되지 않은 요청은 호출자가 수를 정한다. 요청마다 insert하면 audit_log 크기와 DB 동시 insert가 요청 수에 비례한다.
 * - 상한을 넘은 거부는 건수만 세고, 다음 윈도의 첫 거부 때 요약 행 1개로 남긴다.
 */

/** `AuthRejectAuditLimiter` 앱 단위 provider 토큰. */
export const AUTH_REJECT_AUDIT_LIMITER = Symbol('AUTH_REJECT_AUDIT_LIMITER');

/** 윈도당 개별 감사 행 상한. */
export const AUTH_REJECT_AUDIT_MAX_PER_WINDOW = 60;

/** 윈도 길이(밀리초). */
export const AUTH_REJECT_AUDIT_WINDOW_MS = 60_000;

/** `admit()`의 판정 결과. */
export interface AuthRejectAuditDecision {
  /** 이 거부를 개별 감사 행으로 기록할지 여부 */
  readonly record: boolean;
  /** 직전 윈도에서 생략한 거부 건수. 0보다 크면 호출자가 요약 행을 기록한다. */
  readonly suppressedBefore: number;
  /** 현재 윈도에서 처음 생략이 발생했는지 여부. 호출자가 경고 로그를 남긴다. */
  readonly firstSuppressed: boolean;
}

/**
 * 프로세스 로컬 고정 윈도 리미터. 타이머를 쓰지 않고 `admit()` 호출 시점에 윈도를 넘긴다.
 * 공격이 멈추면 마지막 윈도의 생략 건수는 다음 거부가 올 때까지 요약 행으로 남지 않는다.
 */
export class AuthRejectAuditLimiter {
  private windowStart: number | undefined;
  private recorded = 0;
  private suppressed = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  admit(): AuthRejectAuditDecision {
    const current = this.now();
    let suppressedBefore = 0;

    if (this.windowStart === undefined || current - this.windowStart >= AUTH_REJECT_AUDIT_WINDOW_MS) {
      suppressedBefore = this.suppressed;
      this.windowStart = current;
      this.recorded = 0;
      this.suppressed = 0;
    }

    if (this.recorded < AUTH_REJECT_AUDIT_MAX_PER_WINDOW) {
      this.recorded += 1;
      return { record: true, suppressedBefore, firstSuppressed: false };
    }

    this.suppressed += 1;
    return { record: false, suppressedBefore, firstSuppressed: this.suppressed === 1 };
  }
}
