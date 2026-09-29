# S3 호환 백엔드는 AWS SDK v3 클라이언트 하나로 지원하고 별도 어댑터 계층을 두지 않는다

`BlobStorage` 구현체 `S3BlobStorage`가 `@aws-sdk/client-s3`의 `S3Client` 하나로 S3 API
호환 백엔드(S3, VersityGW)를 지원한다. 백엔드별 차이는 클라이언트 옵션으로만
흡수한다.

- `endpoint`: `STORIX_STORAGE_ENDPOINT`/`STORIX_STORAGE_PORT`/`STORIX_STORAGE_USE_SSL`로 조립한 URL.
- `forcePathStyle`: `STORIX_STORAGE_PATH_STYLE`(기본 `true`).
- `region`: `STORIX_STORAGE_REGION`. 미설정이면 `us-east-1`을 쓴다. SDK는 리전을 자동
  조회하지 않으므로 presigned URL 발급이 네트워크 요청을 만들지 않는다. 대신 백엔드가
  리전을 지정해 운영되면(AWS S3 버킷 리전, VersityGW `--region`) 같은 값을 설정해야 한다.
- `maxAttempts: 1`: 업로드 stream은 재생할 수 없고, 저장 장애는 호출자가 분류해
  응답한다. SDK 자동 재시도를 끄고 실패를 즉시 전달한다.
- `requestChecksumCalculation`/`responseChecksumValidation`: `WHEN_REQUIRED`.
  SDK 기본값(`WHEN_SUPPORTED`)은 요청에 CRC32 체크섬과 `aws-chunked` 인코딩을
  붙이는데, 일부 S3 호환 백엔드가 이를 거부한다.

크기를 모르는 stream 업로드는 `@aws-sdk/lib-storage`의 `Upload`로 처리한다.
`partSize`는 16MiB, `queueSize`는 1이다. 업로드 중 버퍼링하는 메모리는 전송 중인 파트와
누적 중인 잔여분을 합쳐 파트 크기의 약 2배(약 32MiB)이며 파일 크기와 무관하다. 빈 stream은 `Upload`를 거치지 않고 본문 없는 단일 `PutObject`로
0-byte 객체를 만든다. presigned URL은 `@aws-sdk/s3-request-presigner`로 서명하며
공개 endpoint용 별도 `S3Client`(`STORAGE_PUBLIC_CLIENT`)를 쓴다(ADR-0013).

S3 SDK 자체가 범용 S3 API 클라이언트이므로 `BlobStorage` 인터페이스 뒤에 벤더별
어댑터 계층을 추가로 두지 않는다.

## Considered Options

- **백엔드별 어댑터 계층 신설**(`S3Adapter`/`VersityAdapter` 등 분리): 벤더별 SDK를
  따로 쓸 계획이 없고 모두 동일 S3 API를 말하므로 불필요한 간접 계층만 늘어나 보류했다.
- **체크섬 기본값(`WHEN_SUPPORTED`) 유지**: 일부 백엔드가 `aws-chunked` 인코딩과 체크섬
  헤더를 거부해 업로드가 실패할 수 있어 채택하지 않았다.
- **SDK 기본 재시도 유지**: 재생할 수 없는 업로드 stream에는 효과가 없고, 저장 장애
  응답 시간만 늘어난다. 채택하지 않았다.
