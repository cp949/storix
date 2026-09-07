# Presigned download URL은 ENCRYPTED namespace를 지원하지 않고, 실접근은 감사 로그 밖에 있다

STORAGE-02는 `BlobStorage`에 `getPresignedUrl()`을 추가해 클라이언트가 Storix를 거치지
않고 MinIO에서 직접 객체를 받게 한다. 이 우회는 기존 결정 두 가지와 충돌한다.

ADR-0009(SEC-03)가 구현한 `ENCRYPTED` policy는 저장 객체 자체를 AES-256-CTR 암호문으로
두고, 복호화는 Storix의 `getEncrypted()` 헬퍼에서만 일어난다. presigned URL은 Storix를
우회하므로 클라이언트가 복호화 불가능한 암호문을 그대로 받게 된다 — 발급 API는
`ENCRYPTED` namespace 대상 요청을 409로 거부한다.

ADR-0010(SEC-04)의 `AuditLogInterceptor`는 요청이 Storix에 도달해야만 기록한다.
presigned URL **발급** 요청은 기록되지만, 발급된 URL로 클라이언트가 MinIO에서 직접 받는
**실제 콘텐츠 조회**는 Storix를 거치지 않아 `audit_log`에 남지 않는다 — ADR-0010이 이미
인증 실패 요청에 대해 남긴 "완전한 기록으로 오해하면 안 됨" 경고와 같은 종류의 공백이다.

발급용 minio Client는 내부 통신용(`MINIO_ENDPOINT`/`MINIO_PORT`/`MINIO_USE_SSL`)과
별개로 `MINIO_PUBLIC_ENDPOINT`/`MINIO_PUBLIC_PORT`/`MINIO_PUBLIC_USE_SSL`을 전부
분리해 구성한다(자격증명·`MINIO_PATH_STYLE`·`MINIO_REGION`은 내부 설정 재사용).
presigned 서명은 서명 시점 Client의 host/port/scheme으로 만들어지므로, STORAGE-03이
예고한 "공개 도메인(443/TLS) → nginx → 내부 MinIO(9000/HTTP)" 배포에서 host만
분리하면 서명된 URL의 scheme/port가 내부값으로 남아 외부에서 접근 불가능해진다.

## Considered Options

- **임시 복호화 사본을 만들어 `ENCRYPTED` namespace도 presigned 지원**: TTL 관리·정리
  로직·추가 저장 공간이 필요하고, 복호화된 사본이 잠시라도 별도 위치에 존재하게 돼
  공격 표면이 늘어난다. STORAGE-02 스코프를 넘는다고 보고 보류했다.
- **`MINIO_PUBLIC_ENDPOINT`만 분리하고 port/TLS는 내부 설정 재사용**: env var 수가
  적어 단순하지만, TLS를 종료하는 리버스 프록시(STORAGE-03) 뒤에서는 서명이 깨지는
  실제 배포 형태를 지원하지 못해 보류했다.

## Consequences

- `ENCRYPTED` namespace를 쓰는 배포는 presigned 다운로드를 발급받을 수 없다 — 그런
  배포는 기존 `/download`(Storix 프록시 스트리밍)를 계속 쓴다.
- `audit_log`는 여전히 "모든 콘텐츠 접근의 완전한 기록"이 아니다(ADR-0010에 이미
  기록된 한계의 연장).
- 발급된 presigned URL 자체가 TTL 동안 유효한 bearer 자격증명이다 — SEC-01 API
  key 없이도 그 URL을 아는 누구나(브라우저 히스토리, HTTP referrer, 프록시 로그로
  유출된 경우 포함) 콘텐츠를 받을 수 있다.
