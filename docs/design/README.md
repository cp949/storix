# 설계 문서

장기적으로 유지할 가치가 있는 설계만 둔다. ADR보다 상세한 현재 시점의 설계 기술이다. 일회성 작업의 설계는 여기에 두지
않는다(`_works/`).

- 소스 코드 줄 번호를 적지 않는다.
- 이력을 남기지 않는다. 기능이 바뀌면 문서를 현재 내용으로 고쳐 쓴다. 이력은 git 이력을 본다.
- 승격 기준과 절차는 `docs/agents/rubber-workflow.md` "설계 → 장기 문서화". 대안 비교가 핵심인 결정은 `docs/adr/`.

번호는 읽기 순서이고, 새 문서는 끝 번호 다음에 붙인다.

| 문서                                                         | 내용                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [01-db-driver-portability.md](./01-db-driver-portability.md) | PostgreSQL·SQLite 두 드라이버의 공유 코드와 분기 규칙: 스키마·쿼리·GC 락·백업/복구·테스트 구조                                            |
| [02-receipt-error-replay.md](./02-receipt-error-replay.md)   | 조건부 mutation receipt의 결정적 4xx 저장·재생 경계, 오류 분류표, 412 `current`, snapshot `sourceRevision`, 드라이버별 직렬화와 검증 범위 |
| [03-consumer-contracts.md](./03-consumer-contracts.md)       | 특정 소비자에서 시작한 요구의 재사용 가능성 평가, Storix 기능과 소비자 어댑터의 책임 경계, 검증 범위                                      |
| [04-namespace-logical-quota.md](./04-namespace-logical-quota.md) | namespace live FILE 및 보존 snapshot FILE entry의 논리 사용량 상한, 동시성·오류·관리 API 계약 |
