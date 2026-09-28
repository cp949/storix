# 설계 문서

장기적으로 유지할 가치가 있는 설계만 둔다. ADR보다 상세한 현재 시점의 설계 기술이다. 일회성 작업의 설계는 여기에 두지
않는다(`_works/`).

- 소스 코드 줄 번호를 적지 않는다.
- 이력을 남기지 않는다. 기능이 바뀌면 문서를 현재 내용으로 고쳐 쓴다. 이력은 git 이력을 본다.
- 승격 기준과 절차는 `docs/agents/rubber-workflow.md` "설계 → 장기 문서화". 대안 비교가 핵심인 결정은 `docs/adr/`.

번호는 읽기 순서이고, 새 문서는 끝 번호 다음에 붙인다.

| 문서                                                             | 내용                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [01-db-driver-portability.md](./01-db-driver-portability.md)     | PostgreSQL·SQLite 두 드라이버의 공유 코드와 분기 규칙: 스키마·쿼리·GC 락·백업/복구·테스트 구조                                            |
| [02-receipt-error-replay.md](./02-receipt-error-replay.md)       | 조건부 mutation receipt의 결정적 4xx 저장·재생 경계, 오류 분류표, 412 `current`, snapshot `sourceRevision`, 드라이버별 직렬화와 검증 범위 |
| [03-consumer-contracts.md](./03-consumer-contracts.md)           | 특정 소비자에서 시작한 요구의 재사용 가능성 평가, Storix 기능과 소비자 어댑터의 책임 경계, 검증 범위                                      |
| [04-namespace-logical-quota.md](./04-namespace-logical-quota.md) | namespace live FILE, 보존 snapshot 및 휴지통 FILE entry의 논리 사용량 상한, 동시성·오류·관리 API 계약                                     |
| [05-vfs-path-contract.md](./05-vfs-path-contract.md)             | 파일·snapshot의 정규 경로, 허용 문자·UTF-8 길이, 부모·루트 동작과 이동·복사 결과 경로 불변식                                              |
| [06-vfs-capabilities.md](./06-vfs-capabilities.md)               | 선택 VFS capability의 시작 설정, 정적 registry, 활성 판정, 오류·데이터 보존 경계와 활성 조회 API                                          |
| [07-resumable-upload.md](./07-resumable-upload.md)               | 업로드 세션의 생성·조각·완료·취소 계약, 암호화와 임시 quota, 원자적 공개·정리 불변식                                                      |
| [08-namespace-change-feed.md](./08-namespace-change-feed.md)     | namespace 변경 journal·checkpoint·cursor, capability 연속성, 보존·GC와 소비자 재동기화 불변식                                             |
| [09-vfs-trash-and-recovery.md](./09-vfs-trash-and-recovery.md)   | 삭제 manifest, 30일 복구, 원래 ID와 새 revision, quota·Blob 수명, 명시적/자동 purge 계약                                                  |
| [10-file-expiry.md](./10-file-expiry.md)                         | 생성 시 파일 만료 지정, `persist` 확정, GC 만료 삭제, 공개 읽기 제외와 연산별 만료 전파                                                   |
