# WAS에서 파일 다운로드 제공하기

**WAS가 먼저 사용자 권한을 판단한다.**
큰 파일은 권한 확인 후 짧게 유효한 다운로드 URL을 전달할 수 있다.
직접 다운로드는 WAS의 파일 전송 부담을 줄인다.

| 파일과 선택 기준                                            | 권장 경로                                                                     | 현재 상태   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| 작은 파일 또는 요청마다 WAS 권한 확인이 필요한 파일         | 브라우저 → WAS → Storix → WAS → 브라우저                                      | 사용 가능   |
| 큰 `NONE` namespace 파일이며 단기 직접 링크를 허용하는 경우 | WAS 권한 확인 → storage presigned URL 발급 → 브라우저가 스토리지에서 다운로드 | 사용 가능   |
| `ENCRYPTED` namespace 파일                                  | WAS 경유 다운로드                                                             | 사용 가능   |
| `ENCRYPTED` 파일의 단기 직접 링크                           | WAS 권한 확인 → Storix 링크 발급 → Storix가 복호화 스트림 전달                | 미구현 제안 |

선택 기준:

- Storix는 파일 크기의 고정 임계값을 정하지 않는다.
- WAS의 응답 시간·대역폭·접근 정책에 맞게 경로를 선택한다.
- 직접 링크가 유효한 동안에는 WAS가 다운로드 요청마다 권한을 다시 확인하지 않는다.
- 즉시 권한 재확인이 필요하면 WAS 경유 경로를 사용한다.

## 외부 요청과 내부 API 분리

보호 대상 파일의 배치 규칙:

- 외부 사용자가 Storix 서비스 API에 직접 접근하지 못하게 한다.
- WAS는 내부 주소 또는 WAS 전용 listener로 보호 API를 호출한다.
- `/api/v2/namespaces/...` 요청에 `Authorization: Bearer <STORIX_API_KEY>`를 보낸다.
- API key를 사용자에게 전달하지 않는다.
- 공개 nginx에서 API key를 주입하지 않는다.

```text
외부 사용자 → 공개 nginx → WAS 업무 API
외부 사용자 → 공개 nginx → 스토리지의 presigned GET 경로
WAS         → 내부 경로 → Storix 보호 API
```

공개 nginx 라우팅:

| 대상                                                   | 외부 연결 여부 |
| ------------------------------------------------------ | -------------- |
| 사용처의 WAS 업무 경로                                 | 허용           |
| 서명된 객체 다운로드에 필요한 스토리지 경로·GET 메서드 | 허용           |
| Storix 보호 API                                        | 제외           |
| 스토리지 쓰기·관리 API                                 | 제외           |

presigned 요청 전달:

- 스토리지 bucket은 비공개로 유지한다.
- nginx의 GET 허용만으로 서명을 검증하지 않는다.
- 스토리지 백엔드가 presigned 서명을 검증한다.
- nginx는 서명에 포함된 Host·경로·쿼리스트링을 바꾸지 않는다.
- 서명 쿼리를 로그에 남기지 않는다.

배포 참조:

- [nginx 서명 검증 샘플](../deployment/nginx-reverse-proxy.md)은 GET을 스토리지로 전달하는 예시다.
- [내부 mTLS listener 시나리오](../deployment/scenarios/co-located-nginx-mtls/README.md)처럼 보호 API와 공개 다운로드 경로를 분리한다.
- 공개 location은 사용처의 bucket 경로로 좁힌다.
- `PUBLIC` namespace의 무인증 읽기는 별도 공개 정책으로 명시적으로 연다.

## 1. WAS가 파일 바이트를 전달하는 방법 — 현재 사용 가능

1. 브라우저가 WAS에 업무 파일 다운로드를 요청한다.
2. WAS가 사용자·업무 레코드 권한을 확인한다.
3. WAS DB에서 Storix `namespaceId`·`path`를 찾는다.
   - 경로가 재사용될 수 있으면 현재 파일 ID도 대조한다.
4. 서비스 자격으로 `GET /api/v2/namespaces/{namespaceId}/fs/download?path=...`를 호출한다.
5. 응답을 브라우저에 스트리밍한다.
   - 부분 다운로드에는 브라우저의 `Range` 요청을 전달한다.
   - Storix의 `206`·`Content-Range` 응답도 전달한다.

적용 범위·전송 비용:

- `NONE`·`ENCRYPTED` namespace 모두 사용할 수 있다.
- Storix는 `ENCRYPTED` 파일을 **스트리밍 복호화**한다.
- 암호화 파일의 Range 요청도 지원한다.
- 복호화된 파일 전체를 임시 폴더에 만들 필요가 없다.
- 파일 바이트는 WAS를 통과한다.
- 큰 파일·동시 다운로드는 WAS의 연결과 대역폭을 사용한다.

## 2. 스토리지 presigned URL로 직접 다운로드 — 현재 사용 가능

```text
브라우저 → WAS: 파일 다운로드 요청
WAS: 사용자·업무 권한 확인
WAS → Storix: GET /fs/presigned-download?path=...
Storix → WAS: url, expiresAt
WAS → 브라우저: url, expiresAt
브라우저 → 스토리지: 서명된 URL로 파일 다운로드
```

WAS 처리 규칙:

- 권한을 확인한 업무 레코드에서 namespace·경로를 결정한다.
- 클라이언트가 보낸 경로·파일 ID를 그대로 Storix에 넘기지 않는다.
- Storix 서비스 API key는 WAS에만 보관한다.
- 브라우저에는 다운로드 URL만 전달한다.
- 실제 파일 바이트는 WAS·Storix API를 통과하지 않는다.

지원 범위:

| namespace               | `presigned-download`                      |
| ----------------------- | ----------------------------------------- |
| `encryptionPolicy=NONE` | 사용 가능                                 |
| `ENCRYPTED`             | 409 `VFS_PRESIGNED_ENCRYPTED_UNSUPPORTED` |

`ENCRYPTED`의 스토리지 객체는 암호문이다.
Storix를 거치지 않는 URL로는 원래 파일을 전달할 수 없다.

공개 주소 설정:

- 브라우저가 접근할 수 있는 `STORIX_STORAGE_PUBLIC_ENDPOINT`를 설정한다.
- 해당 포트·TLS도 설정한다.
- 발급 주소와 브라우저 요청의 호스트·포트·프로토콜이 일치해야 서명이 유효하다.
- 상세 배포 조건은 [nginx 참조 구성](../deployment/nginx-reverse-proxy.md)을 따른다.

URL 권한·감사 경계:

- presigned URL은 만료 전까지 **URL을 아는 사람에게 다운로드 권한을 준다.**
- 기본 만료 시간은 300초다.
- `STORIX_PRESIGNED_URL_EXPIRY_SECONDS`로 만료 시간을 설정한다.
- WAS 권한 변경·로그아웃만으로 발급된 URL이 즉시 무효화되지 않는다.
- 서명 쿼리를 로그에 남기거나 다른 페이지로 전달하지 않는다.
- URL **발급** 요청은 Storix에 기록한다.
- 스토리지에서 실제로 다운로드한 사실은 Storix 감사 로그에 남지 않는다.

## 3. 암호화 파일의 Storix 직접 다운로드 — 향후 제안, 미구현

암호화 파일의 직접 다운로드 링크는 **현재 미구현**이다.
스토리지 presigned URL과 다른 형태의 링크가 필요하다.

제안 흐름:

```text
브라우저 → WAS: 파일 다운로드 요청
WAS: 사용자·업무 권한 확인
WAS → Storix: 대상 파일에 대한 짧은 수명의 다운로드 링크 요청
WAS → 브라우저: Storix 다운로드 링크
브라우저 → Storix: 링크로 다운로드
Storix: 저장소의 암호문을 읽어 스트리밍 복호화 → 브라우저
```

제안 링크의 조건:

- 대상 namespace·파일 ID·만료 기한으로 다운로드 권한을 제한한다.
- Storix API key·암호화 마스터 키를 담지 않는다.
- 발급 시점의 파일 식별자를 검증한다.
- 경로 변경·재사용 후 다른 파일을 전달하지 않아야 한다.
- WAS가 발급 전에 사용자 권한을 확인한다.
- Storix가 다운로드 요청에서 링크를 검증한다.
- 만료 전에는 WAS 권한 변경이 실제 다운로드에 즉시 반영되지 않는다.
- 요청마다 권한을 재확인해야 하면 WAS 경유 경로를 사용한다.

암호화·배포 조건:

- 암호화 키는 Storix 배포가 계속 보관한다.
- 현재 AES-CTR 구현은 스트리밍 복호화·Range 읽기를 지원한다.
- 이 방안에는 임시 평문 파일·스토리지의 평문 사본이 필요하지 않다.
- 평문 사본을 저장하면 보관·삭제·노출을 추가로 관리해야 한다.
- 공개 nginx에는 링크를 검증하는 Storix 다운로드 GET 경로만 추가한다.
- 기존 서비스 API는 내부에 둔다.

이 링크의 발급·검증 API와 외부 다운로드 경로는 현재 존재하지 않는다.

참조:

- 현재 API 형식: [OpenAPI](../../apps/api/openapi.yaml).
- 암호화 파일의 presigned 제한·감사 경계: [api ADR-0013](../../apps/api/docs/adr/0013-presigned-download-scope-limits.md).
- 업로드·업무 DB 연결: [업로드 사용 패턴](./was-file-upload-patterns.md).
- 보호 API의 API key·TLS·mTLS 선택: [서비스 간 신뢰 가이드](./was-storix-service-trust.md).
