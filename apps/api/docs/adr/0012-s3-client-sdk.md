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
- **`requestHandler.socketTimeout`/`requestHandler.connectionTimeout`**
  - `STORIX_STORAGE_SOCKET_TIMEOUT_MS`(기본 120초)·`STORIX_STORAGE_CONNECT_TIMEOUT_MS`(기본 10초)를 사용한다.
  - SDK 기본값은 둘 다 0(비활성)이라 S3가 응답을 멈추면 소켓과 요청 처리가 무기한 남는다.
  - `socketTimeout`은 소켓 무활동 시간이다. 정상 전송은 끊지 않고 헤더 전·본문 도중 정지를 모두 끊는다.
  - 요청 전체 시간인 `requestTimeout`은 쓰지 않는다. 대용량 전송을 끊을 수 있고, 본문 도중 정지는 `throwOnRequestTimeout`을 켜도 끊지 못했다(모사에서 60초 넘게 종료되지 않음).
  - 양의 정수만 받고 상한은 2147483647이다. `0`(무제한)은 거부한다. 상한을 넘는 값은 Node 타이머가 1ms로 줄여 즉시 끊는다.
  - 소비자(클라이언트)가 다운로드 읽기를 완전히 멈춰도 소켓이 무활동이라 같은 값으로 끊긴다. 응답 헤더는 이미 나간 뒤라 연결이 중단된다. 느리지만 계속 읽는 클라이언트는 영향이 없다고 본다(`pipe`가 읽은 만큼 소켓을 소비하는 구조 기준이며 느린 수신 속도로는 직접 확인하지 않았다).
  - 헤더 전 timeout은 `code` 없이 `name`만 `TimeoutError`다. `classifyBlobFailure`가 이름으로 분류해 503 `STORAGE_UNAVAILABLE`로 응답한다. 본문 도중 정지는 `ECONNRESET`(`aborted`)으로 끝나 기존 분류가 503으로 처리한다.
  - 내부·public(presign) client와 gc·backup·restore가 같은 값을 쓴다. public client는 서명만 하므로 값이 무관하다.
- **`requestHandler.httpAgent`/`httpsAgent`의 `maxSockets`**
  - `STORIX_STORAGE_MAX_SOCKETS`(기본 50)를 사용한다. 기본값은 SDK 기본값과 같다.
  - 진행 중인 요청마다 소켓 하나를 쓰고, 장기 다운로드는 클라이언트가 다 받을 때까지 점유한다. 상한은 가용 소켓이 아니라 동시 전송 수의 상한이다.
  - 상한에 닿으면 SDK는 요청을 Agent 대기열에 둔다. 소켓 대기 전용 timeout은 없다. 대기 중에도 `connectionTimeout` 타이머가 돌아 `TimeoutError`로 끝난다(`@smithy/node-http-handler` 4.12.1, fake 서버로 확인: 소켓 50개 점유 중 51번째 요청이 `connectionTimeout` 시간에 맞춰 실패).
  - 그래서 소켓 고갈은 무기한 대기가 아니라 `STORIX_STORAGE_CONNECT_TIMEOUT_MS`(기본 10초) 뒤 503 `STORAGE_UNAVAILABLE`이다. 새 대기 timeout 설정은 만들지 않는다.
  - `/health/ready`(`HeadBucket`)도 같은 client를 쓴다. 소켓이 차면 함께 503이 된다. 이 연동을 막으려고 health 전용 client를 두지 않는다. 용량이 부족하다는 신호로 읽는다.
  - 값은 1~65535의 양의 정수만 받는다. 한 목적지에 대한 연결 수는 TCP 포트 수를 넘을 수 없다. `0`은 거부한다.
  - `httpAgent`에 객체를 주면 SDK가 `keepAlive: true`를 유지한 채 `maxSockets`만 덮어쓴 Agent를 만든다.
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
