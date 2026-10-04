import {
  AUTH_REJECT_AUDIT_MAX_PER_WINDOW,
  AUTH_REJECT_AUDIT_WINDOW_MS,
  AuthRejectAuditLimiter,
} from '../../src/audit/auth-reject-audit-limiter.js';

function createLimiter() {
  let now = 1_000;
  const limiter = new AuthRejectAuditLimiter(() => now);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('AuthRejectAuditLimiter', () => {
  it('윈도 상한까지는 모두 개별 행으로 기록하고 생략 정보가 없다', () => {
    const { limiter } = createLimiter();

    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW; i += 1) {
      expect(limiter.admit()).toEqual({ record: true, suppressedBefore: 0, firstSuppressed: false });
    }
  });

  it('상한을 넘으면 기록하지 않고 윈도당 첫 생략만 firstSuppressed로 알린다', () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW; i += 1) limiter.admit();

    expect(limiter.admit()).toEqual({ record: false, suppressedBefore: 0, firstSuppressed: true });
    expect(limiter.admit()).toEqual({ record: false, suppressedBefore: 0, firstSuppressed: false });
  });

  it('윈도 경계 직전까지는 같은 윈도로 보고 경계에서 새 윈도를 시작한다', () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW; i += 1) limiter.admit();

    advance(AUTH_REJECT_AUDIT_WINDOW_MS - 1);
    expect(limiter.admit().record).toBe(false);

    advance(1);
    expect(limiter.admit()).toEqual({ record: true, suppressedBefore: 1, firstSuppressed: false });
  });

  it('새 윈도의 첫 요청이 직전 윈도의 생략 건수를 한 번만 넘겨준다', () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW + 5; i += 1) limiter.admit();

    advance(AUTH_REJECT_AUDIT_WINDOW_MS);
    expect(limiter.admit()).toEqual({ record: true, suppressedBefore: 5, firstSuppressed: false });
    expect(limiter.admit()).toEqual({ record: true, suppressedBefore: 0, firstSuppressed: false });
  });

  it('여러 윈도가 지나간 뒤에 들어온 요청도 마지막으로 끝난 윈도의 생략 건수를 넘겨준다', () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW + 2; i += 1) limiter.admit();

    advance(AUTH_REJECT_AUDIT_WINDOW_MS * 10);
    expect(limiter.admit().suppressedBefore).toBe(2);
  });

  it('생략이 없던 윈도는 요약 건수 없이 새 윈도로 넘어간다', () => {
    const { limiter, advance } = createLimiter();
    limiter.admit();

    advance(AUTH_REJECT_AUDIT_WINDOW_MS);
    expect(limiter.admit()).toEqual({ record: true, suppressedBefore: 0, firstSuppressed: false });
  });

  it('새 윈도에서도 상한이 다시 적용된다', () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW; i += 1) limiter.admit();
    advance(AUTH_REJECT_AUDIT_WINDOW_MS);

    for (let i = 0; i < AUTH_REJECT_AUDIT_MAX_PER_WINDOW; i += 1) {
      expect(limiter.admit().record).toBe(true);
    }
    expect(limiter.admit()).toMatchObject({ record: false, firstSuppressed: true });
  });
});
