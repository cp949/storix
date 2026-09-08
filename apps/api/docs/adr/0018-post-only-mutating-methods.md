# 쓰기/삭제 라우트는 PUT/DELETE 대신 POST만 사용한다

사내 네트워크 정책상 GET/POST 외 HTTP 메소드가 차단되어, `fs.controller.ts`의
`PUT content`, `DELETE rmdir`, `DELETE rm`을 각각 `POST content`, `POST rmdir`,
`POST rm`으로 변경한다. `mkdir`/`touch`/`mv`/`cp`가 이미 `POST` + 동사형 경로
컨벤션이었으므로 URL 재설계 없이 메소드 데코레이터만 교체했다. REST 메소드
시맨틱(멱등성 표현 등)보다 회사 네트워크 정책 준수를 우선한 결정이며, 이후
신규로 추가하는 쓰기/삭제 엔드포인트도 이 컨벤션(POST + 동사형 경로)을 따른다.

## Consequences

- `apps/api/src/common/body-parser.ts`의 `isRawUploadRoute()`가 `req.method === 'PUT'`을
  raw stream 업로드 판별 조건으로 쓰고 있어, `'POST'`로 함께 변경하지 않으면 업로드
  경로가 조용히 깨진다.
- ADR-0004가 이 라우트를 `PUT content`로 지칭하던 부분도 `POST content`로 갱신한다.
