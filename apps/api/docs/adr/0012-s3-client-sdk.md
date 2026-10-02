# S3 호환 백엔드는 AWS SDK v3 클라이언트 하나로 지원하고 별도 어댑터 계층을 두지 않는다

`S3BlobStorage`는 `@aws-sdk/client-s3`의 `S3Client`로 S3 호환 백엔드(S3, VersityGW)를 지원한다.
백엔드별 차이는 클라이언트 옵션으로 처리한다.
벤더별 어댑터 계층은 추가하지 않는다.

## 클라이언트 옵션

- **`endpoint`**
  - `STORIX_STORAGE_ENDPOINT`/`STORIX_STORAGE_PORT`/`STORIX_STORAGE_USE_SSL`로 URL을 조립한다.
- **`forcePathStyle`**
  - `STORIX_STORAGE_PATH_STYLE`을 사용한다.
  - 기본값은 `true`다.
- **`region`**
  - `STORIX_STORAGE_REGION`을 사용한다.
  - 미설정이면 `us-east-1`을 쓴다.
  - SDK는 리전을 자동 조회하지 않는다.
  - presigned URL 발급은 네트워크 요청을 만들지 않는다.
  - 백엔드가 리전을 지정하면 같은 값을 설정한다(AWS S3 버킷 리전, VersityGW `--region`).
- **`maxAttempts: 1`**
  - SDK 자동 재시도를 끈다.
  - 업로드 stream은 재생할 수 없다.
  - 실패는 즉시 전달한다.
  - 저장 장애는 호출자가 분류해 응답한다.
- **`requestChecksumCalculation`/`responseChecksumValidation`**
  - 둘 다 `WHEN_REQUIRED`를 사용한다.
  - 기본값 `WHEN_SUPPORTED`는 요청에 CRC32 체크섬과 `aws-chunked` 인코딩을 추가한다.
  - 일부 S3 호환 백엔드는 이를 거부한다.

## stream 업로드와 presigned URL

크기를 모르는 stream은 `@aws-sdk/lib-storage`의 `Upload`로 업로드한다.

- `partSize`: 16MiB
- `queueSize`: 1
- 업로드 버퍼 메모리는 파일 크기와 무관하다.
- 전송 중인 파트·누적 잔여분·파트 병합 복사본이 메모리에 겹친다.
- 기존 실측의 `arrayBuffers` 증가 피크는 64MiB였다(파트 크기의 4배, 회수 전 버퍼 포함).
- 회귀 검증은 `s3-blob-storage.integration-spec.ts`의 96MiB 상한을 사용한다.

빈 stream은 `Upload`를 거치지 않는다.
본문 없는 단일 `PutObject`로 0-byte 객체를 만든다.

presigned URL 구성:

- `@aws-sdk/s3-request-presigner`로 서명한다.
- 공개 endpoint용 별도 `S3Client`(`STORAGE_PUBLIC_CLIENT`)를 사용한다(api ADR-0013).

## Considered Options

- **백엔드별 어댑터 계층(`S3Adapter`/`VersityAdapter` 등)**
  - 벤더별 SDK를 사용할 계획이 없다.
  - 모든 대상 백엔드는 같은 S3 API를 사용한다.
  - 추가 간접 계층이 필요하지 않아 보류했다.
- **체크섬 기본값(`WHEN_SUPPORTED`) 유지**
  - 일부 백엔드는 `aws-chunked` 인코딩과 체크섬 헤더를 거부한다.
  - 업로드 실패를 피하기 위해 채택하지 않았다.
- **SDK 기본 재시도 유지**
  - 재생할 수 없는 업로드 stream에는 효과가 없다.
  - 저장 장애 응답 시간만 늘어나므로 채택하지 않았다.
