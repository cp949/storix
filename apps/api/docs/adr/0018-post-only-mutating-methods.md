# 쓰기/삭제 라우트는 PUT/DELETE 대신 POST만 사용한다

`fs.controller.ts`의 HTTP 메소드를 변경한다.

| 기존           | 변경           |
| -------------- | -------------- |
| `PUT content`  | `POST content` |
| `DELETE rmdir` | `POST rmdir`   |
| `DELETE rm`    | `POST rm`      |

## 결정 근거

- 사내 네트워크 정책은 GET/POST 외 HTTP 메소드를 차단한다.
- `mkdir`/`touch`/`mv`/`cp`는 이미 POST + 동사형 경로를 사용한다.
- URL은 유지하고 메소드 데코레이터를 교체한다.
- REST 메소드 시맨틱(멱등성 표현 등)보다 네트워크 정책 준수를 우선한다.
- 이후 쓰기/삭제 엔드포인트에도 POST + 동사형 경로를 적용한다.

후속 resumable upload의 part 전송은 PUT을 사용한다(api ADR-0026).

## Consequences

- `apps/api/src/common/body-parser.ts`의 `isRawUploadRoute()`도 변경한다.
- content 업로드 판별 조건을 `req.method === 'PUT'`에서 `'POST'`로 바꾼다.
- 이 조건을 그대로 두면 body-parser가 업로드 stream을 소비할 수 있다.
- api ADR-0004의 업로드 라우트 표기도 `POST content`로 맞춘다.
