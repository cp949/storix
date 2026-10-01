/**
 * GC 단계 하나가 한 번의 실행에서 처리할 수 있는 작업량 예산.
 * 단위는 단계가 정한다(change feed 정리는 읽은 만료 이벤트 수). 예산이 소진되면 단계는 재개 위치를
 * 저장하고 멈추며, 다음 실행이 이어간다. 호출 1회는 최소 1을 소모해 진행 없는 반복을 막는다.
 */
export class GcStageBudget {
  private used = 0;

  constructor(readonly limit: number) {}

  consume(units: number): void {
    this.used += Math.max(1, units);
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }
}

/** 한 단계의 기본 예산. `STORIX_GC_MAX_ROWS_PER_STAGE`로 바꾼다. */
export const DEFAULT_GC_STAGE_BUDGET = 200_000;
