// tar·zip reader가 던지는 오류다. service가 entryIndex를 붙여 VfsExtract* 오류로 바꾼다.

/**
 * 압축 형식 또는 entry 하나의 결함을 나타낸다.
 * storage·네트워크 같은 외부 장애는 이 오류로 바꾸지 않고 원래 오류를 그대로 전파한다.
 */
export class ExtractReaderError extends Error {
  /**
   * @param kind `format`은 지원 범위 밖 형식, `entry`는 지원 형식 안의 손상·금지 entry다.
   * @param reason 사람이 읽는 원인이다.
   * @param entryName 결함이 난 entry의 원본 이름이다. 이름을 읽기 전에 손상됐으면 빈 문자열, 알 수 없으면 생략한다.
   */
  constructor(
    readonly kind: 'format' | 'entry',
    readonly reason: string,
    readonly entryName?: string,
  ) {
    super(entryName ? `${reason}: ${entryName}` : reason);
  }
}
