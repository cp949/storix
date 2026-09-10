// Express는 같은 쿼리 파라미터가 중복되면(?path=a&path=b) string[]을 준다 —
// 타입 애너테이션(string | undefined)만으로는 이 런타임 형태를 못 막는다.
export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
