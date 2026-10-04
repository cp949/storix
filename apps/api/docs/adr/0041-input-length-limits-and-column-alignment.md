# 클라이언트 입력의 길이 상한은 입력별로 확장·대체·거절 중 하나로 정한다

## 상태

승인됨 (2026-10-04)

## 배경

PostgreSQL은 `varchar(N)` 컬럼에 N자를 넘는 값을 넣으면 22001로 실패한다.
SQLite는 길이를 강제하지 않는다.
길이를 검사하지 않는 입력은 PostgreSQL에서 500이 나고 SQLite에서 성공했다(GitHub 이슈 #12).

| 입력                                          | 허용 범위(수정 전) | 컬럼                                    |
| --------------------------------------------- | ------------------ | --------------------------------------- |
| `X-Request-Id`                                | 1~200자(미들웨어)  | 업로드 세션 `request_id` `varchar(128)` |
| `Content-Type`(content PUT·POST, conditional) | 길이 상한 없음     | `mime_type` `varchar(255)`              |
| `Idempotency-Key`(`POST /namespaces`)         | 길이 검사 없음     | `idempotency_key.key` `varchar(255)`    |

`audit_log.request_id`는 `varchar(200)`이다. 업로드 세션 컬럼만 128이었고 이 불일치를 의도한 결정은 없다.

## 결정

입력마다 아래 기준으로 처리 방식을 고른다.

1. 이미 받아들이기로 한 범위가 컬럼보다 넓으면 컬럼을 넓힌다.
   - `X-Request-Id`는 미들웨어가 200자까지 받고 `audit_log`도 200이다.
   - 업로드 세션 `request_id`·`creation_request_id`를 `varchar(200)`으로 넓힌다.
   - 201자 이상은 기존대로 미들웨어가 UUID로 대체한다.
2. 관대하게 처리하기로 한 입력은 상한을 넘으면 기본값으로 대체한다.
   - `Content-Type`은 `;` 뒤를 뗀 값이 255자를 넘으면 `application/octet-stream`으로 저장한다.
   - 형식 오류 처리와 같고 api ADR-0028의 content PUT 관대 처리와 일치한다.
3. 호출자가 키로 쓰는 입력은 상한을 넘으면 400으로 거절한다.
   - `POST /namespaces`의 `Idempotency-Key`는 255 byte를 넘으면 `IDEMPOTENCY_KEY_REQUIRED`(400)다.
   - 새 오류 코드는 추가하지 않는다.
   - 메시지는 이 경로에서만 "필요하며 255 byte 이하여야 함"으로 바꾼다.
   - Node는 헤더 값을 latin1로 읽으므로 문자 수가 byte 수다.
4. 마이그레이션은 PostgreSQL에서만 실행한다.
   - SQLite는 길이를 강제하지 않고 컬럼 변경에 테이블 재생성이 필요해 건너뛴다.
   - 엔티티 정의(200)와 SQLite 스키마(128)의 숫자는 어긋나지만 동작은 같다.
   - `down()`은 PostgreSQL에서 `varchar(128)`로 되돌린다.
     129자 이상 값이 있으면 22001로 실패하고 값을 자르지 않는다.
5. openapi `IdempotencyKeyHeader`에 `maxLength: 255`를 추가한다.
   - 256 byte 이상 키는 PostgreSQL에서 이미 500이었으므로 결함 수정으로 분류한다.
   - `info.version`은 1.0.0을 유지한다(ADR-0030).
   - SQLite에서 256 byte 이상 키가 성공하던 동작은 바뀐다. CHANGELOG에 적는다.

## 검토한 대안

- **`X-Request-Id`를 128자로 줄인다**:
  - 이미 200자를 받는 `audit_log`·미들웨어·응답 헤더와 어긋난다.
  - 129~200자를 보내던 호출자가 UUID로 대체된 ID를 받게 되어 채택하지 않았다.
- **`Content-Type` 상한 초과를 400으로 거절한다**:
  - content 경로는 클라이언트·프록시가 붙이는 값을 관대하게 받기로 했다(ADR-0028).
  - 형식 오류는 대체하는데 길이만 거절하면 처리 기준이 둘이 되어 채택하지 않았다.
- **`Idempotency-Key` 초과에 전용 오류 코드를 추가한다**:
  - 클라이언트가 처리할 코드가 늘고 추가로 전달하는 정보가 적어 채택하지 않았다.
- **SQLite 스키마도 `varchar(200)`으로 재생성한다**:
  - SQLite는 길이를 강제하지 않아 얻는 동작이 없다.
  - 업로드 세션 테이블 재생성 위험이 커서 채택하지 않았다.

## 결과

- 세 입력의 상한·상한+1 요청이 SQLite·PostgreSQL에서 같은 응답을 낸다.
  - `X-Request-Id` 200자: 업로드 세션 생성·완료가 성공하고 응답 헤더로 같은 ID를 돌려준다.
  - `X-Request-Id` 201자: UUID로 대체된다.
  - `Content-Type` 255자: 그대로 저장한다.
  - `Content-Type` 256자: `application/octet-stream`으로 저장한다.
  - `Idempotency-Key` 255 byte: 201.
  - `Idempotency-Key` 256 byte: 400 `IDEMPOTENCY_KEY_REQUIRED`.
- 같은 헤더의 255 byte 초과 오류 코드가 경로마다 다르다.
  - `POST /namespaces`: `IDEMPOTENCY_KEY_REQUIRED`.
  - `PATCH /namespaces/{id}/settings`: `NAMESPACE_INVALID_SETTINGS_REQUEST`.
  - `POST /admin/namespaces/{id}/delete`: `NAMESPACE_INVALID_DELETE_REQUEST`.
  - 코드 통일은 호환성을 깨므로 이 ADR에서 하지 않는다.
- `PATCH /namespaces/{id}/quota`와 `PATCH /namespaces/{id}/trash`는 255 byte 검사가 없다.
  키를 SHA-256으로 해시해 저장하므로 컬럼 초과는 없다.
  공유 `IdempotencyKeyHeader`의 `maxLength: 255`는 이 두 경로에서 서버보다 엄격한 문서다.
  정렬 여부는 별도 이슈에서 정한다.
- 이후 컬럼 길이가 있는 새 입력을 추가할 때는 위 1~3 중 하나를 고르고 SQLite 통과만으로 안전하다고 판단하지 않는다(TRP-005).
