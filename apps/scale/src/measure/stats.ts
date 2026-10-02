/** 지연 표본 하나. 실패한 요청도 표본에 남긴다. */
export interface Sample {
  readonly ms: number;
  readonly ok: boolean;
}

/** 지연 요약. 실패 수와 성공 지연 분위수를 따로 둔다. */
export interface LatencySummary {
  readonly count: number;
  readonly failures: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** 정렬된 값에서 최근접 순위(nearest-rank) 분위수를 구한다. `q`는 0..1이다. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (q <= 0 || q > 1) throw new Error('q는 (0, 1] 범위여야 한다');
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/**
 * 표본을 요약한다. 분위수는 성공한 요청의 지연만으로 계산하고, 실패는 `failures`로 별도 집계한다.
 * 실패를 표본에서 지우지 않으므로 `count`는 전체 시도 수다.
 */
export function summarize(samples: readonly Sample[]): LatencySummary {
  const ok = samples
    .filter((sample) => sample.ok)
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);
  return {
    count: samples.length,
    failures: samples.length - ok.length,
    p50Ms: percentile(ok, 0.5),
    p95Ms: percentile(ok, 0.95),
    maxMs: ok.length === 0 ? null : ok[ok.length - 1],
  };
}
