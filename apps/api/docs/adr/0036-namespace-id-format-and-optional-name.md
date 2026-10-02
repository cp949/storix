# Namespace ID는 선택 prefix를 지원하고 name은 nullable로 둔다

## 상태

승인됨 (2026-10-02)

## 결정

- Namespace ID는 다음 표기를 지원한다.
  - 기존 소문자 하이픈 UUID.
  - UUID v4에서 하이픈을 제거한 32자리 표기.
- 새 ID의 prefix는 선택 사항이다.
  - 지정하면 `{prefix}_{32자리 hex}`로 생성한다.
  - Prefix 문법은 `[a-z][a-z0-9_-]{0,11}`이다.
- ID는 애플리케이션에서 생성한다.
- PostgreSQL 참조 컬럼은 `varchar(45) COLLATE "C"`를 쓴다.
- `name`은 nullable한 재사용 가능 slug다.
  namespace ID의 별칭이나 식별자로 쓰지 않는다.
- API 응답은 ID 표기를 정규화하지 않는다.
  허용 형식 밖의 대소문자·하이픈 변형은 거부한다.

## 대안

- **UUID만 유지**: 소비자의 routing prefix를 별도로 저장·전달해야 한다.
- **별도 외부 키 컬럼**: 모든 경로·receipt·참조에 매핑과 조회가 추가된다.
- **DB default로 ID 생성**:
  - SQLite와 PostgreSQL의 생성 규칙이 달라진다.
  - 애플리케이션에서 ID를 생성한다.

## 결과

- 기존 UUID namespace는 호환된다.
- UUID로 ID를 파싱하는 클라이언트는 새 prefix 형식을 지원해야 한다.
- 새 형식 ID가 남아 있으면 migration down을 진행할 수 없다.

```text
위험도: 높음
롤백: 새 형식 ID를 모두 기존 UUID로 역변환한 뒤 migration down을 실행하거나 migration 전 백업을 복원한다.
```
