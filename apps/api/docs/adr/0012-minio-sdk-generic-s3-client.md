# S3 호환 백엔드는 minio-js 클라이언트 하나로 지원하고 별도 어댑터 계층을 두지 않는다

STORAGE-01은 minio-js `Client`에 `pathStyle`/`region` 옵션을 노출해 S3 API 호환
백엔드(S3, MinIO, VersityGW)를 `MinioBlobStorage` 구현체 하나로 지원한다. 새
env var(`MINIO_PATH_STYLE`, `MINIO_REGION`)도 기존 컨벤션대로 `MINIO_*` 접두어를
유지하며, 클래스명·DI 토큰(`MinioBlobStorage`, `MINIO_CLIENT`)도 바꾸지 않는다.
minio-js SDK 자체가 이미 범용 S3 API 클라이언트이므로 `BlobStorage` 인터페이스
뒤에 벤더별 어댑터 계층을 추가로 두지 않는다.

## Considered Options

- **백엔드별 어댑터 계층 신설**(`S3Adapter`/`MinioAdapter`/`VersityAdapter` 등 분리):
  벤더별 SDK를 따로 쓸 계획이 없고 셋 다 동일 S3 API를 말하므로 불필요한 간접
  계층만 늘어나 보류했다.
- **env 접두어를 `S3_*`/`STORAGE_*`로 전환**: 백엔드-agnostic 의도를 이름에 더
  정확히 반영하지만, 코드 전반의 MinIO 특정 네이밍(클래스명, DI 토큰)과
  불일치하고 이번 스코프를 넘는 전면 리네이밍이 필요하며, self-host 배포 이후엔
  breaking change가 되므로 보류했다.
- **실 AWS S3/VersityGW 대상 통합 테스트를 이번 티켓에 포함**: 로드맵 실행순서상
  STORAGE-02/03과 함께 apps/demo 단계에서 재현·검증하기로 이미 정해져 있어
  스코프 밖으로 보류했다.
