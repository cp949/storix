export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;

  // status는 서브클래스 필드 초기화 시점에 정해지는데, 베이스 클래스 필드는 그보다
  // 먼저 초기화된다 — 필드가 아닌 getter로 지연 평가해야 this.status를 읽을 수 있다.
  get shouldReport(): boolean {
    return this.status >= 500;
  }
}
