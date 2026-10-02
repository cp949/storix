# PostgreSQL ORM으로 TypeORM을 사용한다

- PostgreSQL ORM은 TypeORM을 사용한다.
- `synchronize`는 금지한다.
- 스키마는 별도 `migration:run` job으로만 반영한다.

## 결정 근거

- 여러 WAS 인스턴스의 동시 쓰기는 `SELECT ... FOR UPDATE`로 제어한다.
- 여러 행의 lock은 UUID 오름차순으로 획득한다.
- TypeORM은 row-level pessimistic locking과 수동 transaction 제어를 직접 지원한다.

## Considered Options

- **Prisma**
  - DX는 좋다고 평가했다.
  - 필요한 row lock과 수동 transaction 제어가 TypeORM만큼 직접적이지 않았다.
- **Drizzle**
  - 가볍고 타입 안전하다고 평가했다.
  - 검토 시점의 생태계와 문서는 TypeORM보다 덜 성숙하다고 판단했다.
