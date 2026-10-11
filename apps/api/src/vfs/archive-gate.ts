// 프로세스별 archive 슬롯을 대기열 없이 획득·반환한다.
// 슬롯 반환은 호출자 책임이다. 같은 lease의 반복 반환은 무시한다.
/** 프로세스 안에서 동시에 실행할 archive 요청 수를 제한한다. */
export class ArchiveGate {
  private active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('archive gate limit must be a positive safe integer');
  }

  /** 자리가 없으면 기다리지 않고 null을 반환한다. */
  tryAcquire(): { release(): void } | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}
