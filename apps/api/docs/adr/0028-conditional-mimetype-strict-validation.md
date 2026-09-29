# setMimeType은 content PUT의 관대한 대체 대신 엄격 거부를 쓴다

조건부 mutation `setMimeType`(ST-009)은 호출자가 지정한 `mimeType` 문자열을
검증해야 한다. Storix에는 이미 두 가지 다른 mimeType 검증 정책이 있다: 조건부
content PUT의 `normalizeMimeType`(검증 실패 시 `application/octet-stream`으로
조용히 대체)과 `upload-session-request.dto.ts`의 엄격 검증(형식 오류를 400으로
거부). `setMimeType`은 이 중 하나를 골라야 한다.

## 결정

1. `upload-session`과 같은 엄격 거부를 쓴다. `MIME_PATTERN`(`type/subtype`,
   대소문자 무관, 파라미터 불허)에 맞지 않으면 400 `VFS_INVALID_MUTATION_REQUEST`다.
2. 세미콜론 파라미터(`; charset=...`)는 자르지 않는다. 파라미터가 있으면 그
   자체로 거부한다.
3. 신규 전용 에러 코드는 도입하지 않는다. 기존 `VfsInvalidMutationRequestError`
   (400)를 그대로 쓴다.

## 검토한 대안

- **`normalizeMimeType`과 같은 관대한 대체**: 검증에 실패한 값을 조용히
  `application/octet-stream`으로 바꿔 저장한다. content PUT은 `Content-Type`
  헤더가 클라이언트·프록시가 관례적으로 파라미터를 붙이는 자리라 관대함이
  맞지만, `setMimeType`은 호출자가 JSON 필드로 값을 명시적으로 지정하는
  명령이다. 지정한 값을 검증 실패 시 다른 값으로 조용히 바꿔 저장하면 호출자가
  실제 저장된 값을 응답에서 다시 확인해야 하고, 그 사실 자체가 계약상
  놀랍다(surprising). 채택하지 않았다.
- **`setMimeType` 전용 에러 코드 도입(예: `VFS_INVALID_MIME_TYPE`)**: 신규
  코드 하나를 추가하는 비용 대비 얻는 정보가 적다. `upload-session-request.dto.ts`가
  이미 형식 오류에 범용 `VFS_INVALID_MUTATION_REQUEST`를 쓰고 있어 같은
  코드를 재사용하면 클라이언트가 구분해야 할 오류 코드 수가 늘지 않는다.
  채택하지 않았다.
- **세미콜론 파라미터를 잘라내고 나머지만 검사**: `Content-Type` 헤더 관례를
  따르면 `text/plain; charset=utf-8`도 통과시킬 수 있다. 그러나 이 명령은
  헤더가 아니라 JSON 필드로 값을 받으므로 헤더 파싱 관례를 적용할 이유가
  없고, 자르고 저장하면 호출자가 보낸 원문과 저장된 값이 달라져 두 번째
  놀라움을 추가한다. 채택하지 않았다.

## 근거

호출자가 명시적으로 지정한 값을 검증 실패 시 조용히 다른 값으로 바꿔 저장하는
것은 계약상 놀랍다: 저장 결과를 확인하려면 응답을 다시 읽어야 하고, 같은 key
재시도의 fingerprint가 실제 저장값이 아니라 원본 요청값 기준이라 혼란을
더한다. `upload-session-request.dto.ts`가 이미 같은 `MIME_PATTERN`과 같은
에러 코드로 엄격 검증하는 선례가 있어, 이 정책을 재사용하면 신규 코드·신규
정규식 도입 비용이 없다.

## 결과

`mime.ts`의 `assertStrictMimeType`이 이 정책을 구현하고 `normalizeMimeType`은
content PUT 전용으로 변경 없이 남는다. 세미콜론 포함이나 형식 오류는 400
`VFS_INVALID_MUTATION_REQUEST`이며, 이 400은 `/fs/mutations`의 일반 요청
형식 오류와 같은 receipt 규칙을 따른다: claim을 얻은 뒤 기록되므로 같은 key
재시도는 최초 status·body·`X-Request-Id`를 재생하고, 유효한 값으로 같은
key를 재사용하면 409 `MUTATION_KEY_REUSED`다(ADR-0024). 호출자가 대소문자나
공백 차이로 실패하는 경우가 늘면 별도 검토가 필요하지만, 지금은 upload-session
소비자가 같은 제약으로 이미 운영되고 있어 추가 완화 근거가 없다.
