# MinIO compose override와 통합 테스트용 MinIO 컨테이너를 제거하고 VersityGW로 통일한다

## 상태

승인됨 (2026-09-29) — 구현 완료.

## 배경

MinIO 프로젝트는 2026-04-25에 upstream 저장소를 archive했다. 2026-09-11 이후
Docker Hub의 `minio/minio`·`minio/mc` 저장소가 삭제됐다(Hub API가 404를
반환한다). `quay.io/minio/minio`도 익명 pull이 401로 거부된다.
Storix에는 이 이미지에 의존하는 곳이 세 군데 있었다:

- `docker-compose.minio.yml`과 `README.minio.md`(pin: `minio/minio:RELEASE.2025-09-07T16-13-09Z`,
  `minio/mc:latest`).
- `apps/api` 통합 테스트 21개 파일이 `@testcontainers/minio`로 같은 이미지를 띄웠다.
  이 이미지를 받을 수 없으면 PostgreSQL/SQLite L2 통합 검증 전체가 실행되지 않는다.
- nginx reverse-proxy 샘플(`docs/deployment/compose.nginx-demo.yml`)의
  `minio:9000` upstream.

ADR-0003이 이미 목표 기본 백엔드를 VersityGW로 정했고, "MinIO 지원 유지 자체가
목표가 아니다"라고 기록했다.

## 결정

1. `docker-compose.minio.yml`과 `README.minio.md`를 삭제한다. S3 호환 스토리지
   지원은 `STORIX_STORAGE_*` 벤더 중립 추상화(`apps/api/docs/adr/0012-minio-sdk-generic-s3-client.md`)로
   유지되므로, 이미 운영 중인 MinIO 서버에는 base 단독 구성(외부 S3 호환)으로 계속 연결할 수 있다.
2. 통합 테스트의 S3 컨테이너를 `@testcontainers/minio` 대신 VersityGW(posix,
   `docker-compose.versitygw.yml`과 같은 이미지·환경 변수)로 통일한다. 테스트는
   `apps/api/test/storage/s3-container.test-support.ts`의 `startS3Container()`만 쓴다.
   `@testcontainers/minio` devDependency를 제거한다.
3. nginx reverse-proxy 샘플의 upstream을 `versitygw:7070`으로 바꾼다. ADR-0004가
   "백엔드 중립화(VersityGW upstream)는 계획하지 않는다"고 한 결정은 이 변경으로 대체된다.
   샘플이 여전히 특정 백엔드 하나에 고정되는 개발·검증 도구라는 성격은 같다.
4. 앱 코드는 바꾸지 않는다. `minio` npm 패키지는 S3 클라이언트 SDK로 계속 쓰고,
   `MinioBlobStorage` 등 클래스명과 백업 디렉터리 이름 `minio/`도 유지한다.
   (`minio/`는 백업 산출물의 형식이라 이름을 바꾸면 기존 백업과 호환되지 않는다.)

## 근거

Storix가 쓰는 S3 연산(크기 미지정 스트림 multipart put, range get, presigned GET과
`response-content-disposition`, presigned 변조 거부, 재귀 list, delete 후 NoSuchKey)을
minio-js로 실행하는 프로브를 후보 3종에 돌렸다. VersityGW v1.8.0, SeaweedFS, RustFS가
각각 9/9 통과했다. Garage는 `dxflrs/garage:latest` 태그가 없어 실행하지 못했다.

## Considered Options

- **SeaweedFS(`chrislusf/seaweedfs`)**: 프로브 9/9 통과, Apache 2.0. 프로젝트 목표
  백엔드가 아니라 테스트와 운영 백엔드가 어긋난다. 보류.
- **RustFS(`rustfs/rustfs`)**: 프로브 9/9 통과. alpha 릴리즈라 회귀 기준 백엔드로
  쓰기에 이르다. 보류.
- **`quay.io/minio` 등 다른 레지스트리로 repoint**: 익명 pull이 401이라 사용할 수 없다.
- **MinIO 소스 빌드 또는 커뮤니티 fork 이미지 사용**: upstream이 archive됐고 출처 신뢰를
  검증할 수 없어 공급망 부담만 남긴다. 보류.

## Consequences

- MinIO 서버 조합의 compose 병합은 제공하지 않는다. `docker-compose.minio.yml`을 쓰던 환경은
  `docker-compose.versitygw.yml`로 옮기거나 외부 MinIO에 base 단독으로 붙인다.
  기존 MinIO 데이터를 VersityGW로 옮기는 절차는 이 저장소가 제공하지 않는다.
- 통합 테스트는 실제 목표 백엔드(VersityGW)를 대상으로 한다. MinIO에서만 성립하던 동작에
  의존한 테스트가 있으면 이 변경에서 드러난다.
- 과거 ADR, ROADMAP, CHANGELOG, `docs/requirements`의 "PostgreSQL/MinIO" 검증 기록은
  당시 사실이므로 고치지 않는다.
- `MinioBlobStorage` 이름과 `minio/` 백업 디렉터리 이름 정리는 별도 작업이다.
