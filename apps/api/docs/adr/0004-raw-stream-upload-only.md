# 초기 릴리스는 파일 업로드에 raw stream만 지원한다

- `POST content`는 raw request stream만 받는다.
- `multipart/form-data`는 지원하지 않는다.
- api ADR-0018 이전에는 `PUT content`를 사용했다.
- 이후 웹 업로드를 지원하더라도 part를 스토리지로 직접 streaming하는 구현만 허용한다.

## 결정 근거

- 웹 UI 직접 업로드는 초기 범위에 포함하지 않는다.
- 주 사용처는 호출 서버가 파일을 stream으로 보유한 서버 간 연동이다.
- 이 연동에는 multipart 파싱 계층이 필요하지 않다.
