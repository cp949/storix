# nginx reverse-proxy 샘플은 self-signed TLS를 실제로 종료하고, 인증서는 커밋하지 않고 기동 시 생성한다

## 상태

승인됨 (2026-09-07) — 구현 완료, whole-branch review 통과.

## 배경

ADR-0013(STORAGE-02, `apps/api/docs/adr/`)은 presigned URL의 내부/외부 MinIO Client를
분리하면서 STORAGE-03이 예고한 "공개 도메인(443/TLS) → nginx → 내부 MinIO(9000/HTTP)"
배포에서 host만 분리하면 서명된 URL의 scheme/port가 내부값으로 남아 외부에서
접근 불가능해진다고 지적했다. STORAGE-03은 이 위험이 실제로 해소됨을 재현·검증하는
샘플 구성이다.

## 결정

루트 `docker-compose.yml`에 nginx 서비스를 추가한다.

- nginx가 self-signed 인증서로 443/HTTPS를 종료하고, 내부적으로 `minio:9000`(HTTP)로
  프록시한다. `Host` 헤더와 쿼리스트링을 그대로 통과시킨다.
- `GET`만 허용한다(`limit_except GET { deny all; }`). presigned URL의 유일한 용도가
  다운로드이므로, 그 외 메서드는 프록시 레벨에서 차단한다.
- 인증서는 저장소에 커밋하지 않는다. 기존 `minio-init` 서비스와 같은 패턴으로,
  별도 init 단계에서 `openssl`로 기동 시점에 생성한다.
- 인증서 CN/SAN은 `localhost`로 고정한다. testcontainers가 노출하는 주소가 결국
  `localhost`이므로(`presigned-download.integration-spec.ts`와 동일 원칙), 이 값이어야
  자동화 통합 테스트가 성립한다. 운영 배포 문서에는 실제 도메인으로 교체하라는
  자리표시자로 남긴다.
- 이 구성을 검증할 때 `MINIO_PUBLIC_ENDPOINT`/`MINIO_PUBLIC_PORT`/`MINIO_PUBLIC_USE_SSL`을
  실제 클라이언트가 nginx에 접속하는 host/port/scheme과 동일하게 맞춘다(로컬
  수동 검증은 `localhost`/`8443`/`true`, 자동 통합 테스트는 testcontainers가
  할당하는 임의 포트를 그대로 씀 — 특정 포트가 필수인 게 아니라 서명 값과
  실제 접속값의 일치가 핵심).
- 검증은 testcontainers `GenericContainer`로 nginx를 띄우는 별도 통합 테스트
  `nginx-reverse-proxy.integration-spec.ts`로 자동화한다. 기존
  `presigned-download.integration-spec.ts`는 그대로 두고 확장하지 않는다 — nginx
  컨테이너 기동으로 늘어나는 실행 시간을 별도 파일로 격리한다.
- `apps/demo`에 이 흐름을 소비하는 프론트엔드를 만드는 작업은 스코프 밖이다.
  `apps/demo`는 현재 Vite 템플릿 그대로이며, "공개 도메인 → nginx → 내부 MinIO" 인프라
  자체는 `apps/demo`의 존재 여부와 무관하게 루트 `docker-compose.yml` 레벨에서
  성립한다.

## Considered Options

- **인증서를 저장소에 고정 커밋**: 재현성은 확실하지만 개인키를 git에 두는 위생
  문제와 만료 관리 부담이 있어 보류했다.
- **TLS를 생략하고 Host 헤더/쿼리스트링 통과만 검증**: 구현은 더 간단하지만
  ADR-0013이 지목한 정확한 위험(scheme/port 불일치)이 검증되지 않은 채 남아
  STORAGE-03의 존재 이유가 절반만 충족되므로 보류했다.
- **MinIO로 가는 트래픽을 메서드 제한 없이 전부 통과**: 구현이 더 단순하지만,
  presigned GET 전용 용도에 비해 공개 도메인에 MinIO의 S3 API 표면(PUT/DELETE 등)을
  불필요하게 넓게 노출하므로 보류했다.

## Consequences

- self-signed 인증서이므로 클라이언트(브라우저·curl·통합 테스트)는 인증서 신뢰
  예외 처리가 필요하다. 통합 테스트는 TLS 검증을 비활성화하거나 생성된 CA를
  신뢰 목록에 추가해 처리한다.
- 운영 배포자는 샘플 nginx.conf의 self-signed 인증서 발급 부분을 실제 CA 발급
  인증서로 교체해야 한다 — `docs/deployment/nginx-reverse-proxy.md`에 자리표시자로
  명시한다.
- 현재 `.github/workflows/`에는 `security.yml`(의존성/이미지 스캔)만 있고, 이
  통합 테스트를 포함해 어떤 통합 테스트도 CI에서 실행되지 않는다. STORAGE-03
  이전부터 있던 갭이며 이 결정의 범위 밖이다.
