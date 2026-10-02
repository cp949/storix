# nginx reverse-proxy 샘플은 self-signed TLS를 실제로 종료하고, 인증서는 커밋하지 않고 기동 시 생성한다

## 상태

승인됨 (2026-09-07)

- 구현 완료.
- whole-branch review 통과.

## 배경

api ADR-0013(STORAGE-02)은 presigned URL용 내부·외부 S3 Client를 분리한다.
STORAGE-03은 다음 배포 구성을 검증한다.

```text
공개 도메인(443/TLS) → nginx → 내부 스토리지(HTTP)
```

host만 분리하면 서명된 URL의 scheme/port가 내부값으로 남는다. 이 URL은 외부에서 접근할 수 없다.
STORAGE-03 샘플은 이 위험의 해소 여부를 재현·검증한다.

## 결정

루트 `docker-compose.yml`에 nginx 서비스를 추가한다.

- nginx는 self-signed 인증서로 443/HTTPS를 종료한다.
- upstream은 `versitygw:7070`(HTTP)이다.
- `Host` 헤더와 쿼리스트링을 그대로 전달한다.
- `GET`만 허용한다(`limit_except GET { deny all; }`).
  - presigned URL의 용도는 다운로드뿐이다.
  - 그 외 메서드는 프록시에서 차단한다.
- 인증서는 기동 시 별도 init 단계에서 `openssl`로 생성한다.
  - 저장소에는 커밋하지 않는다.
- 인증서 CN/SAN은 `localhost`로 고정한다.
  - testcontainers가 노출하는 주소에 맞춘다.
  - `presigned-download.integration-spec.ts`와 같은 원칙이다.
  - 운영 문서에는 실제 도메인으로 교체하도록 명시한다.
- 다음 변수는 클라이언트가 nginx에 접속하는 host/port/scheme에 맞춘다.
  - `STORAGE_PUBLIC_ENDPOINT`
  - `STORAGE_PUBLIC_PORT`
  - `STORAGE_PUBLIC_USE_SSL`
  - 로컬 수동 검증 값은 `localhost`/`8443`/`true`다.
  - 자동 통합 테스트는 testcontainers가 할당한 임의 포트를 쓴다.
  - 필수 조건은 특정 포트가 아니라 서명 값과 실제 접속값의 일치다.
- `nginx-reverse-proxy.integration-spec.ts`에서 검증한다.
  - testcontainers `GenericContainer`로 nginx를 기동한다.
  - 기존 `presigned-download.integration-spec.ts`는 확장하지 않는다.
  - nginx 기동에 드는 실행 시간을 별도 테스트 파일로 분리한다.
- `apps/demo`에 이 흐름을 사용하는 프론트엔드를 만드는 작업은 범위 밖이다.
  - 결정 시점의 `apps/demo`는 Vite 템플릿이다.
  - 프록시 인프라는 `apps/demo` 없이도 루트 `docker-compose.yml`에서 동작한다.

## Considered Options

- **인증서를 저장소에 커밋**: 보류한다.
  - 재현성은 확보된다.
  - 개인키 노출과 인증서 만료 관리 부담이 있다.
- **TLS 없이 Host 헤더·쿼리스트링 전달만 검증**: 보류한다.
  - 구현은 간단해진다.
  - api ADR-0013의 scheme/port 불일치 위험을 검증하지 못한다.
- **메서드 제한 없이 스토리지 트래픽 전달**: 보류한다.
  - 구현은 단순해진다.
  - presigned GET 용도에 불필요한 S3 API(`PUT`/`DELETE` 등)를 공개한다.

## Consequences

- self-signed 인증서는 클라이언트의 신뢰 예외 처리가 필요하다.
  - 대상은 브라우저·curl·통합 테스트다.
  - 통합 테스트는 TLS 검증을 비활성화하거나 생성된 CA를 신뢰 목록에 추가한다.
- 운영 배포자는 샘플의 인증서 발급 구성을 실제 CA 발급 인증서로 교체해야 한다.
  - 안내는 `docs/deployment/nginx-reverse-proxy.md`에 둔다.
- 결정 시점의 `.github/workflows/`에는 `security.yml`만 있다.
  - 의존성·이미지 스캔을 수행한다.
  - 이 테스트를 포함한 통합 테스트는 CI에서 실행하지 않는다.
  - STORAGE-03 이전부터 있던 검증 공백이며 이 결정의 범위 밖이다.
