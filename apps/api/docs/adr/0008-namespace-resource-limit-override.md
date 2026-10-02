> 대체됨: api ADR-0037이 namespace 상한을 default와 ceiling으로 분리하고 counter 제한을 추가한다.

# namespace별 리소스 상한은 전역값을 상한으로 하는 오버라이드 컬럼으로 구현한다

## 결정 배경

다음 상한을 배포 전체의 전역 env var로만 관리하던 구조에 namespace별 제한을 도입한다(SEC-02).

- 파일 업로드 크기: `MAX_FILE_SIZE_BYTES`
- 동기 rm 처리 노드 수: `MAX_SYNC_DELETE_NODES`
- 동기 cp 처리 노드 수: `MAX_SYNC_COPY_NODES`

## namespace 상한

`NamespaceEntity`에 nullable 컬럼을 추가한다.

- `maxFileSizeBytes`
- `maxSyncDeleteNodes`
- `maxSyncCopyNodes`

상한 계산 규칙:

- 컬럼이 `NULL`이면 전역 env var를 쓴다.
- 값이 있으면 `min(namespace 값, 전역값)`을 쓴다.
- 전역값은 항상 hard ceiling이다.
- namespace 상한은 전역값을 넘을 수 없다.

값 설정·변경 API는 만들지 않는다.

- 예상 변경 빈도에는 운영자의 직접 DB 갱신으로 충분하다고 판단했다.
- 관리 API는 `apps/admin` 단계나 별도 후속 티켓에서 검토한다.

## 제어 요청 상한

- JSON/urlencoded 제어 요청에는 16KB 고정 상한을 적용한다.
- 이 상한은 namespace별로 조정하지 않는다.
- 파일 콘텐츠가 아닌 메타데이터 요청을 조기에 차단하는 전역 DoS 안전망이다.
- raw 업로드는 이 파서를 우회한다.
- raw 업로드에는 파일 크기 상한을 적용한다.
- 당시 업로드 경로는 `PUT .../fs/content`였다(api ADR-0018에서 `POST`로 변경).

## Considered Options

- **단일 JSONB 컬럼(`resourceLimits`)으로 세 값 관리**
  - 제한 항목이 늘어나도 스키마 변경 없이 확장할 수 있다.
  - 검토 시점의 항목은 세 개로 고정돼 있었다.
  - 타입 안정성·마이그레이션·쿼리 편의성이 개별 컬럼보다 낮다고 판단해 보류했다.
- **namespace 상한이 전역값을 초과하도록 허용**
  - 전역 env var는 배포 인스턴스가 감당할 수 있는 절대 상한이다.
  - namespace가 전역값을 초과하면 이 의미와 어긋난다.
  - 특정 namespace에 더 큰 상한이 필요해지면 이 결정을 재검토한다.
