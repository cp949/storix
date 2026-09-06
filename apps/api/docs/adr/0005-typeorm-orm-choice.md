# PostgreSQL ORM으로 TypeORM을 사용한다

Storix는 여러 WAS 인스턴스의 동시 쓰기를 `SELECT ... FOR UPDATE`와 UUID 오름차순
다중 lock으로 제어해야 한다. TypeORM이 row-level pessimistic locking과 수동
transaction 제어를 가장 직접적으로 지원해 이 요구에 맞았다. `synchronize`는 금지하고
별도 `migration:run` job으로만 스키마를 반영한다.

## Considered Options

- **Prisma**: DX는 좋지만 이 프로젝트가 요구하는 세밀한 row lock·수동 transaction
  제어가 TypeORM만큼 직접적이지 않았다.
- **Drizzle**: 가볍고 타입 안전하지만 이 시점 기준으로 TypeORM만큼 생태계·문서가
  성숙하지 않다고 판단했다.
