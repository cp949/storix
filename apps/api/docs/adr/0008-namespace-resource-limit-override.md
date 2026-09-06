# namespace별 리소스 상한은 전역값을 상한으로 하는 오버라이드 컬럼으로 구현한다

Storix는 파일 업로드 크기(`MAX_FILE_SIZE_BYTES`)와 동기 mv/cp/rm 처리 노드 수
(`MAX_SYNC_DELETE_NODES`/`MAX_SYNC_COPY_NODES`) 상한을 배포 전체에 적용되는 전역
env var로만 관리해왔다(SEC-02). namespace별로 더 타이트한 상한을 걸 수 있도록
`NamespaceEntity`에 nullable 컬럼 3개(`maxFileSizeBytes`, `maxSyncDeleteNodes`,
`maxSyncCopyNodes`)를 추가한다. 컬럼이 `NULL`이면 전역 env var를 그대로 쓰고, 값이
있으면 `min(namespace 값, 전역값)`으로 계산해 전역값을 항상 hard ceiling으로
유지한다 — namespace가 전역보다 더 관대한 상한을 가질 수는 없다. 값 설정/변경
API는 만들지 않는다: 운영자가 DB를 직접 갱신하는 것으로 충분한 빈도이고, 관리
API는 `apps/admin` 단계나 별도 후속 티켓에 더 맞는 성격이다.

## Considered Options

- **단일 JSONB 컬럼(`resourceLimits`)으로 세 값 묶기**: 향후 축이 늘어나도 스키마
  변경 없이 확장 가능하지만, 지금 축이 3개로 고정돼 있어 이점이 없고 타입
  안정성·마이그레이션·쿼리 편의성만 떨어져 보류했다.
- **namespace 값이 전역값보다 커질 수 있게(전역을 override) 허용**: "리소스
  상한은 이 배포 인스턴스가 감당 가능한 절대치"라는 전역 env var의 인프라적
  의미와 어긋나 채택하지 않았다. 특정 namespace에 전역보다 큰 상한이 실제로
  필요해지면 이 결정을 재검토해야 한다.
