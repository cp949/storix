# Namespace ID는 선택 prefix를 지원하고 name은 nullable로 둔다

## 상태

승인됨 (2026-10-02)

## 결정

- Namespace ID는 기존 소문자 UUID 또는 `{prefix}_{UUID v4의 하이픈 제거 32자리}`다. Prefix는 최대 12자이며 소문자 영숫자, `_`, `-`를 허용한다.
- ID는 애플리케이션에서 생성한다. 참조 컬럼은 PostgreSQL에서 `varchar(45) COLLATE "C"`를 사용한다.
- `name`은 nullable한 재사용 가능한 slug다. namespace ID의 별칭이나 식별자로 사용하지 않는다.
- API 응답은 ID 표기를 정규화하지 않는다. 대소문자·하이픈 변형은 다른 형식으로 취급하지 않고 거부한다.

## 대안

- UUID만 유지하면 소비자의 routing prefix를 별도 저장·전달해야 한다.
- 별도 외부 키 컬럼은 모든 경로·receipt·참조에 추가 매핑과 조회를 요구한다.
- DB default 생성은 SQLite와 PostgreSQL의 생성 규칙을 갈라놓으므로 앱에서 ID를 만든다.

## 결과

기존 UUID namespace는 호환된다. UUID 형식으로 ID를 파싱하는 클라이언트는 새 prefix 형식 지원이 필요하다. migration down은 새 형식 ID가 남아 있으면 진행할 수 없다.

```text
위험도: 높음
롤백: 새 형식 ID를 모두 기존 UUID로 역변환한 뒤 migration down을 실행하거나 migration 전 백업을 복원한다.
```
