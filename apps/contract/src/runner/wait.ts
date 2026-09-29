/** `waitUntil` 옵션. */
export interface WaitOptions {
  /** 제한 시간(ms) */
  readonly timeoutMs: number;

  /** 확인 간격(ms). 기본 200이다. */
  readonly intervalMs?: number;

  /** 시간 초과 오류 메시지에 쓰는 대기 대상 설명 */
  readonly description: string;
}

/**
 * `check`가 참을 반환할 때까지 반복한다.
 * `check`가 던진 오류는 준비 전 연결 거부로 보고 재시도한다.
 */
export async function waitUntil(check: () => Promise<boolean>, options: WaitOptions): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 200;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // 준비 전 연결 오류는 다음 확인에서 다시 시도한다.
    }
    if (Date.now() >= deadline) {
      throw new Error(`${options.description} 대기 시간 초과(${options.timeoutMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
