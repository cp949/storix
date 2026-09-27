# WAS에서 파일 다운로드 제공하기

사용자에게 파일을 보여주거나 내려받게 할 때 **WAS가 먼저 사용자 권한을 판단**하세요. 파일 바이트까지 항상 WAS가 전달할 필요는 없습니다. 큰 파일은 권한 확인 후 짧게 유효한 다운로드 URL을 전달하면 WAS의 전송 부담을 줄일 수 있습니다. URL을 받은 뒤의 실제 다운로드는 WAS를 거치지 않으므로, 링크가 유효한 동안에는 요청마다 WAS가 권한을 다시 확인하지 않는다는 점을 정책에 반영하세요.

| 파일과 선택 기준                                                           | 권장 경로                                                                                                             | 현재 상태               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 작은 파일 또는 다운로드마다 WAS 권한 확인이 필요한 파일                    | 브라우저 → WAS → Storix → WAS → 브라우저                                                                              | 사용 가능               |
| 큰 `NONE` namespace 파일, 짧은 유효 기간의 직접 링크를 허용할 수 있는 경우 | WAS가 권한 확인 → Storix에서 storage presigned URL 발급 → 브라우저가 스토리지에서 직접 다운로드                       | 사용 가능               |
| `ENCRYPTED` namespace 파일                                                 | 현재는 WAS 경유 다운로드. 향후 WAS 권한 확인 → Storix의 단기 다운로드 링크 → Storix가 복호화 스트림을 브라우저에 전달 | 직접 링크는 미구현 제안 |

파일 크기에 따른 고정 임계값은 Storix가 정하지 않습니다. WAS의 응답 시간·대역폭과 사용처의 접근 정책에 맞게 경로를 선택하세요.

## 외부 요청과 내부 API 분리

이 가이드의 보호 대상 파일에서는 **외부 사용자가 Storix의 서비스 API에 직접 접근하지 못하게** 배치하세요. WAS는 내부 주소 또는 WAS 전용 listener를 통해 `Authorization: Bearer <STORIX_API_KEY>`와 함께 Storix의 `/api/v2/namespaces/...` API를 호출합니다. 사용자에게 API key를 전달하거나 공개 nginx가 이 키를 주입해서는 안 됩니다.

```text
외부 사용자 → 공개 nginx → WAS 업무 API
외부 사용자 → 공개 nginx → 스토리지의 presigned GET 경로
WAS         → 내부 경로 → Storix 보호 API
```

공개 nginx에는 사용처의 WAS 경로와 **서명된 객체 다운로드에 필요한 스토리지 경로·GET 메서드만** 연결하세요. Storix 보호 API 경로와 스토리지의 쓰기·관리 API는 외부 라우팅 대상에서 제외합니다. 스토리지 bucket은 비공개로 유지해야 하며, nginx의 GET 허용만으로 서명이 검증되는 것은 아닙니다. 실제 presigned 서명은 스토리지 백엔드가 검증합니다. nginx는 서명에 포함되는 Host, 경로, 쿼리스트링을 바꾸지 않고 전달하고, 서명 쿼리를 로그에 남기지 않아야 합니다.

현재 [nginx 서명 검증 샘플](../deployment/nginx-reverse-proxy.md)은 GET 요청을 스토리지로 전달하는 예시입니다. 실제 외부 경로를 제한하는 배치는 [내부 mTLS listener 시나리오](../deployment/scenarios/co-located-nginx-mtls/README.md)처럼 보호 API와 공개 다운로드 경로를 분리하고, 사용처의 bucket 경로로 공개 location을 좁히세요. `PUBLIC` namespace의 무인증 읽기를 별도로 제공한다면 그 공개 경로는 이 WAS 권한 확인 패턴과 다른 정책으로 명시적으로 열어야 합니다.

## 1. WAS가 파일 바이트를 전달하는 방법 — 현재 사용 가능

1. 브라우저가 WAS에 업무 파일의 다운로드를 요청합니다.
2. WAS가 사용자·업무 레코드의 권한을 확인하고, 자신의 DB에 저장한 Storix `namespaceId`와 `path`를 찾습니다. 경로가 재사용될 수 있다면 현재 파일 ID도 대조합니다.
3. WAS가 서비스 자격으로 Storix의 `GET /api/v2/namespaces/{namespaceId}/fs/download?path=...`를 호출하고 응답을 브라우저에 스트리밍합니다. 부분 다운로드가 필요하면 브라우저의 `Range` 요청과 Storix의 `206`·`Content-Range` 응답을 전달하세요.

이 경로는 `NONE`과 `ENCRYPTED` namespace 모두에 적용할 수 있습니다. `ENCRYPTED` 파일은 Storix가 저장된 암호문을 **스트리밍 복호화**하며 Range 요청도 지원합니다. 복호화된 파일 전체를 임시 폴더에 만들 필요가 없습니다. 다만 파일 바이트가 WAS를 통과하므로 큰 파일이나 동시 다운로드가 많으면 WAS의 연결·대역폭을 사용합니다.

## 2. 스토리지 presigned URL로 직접 다운로드 — 현재 사용 가능

```text
브라우저 → WAS: 파일 다운로드 요청
WAS: 사용자·업무 권한 확인
WAS → Storix: GET /fs/presigned-download?path=...
Storix → WAS: url, expiresAt
WAS → 브라우저: url, expiresAt
브라우저 → 스토리지: 서명된 URL로 파일 다운로드
```

WAS는 클라이언트가 보낸 경로나 파일 ID를 그대로 Storix에 넘기지 말고, 권한을 확인한 업무 레코드에서 대상 namespace와 경로를 결정하세요. Storix 서비스 API key는 WAS에만 두고 브라우저에는 URL만 전달하세요. 브라우저가 URL로 다운로드할 때 파일 바이트는 WAS와 Storix API를 통과하지 않습니다.

이 기능은 `encryptionPolicy=NONE`인 파일에 적용합니다. 현재 `ENCRYPTED` namespace의 `presigned-download` 요청은 409 `VFS_PRESIGNED_ENCRYPTED_UNSUPPORTED`입니다. 스토리지 객체가 암호문이어서 Storix를 거치지 않는 URL로는 원래 파일을 전달할 수 없기 때문입니다.

사용하려면 브라우저가 접근할 수 있는 `STORIX_STORAGE_PUBLIC_ENDPOINT`와 해당 포트·TLS 설정이 필요합니다. 발급 시 설정한 주소와 실제 브라우저 요청의 호스트·포트·프로토콜이 맞아야 서명이 유효합니다. 자세한 배포 조건은 [nginx 참조 구성](../deployment/nginx-reverse-proxy.md)을 따르세요.

presigned URL은 만료 전까지 **그 URL을 아는 사람이 사용할 수 있는 다운로드 권한**입니다. 현재 기본 만료 시간은 300초이며 배포 설정 `STORIX_PRESIGNED_URL_EXPIRY_SECONDS`로 정합니다. WAS 권한 변경이나 로그아웃만으로 이미 발급된 URL이 즉시 무효화되지는 않습니다. URL의 서명 쿼리를 로그에 남기거나 다른 페이지로 전달하지 마세요. Storix에는 URL **발급** 요청이 기록되지만, 스토리지에서 실제로 파일을 받은 사실은 Storix 감사 로그에 남지 않습니다.

## 3. 암호화 파일의 Storix 직접 다운로드 — 향후 제안, 미구현

`ENCRYPTED` 파일도 WAS의 파일 전송 부담을 줄이려면 **스토리지 presigned URL과 다른 형태의 링크**가 필요합니다. 제안 흐름은 다음과 같습니다.

```text
브라우저 → WAS: 파일 다운로드 요청
WAS: 사용자·업무 권한 확인
WAS → Storix: 대상 파일에 대한 짧은 수명의 다운로드 링크 요청
WAS → 브라우저: Storix 다운로드 링크
브라우저 → Storix: 링크로 다운로드
Storix: 저장소의 암호문을 읽어 스트리밍 복호화 → 브라우저
```

링크는 대상 namespace·파일 ID와 만료 기한에만 다운로드 권한을 주고, Storix API key나 암호화 마스터 키를 담지 않아야 합니다. 경로가 바뀌거나 재사용될 때 다른 파일을 내려주지 않도록 발급 시점의 파일 식별자를 검증해야 합니다. WAS가 발급 전 권한을 확인하고 Storix가 다운로드 요청에서 링크를 검증합니다. 링크가 만료되기 전까지는 WAS의 권한 변경이 실제 다운로드에 즉시 반영되지 않는다는 한계가 있습니다. 요청마다 즉시 권한을 다시 확인해야 한다면 WAS 경유 경로를 사용하세요.

암호화 키는 계속 Storix 배포가 보관합니다. Storix의 현재 AES-CTR 구현은 이미 스트리밍 복호화와 Range 읽기를 지원하므로, 이 방안에 **임시 평문 파일이나 스토리지의 평문 사본은 필요하지 않습니다.** 평문 사본을 저장하면 보관·삭제와 노출 문제를 새로 관리해야 합니다. 이 링크의 발급·검증 API는 아직 없으며, 이 절은 사용처에 현재 제공되는 기능을 뜻하지 않습니다.

이 방안을 구현할 때는 공개 nginx에 **링크를 검증하는 Storix 다운로드 GET 경로만** 추가하고, 기존 서비스 API 전체는 계속 내부에 두어야 합니다. 이 외부 경로는 현재 존재하지 않습니다.

현재 API 형식은 [OpenAPI](../../apps/api/openapi.yaml), 암호화 파일의 presigned 제한과 감사 경계는 [ADR-0013](../../apps/api/docs/adr/0013-presigned-download-scope-limits.md)을 참고하세요. 파일 업로드와 업무 DB 연결은 [업로드 사용 패턴](./was-file-upload-patterns.md)에 정리돼 있습니다.

WAS가 Storix 보호 API에 접근할 때의 API key·TLS·mTLS 선택은 [서비스 간 신뢰 가이드](./was-storix-service-trust.md)를 참고하세요.
