// Postgres '$N'은 이름 기반 파라미터라 재사용할 수 있고, SQLite '?'는 텍스트
// 등장 순서로만 바인딩되고 재사용이 안 된다. 두 드라이버 모두 "값이 SQL에
// 나올 때마다 bind()를 한 번씩 호출한다"는 같은 규칙으로 다루면(Postgres에서
// 굳이 재사용하지 않아도 결과는 동일하다) 호출부가 dialect를 신경 쓸 필요가
// 없어진다.
export class DialectPlaceholders {
  private readonly values: unknown[] = [];

  constructor(private readonly isSqlite: boolean) {}

  bind(value: unknown): string {
    this.values.push(value);
    return this.isSqlite ? '?' : `$${this.values.length}`;
  }

  get params(): unknown[] {
    return this.values;
  }
}
