# 초기 릴리스는 파일 업로드에 raw stream만 지원한다

`POST content`(ADR-0018 이전에는 `PUT content`)는 raw request stream만 받고 `multipart/form-data`는 지원하지 않는다.
웹 UI 직접 업로드는 초기 범위 밖이고, 주 사용처는 호출 서버가 이미 파일을 stream으로
들고 있는 서버 간 연동이므로 multipart 파싱 계층을 추가할 이유가 없었다. 이후 웹
업로드를 지원하더라도 part를 MinIO로 직접 streaming하는 구현만 허용한다.
