/** 어댑터 오류다. 종류만 담고 값·토큰·참조를 메시지에 쓰지 않는다. */
export class BaoError extends Error {
  /** @param {string} kind */
  constructor(kind) {
    super(`bao 해석 실패: ${kind}`);
    this.name = "BaoError";
    this.kind = kind;
  }
}
