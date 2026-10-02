# setMimeType은 content PUT의 관대한 대체 대신 엄격 거부를 쓴다

조건부 mutation `setMimeType`(ST-009)은 호출자가 지정한 `mimeType` 문자열을 검증해야 한다.
기존 검증 정책은 두 가지다.

- 조건부 content PUT의 `normalizeMimeType`: 검증 실패 시 `application/octet-stream`으로 대체한다.
- `upload-session-request.dto.ts`: 형식 오류를 400으로 거부한다.

`setMimeType`에는 엄격 거부 정책을 적용한다.

## 결정

1. `upload-session`과 같은 엄격 검증을 쓴다.
   `MIME_PATTERN`에 맞지 않으면 400 `VFS_INVALID_MUTATION_REQUEST`로 거부한다.
   - 형식: `type/subtype`.
   - 대소문자: 구분하지 않는다.
   - 파라미터: 허용하지 않는다.
2. 세미콜론 파라미터(`; charset=...`)는 자르지 않는다.
   파라미터가 있으면 거부한다.
3. 전용 에러 코드는 추가하지 않는다.
   기존 `VfsInvalidMutationRequestError`(400)를 쓴다.

## 검토한 대안

- **`normalizeMimeType`처럼 검증 실패 시 대체**:
  - 유효하지 않은 값을 `application/octet-stream`으로 저장하는 안이다.
  - content PUT의 `Content-Type`에는 클라이언트·프록시가 파라미터를 붙이는 관례가 있다.
  - 이 헤더에는 관대한 처리가 맞다.
  - `setMimeType`은 호출자가 JSON 필드로 값을 명시하는 명령이다.
  - 지정한 값을 다른 값으로 바꾸면 호출자가 저장 결과를 다시 확인해야 한다.
  - 명시적 입력과 저장 결과가 어긋나므로 채택하지 않았다.
- **전용 에러 코드 도입(예: `VFS_INVALID_MIME_TYPE`)**:
  - 신규 코드의 비용에 비해 추가로 전달하는 정보가 적다.
  - `upload-session-request.dto.ts`도 `VFS_INVALID_MUTATION_REQUEST`를 쓴다.
  - 기존 코드를 재사용하면 클라이언트가 처리할 오류 코드가 늘지 않는다.
  - 채택하지 않았다.
- **세미콜론 파라미터를 자르고 검사**:
  - `text/plain; charset=utf-8`도 허용할 수 있다.
  - JSON 필드에 헤더 파싱 관례를 적용할 이유가 없다.
  - 호출자가 보낸 값과 저장값이 달라져 채택하지 않았다.

## 근거

- 명시적 입력을 다른 값으로 대체하면 호출자가 응답에서 저장 결과를 다시 확인해야 한다.
- 같은 key 재시도의 fingerprint는 실제 저장값이 아닌 원본 요청값을 기준으로 한다.
- `upload-session-request.dto.ts`는 같은 `MIME_PATTERN`과 에러 코드로 엄격 검증한다.
- 기존 정책을 재사용하면 새 에러 코드와 정규식이 필요 없다.

## 결과

- `mime.ts`의 `assertStrictMimeType`이 엄격 검증을 구현한다.
- `normalizeMimeType`은 content PUT 전용으로 유지한다.
- 세미콜론이나 형식 오류는 400 `VFS_INVALID_MUTATION_REQUEST`로 거부한다.
- 이 400은 `/fs/mutations`의 일반 요청 형식 오류와 같은 receipt 규칙을 따른다(api ADR-0024).
  1. claim을 얻은 뒤 오류를 기록한다.
  2. 같은 key와 같은 fingerprint로 재시도하면 최초 status·body·`X-Request-Id`를 재생한다.
  3. 유효한 값으로 같은 key를 재사용하면 409 `MUTATION_KEY_REUSED`를 반환한다.
- 소비자가 대소문자나 공백 차이로 실패하는 경우가 늘면 별도 검토한다.
  도입 당시 upload-session 소비자는 같은 제약으로 운영되고 있었다.
  추가 완화 근거는 없었다.
