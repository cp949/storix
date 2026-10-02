# Presigned download URL은 ENCRYPTED namespace를 지원하지 않고, 실접근은 감사 로그 밖에 있다

`STORAGE-02`는 `BlobStorage.getPresignedUrl()`로 스토리지 직접 다운로드를 제공한다.
클라이언트는 콘텐츠를 받을 때 Storix를 거치지 않는다.

## ENCRYPTED namespace 제한

- api ADR-0009의 `ENCRYPTED` policy는 객체를 AES-256-CTR 암호문으로 저장한다.
- 복호화는 Storix의 `getEncrypted()`에서 수행한다.
- presigned URL로 받는 객체는 복호화되지 않은 암호문이다.
- 발급 API는 `ENCRYPTED` namespace 요청을 409로 거부한다.

## 감사 로그 범위

api ADR-0010의 `AuditLogInterceptor`는 Storix에 도달한 요청을 기록한다.

- presigned URL 발급 요청은 기록한다.
- 발급된 URL의 실제 콘텐츠 조회는 `audit_log`에 남지 않는다.

실제 조회는 스토리지에 직접 도달하기 때문이다.
`audit_log`는 모든 콘텐츠 접근의 완전한 기록이 아니다.

## 공개 endpoint 분리

발급용 S3 Client(`STORAGE_PUBLIC_CLIENT`)는 내부 통신용 Client와 분리한다.
아래 환경변수 이름은 기존 ADR 표기다.
현재 설정에는 `STORIX_` 접두어를 붙인다.

| 항목   | 내부 통신          | 공개 URL                  |
| ------ | ------------------ | ------------------------- |
| host   | `STORAGE_ENDPOINT` | `STORAGE_PUBLIC_ENDPOINT` |
| port   | `STORAGE_PORT`     | `STORAGE_PUBLIC_PORT`     |
| scheme | `STORAGE_USE_SSL`  | `STORAGE_PUBLIC_USE_SSL`  |

자격증명·`STORAGE_PATH_STYLE`·`STORAGE_REGION`은 내부 설정을 재사용한다.

분리 근거:

- presigned 서명은 서명 시점 Client의 host/port/scheme을 사용한다.
- `STORAGE-03`은 공개 도메인(443/TLS) → nginx → 내부 스토리지(HTTP) 배포를 지원한다.
- host만 분리하면 서명 URL의 scheme/port가 내부값으로 남는다.
- 이 URL은 외부에서 접근할 수 없다.

## Considered Options

- **임시 복호화 사본으로 ENCRYPTED presigned 지원**
  - TTL 관리·정리 로직·추가 저장 공간이 필요하다.
  - 복호화 사본이 별도 위치에 존재해 공격 표면이 늘어난다.
  - `STORAGE-02` 범위를 넘어 보류했다.
- **`STORAGE_PUBLIC_ENDPOINT`만 분리**
  - port/TLS를 내부 설정과 공유하면 환경변수 수를 줄일 수 있다.
  - TLS 종료 리버스 프록시 뒤의 공개 URL을 올바르게 서명할 수 없다.
  - `STORAGE-03` 배포를 지원하지 못해 보류했다.

## Consequences

- `ENCRYPTED` namespace는 기존 `/download`의 Storix 프록시 스트리밍을 사용한다.
- presigned URL의 실제 조회는 감사 로그 범위 밖이다.
- 발급된 URL은 TTL 동안 유효한 bearer 자격증명이다.
- URL을 아는 누구나 `SEC-01` API key 없이 콘텐츠를 받을 수 있다.
- 브라우저 히스토리·HTTP referrer·프록시 로그로 URL이 유출돼도 같은 권한을 갖는다.
