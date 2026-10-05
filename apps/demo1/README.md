# demo1 — Storix 데모 시나리오 (보안 최소화 버전)

## 목적

Storix API를 실사용 시나리오로 검증하는 레퍼런스 예제. `web`(프론트엔드)과
`was`(백엔드 소비자)가 한 쌍을 이룬다 — 구조 결정 배경은
[`docs/adr/0023-demo-scenario-nested-layout.md`](../../docs/adr/0023-demo-scenario-nested-layout.md)
참고.

보안을 최소화한 버전이다. mTLS 등 풀보안을 고려한 풀버전은 `demo2`로 별도
예정(아직 미착수) — 착수 시 `apps/demo2/{web,was}`로 동일 구조를 따른다.

## 구성

- `web/` — `@cp949/storix-demo1-web`. React 19 + Vite 8 SPA. 문서 아카이브 UI
  (일반·재개 업로드, 디렉터리 생성·이동·복사·삭제, 인가된 다운로드, 공개 발행/취소).
- `was/` — `@cp949/storix-demo1-was`. NestJS. Storix 공개 HTTP API만 사용하는
  외부 소비자 WAS 예제(document-archive 도메인).

## 실행

### 1. 전체 스택 (권장)

`web` 정적 빌드 + `was` + VersityGW + Postgres를 nginx 뒤에 하나로 묶어
기동한다:

```bash
docker compose \
  --env-file docs/deployment/scenarios/demo-all-in-one/env/development.env.example \
  -f docker-compose.yml \
  -f docker-compose.versitygw.yml \
  -f docker-compose.postgres.yml \
  -f docs/deployment/scenarios/demo-all-in-one/compose.demo.yml \
  up --build --wait
```

기동 후 `http://localhost:8080/` 접속. 자동 검증:
`docs/deployment/scenarios/demo-all-in-one/smoke-test.sh`.

nginx location, 로그 형식, 환경변수 등 상세 구성은
[`docs/deployment/scenarios/demo-all-in-one/README.md`](../../docs/deployment/scenarios/demo-all-in-one/README.md)
참고.

### 2. 개별 dev 모드

Storix 백엔드(`apps/api`, DB·스토리지 포함)가 이미 떠 있다는 전제다.

```bash
# was (NestJS, 기본 포트 4000)
DEMO_WAS_STORIX_BASE_URL=http://localhost:3000 \
DEMO_WAS_STORIX_API_KEY=<storix-api-key> \
pnpm --filter @cp949/storix-demo1-was dev

# web (Vite, 기본 포트 5173, /demo-api를 4000으로 프록시)
pnpm --filter @cp949/storix-demo1-web dev
```

`http://localhost:5173/` 접속. `apps/api`까지 로컬로 준비해야 해서 1번보다
준비물이 많다 — Storix API 서버를 이미 운영 중이 아니면 1번을 권장한다.

### 기동 시 namespace 확보

WAS는 기동할 때마다 `demo`(PRIVATE)와 `demo-public`(PUBLIC) namespace를 확보한다.
`DEMO_WAS_NAMESPACE_ID`를 설정하면 private는 생성하지 않는다.

1. 고정 `Idempotency-Key`(`demo-was:namespace:private`·`demo-was:namespace:public`)로
   `POST /api/v2/namespaces`를 호출한다. Storix는 이 키의 결과를 30일간 재생한다.
2. 30일이 지나 receipt가 지워진 뒤 이름이 이미 있으면 `409 NAMESPACE_ALREADY_EXISTS`가
   온다. WAS는 `GET /api/v2/namespaces?limit=1000`을 끝까지 순회해 이름과
   `accessPolicy`가 같은 namespace의 id를 쓴다. 일치하는 항목이 없으면 부팅이 실패한다.

이름 조회 API가 없어 목록 전체를 순회한다. 데모는 namespace 수가 적은 Storix 인스턴스에
붙는다는 전제다.

### 재개 업로드용 private namespace 준비

all-in-one 스택(compose)에서는 아래 수동 절차 대신
[`enable-resumable-upload.sh`](../../docs/deployment/scenarios/demo-all-in-one/README.md#재개-업로드-활성화)를 쓴다.

재개 업로드는 Storix API에서 기본 비활성이다. API는 시작할 때 capability 설정의
namespace UUID가 이미 존재하는지 확인하므로 다음 순서로 준비한다. 아래 한도 값은
로컬 데모 예시이며, 실제 환경에서는 용량과 동시 세션 수를 따로 결정한다.

1. **기존 설정으로 Storix API를 먼저 기동하고 private namespace를 한 번 생성한다.**
   `STORIX_API_KEY`에는 API에 접근할 서비스 키를 넣는다. `Idempotency-Key`를
   고정하면 같은 요청을 재실행해도 최초 생성 결과를 다시 받는다.

   ```bash
   export STORIX_API_KEY=<storix-api-key>
   curl --fail-with-body --silent --show-error \
     -X POST http://localhost:3000/api/v2/namespaces \
     -H "Authorization: Bearer $STORIX_API_KEY" \
     -H 'Idempotency-Key: demo1-resumable-private-v1' \
     -H 'Content-Type: application/json' \
     -d '{"name":"demo-resumable","encryptionPolicy":"NONE","accessPolicy":"PRIVATE"}'
   ```

   응답의 `id` UUID를 복사해 `DEMO_WAS_NAMESPACE_ID`에 설정한다. 기존
   `demo` namespace를 재사용하려면 새로 생성하지 말고 그 UUID를 사용한다.

2. **그 UUID를 두 API 설정 파일에 넣는다.** 아래 명령의 UUID를 실제 응답으로
   교체한다. 두 파일은 API 프로세스에서 읽을 수 있는 위치에 둔다.

   ```bash
   export DEMO_WAS_NAMESPACE_ID=<private-namespace-uuid>
   cat > demo1-capabilities.json <<EOF
   {
     "globalAllowedCapabilities": ["resumable-upload"],
     "namespaceAllowedCapabilities": {
       "$DEMO_WAS_NAMESPACE_ID": ["resumable-upload"]
     }
   }
   EOF
   cat > demo1-upload-sessions.json <<EOF
   {
     "global": {
       "maxStagedBytes": "1073741824",
       "maxActiveSessions": 8,
       "partSizeBytes": 16777216,
       "inactivitySeconds": 86400,
       "maxLifetimeSeconds": 604800
     },
     "namespaces": {
       "$DEMO_WAS_NAMESPACE_ID": {
         "maxStagedBytes": "536870912",
         "maxActiveSessions": 4
       }
     }
   }
   EOF
   ```

3. **API를 중지하고 두 설정 경로를 주어 다시 기동한다.** 환경변수는 API 시작
   시점에만 읽는다. 아래 명령은 저장소 루트에서 실행하는 로컬 예시다.

   ```bash
   STORIX_VFS_CAPABILITIES_CONFIG_PATH="$PWD/demo1-capabilities.json" \
   STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH="$PWD/demo1-upload-sessions.json" \
   pnpm --filter @cp949/storix-api start:dev
   ```

   재시작 후 `GET /api/v2/namespaces/$DEMO_WAS_NAMESPACE_ID/capabilities`가
   `{"capabilities":["resumable-upload"]}`를 반환하는지 확인한다. 응답이 비어
   있으면 WAS를 시작하기 전에 API 설정과 UUID를 확인한다.

4. **WAS를 같은 UUID에 고정해 기동한다.** 고정 ID가 있으면 WAS는 private
   namespace를 새로 만들지 않는다. 공개 발행용 public namespace는 기존처럼
   확보한다. `DEMO_WAS_NAMESPACE_ID`를 설정하지 않으면 기존 private namespace
   생성 동작이 유지된다.

   ```bash
   DEMO_WAS_NAMESPACE_ID="$DEMO_WAS_NAMESPACE_ID" \
   DEMO_WAS_STORIX_BASE_URL=http://localhost:3000 \
   DEMO_WAS_STORIX_API_KEY="$STORIX_API_KEY" \
   pnpm --filter @cp949/storix-demo1-was dev
   ```

### 재개 업로드 사용

웹의 **재개 업로드 파일**에서 파일을 고르면 브라우저가 WAS에서 세션을 만들고,
서버가 반환한 `partSizeBytes`로 파일을 나눠 순서대로 보낸다. **중단**을 누르거나
브라우저를 다시 연 뒤에는 같은 사용자·경로에서 **같은 파일을 다시 선택**한다.
브라우저는 세션 ID를 복원하고 WAS에서 저장된 조각 index를 조회해 누락된 조각만
보낸다. **세션 취소**는 서버 세션을 종료하고 브라우저 참조를 지운다. 만료되거나
종료된 세션은 같은 파일을 다시 선택해 새 세션으로 시작한다. 기존 일반 업로드도
계속 사용할 수 있다.

브라우저는 Storix 서비스 키를 받지 않는다. 아래 경로는 모두 `X-Demo-User`를
요구하며, WAS가 사용자 폴더 안의 경로와 세션 소유 범위를 확인한 뒤 Storix 공개
API로 전달한다.

| 작업                  | WAS 경로                                                            | 주요 요청·응답                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 세션 생성             | `POST /demo-api/documents/upload-sessions`                          | `Idempotency-Key` UUID와 JSON `path`, `sizeBytes`(10진 문자열), `mimeType`, `ifAbsent: true` 또는 `ifRevision`, 선택적 `sha256`; `201`에 `sessionId`, `partSizeBytes`, `partCount` |
| 상태 조회             | `GET /demo-api/documents/upload-sessions/{sessionId}`               | `200`에 저장된 `parts`의 index·크기와 사용자 기준 `path`                                                                                                                           |
| 조각 저장·동일 재전송 | `PUT /demo-api/documents/upload-sessions/{sessionId}/parts/{index}` | `Content-Type: application/octet-stream`, 정확한 `Content-Length`, 원시 바이트; `200`에 `replayed`와 조각 SHA-256                                                                  |
| 완료                  | `POST /demo-api/documents/upload-sessions/{sessionId}/complete`     | 본문 없음; 새 파일 `201`, 기존 파일 교체 `200`                                                                                                                                     |
| 취소                  | `DELETE /demo-api/documents/upload-sessions/{sessionId}`            | 열린 세션 `200`                                                                                                                                                                    |
| MIME type 수정        | `PATCH /demo-api/documents/mime-type`                               | JSON `path`, `mimeType`; 사용자 경로만 허용하고 성공하면 목록 metadata를 갱신                                                                                                      |

생성 전에 대상 부모 디렉터리가 있어야 한다. 웹에서는 현재 폴더에 파일을 만들므로
폴더를 먼저 생성한다. 저장된 조각은 세션 상태 조회의 `parts`에서 확인한다.
완료된 파일은 문서 목록과 인가된 다운로드(`GET /demo-api/documents`,
`POST /demo-api/documents/download`)로 확인한다.

### 실제 Storix 소비자 검증

실행 전 `DEMO_WAS_STORIX_BASE_URL`, `DEMO_WAS_STORIX_API_KEY`를 설정하고 위
절차대로 활성화한 private namespace UUID를 `DEMO_WAS_NAMESPACE_ID`로 지정한다.
`GET /api/v2/namespaces/{id}/capabilities`가 `resumable-upload`를 반환해야 한다.
테스트는 전용 폴더를 만들고 2개 조각을 저장하므로 세션 정책의
`partSizeBytes`는 1~33554432, 전역 및 namespace의 staging 한도와 namespace
파일 한도는 모두 최소 `partSizeBytes + 1`바이트를 허용해야 한다. 공개 다운로드를 포함한 기존
vertical-slice 시나리오도 같은 suite에서 실행한다.

```bash
DEMO_WAS_STORIX_BASE_URL=http://localhost:3000 \
DEMO_WAS_STORIX_API_KEY="$STORIX_API_KEY" \
DEMO_WAS_NAMESPACE_ID="$DEMO_WAS_NAMESPACE_ID" \
pnpm --filter @cp949/storix-demo1-was test:integration --runTestsByPath src/vertical-slice.integration-spec.ts
```

설정이 없으면 suite가 누락된 환경변수를 명시하며 실패한다. capability가 비활성이면
재개 업로드 시나리오가 사전 조건 오류로 실패한다. 이 suite는 실제 Storix 인스턴스와
저장소를 사용하므로, 실행하지 않은 환경에서는 연동 성공으로 간주하지 않는다.

## 오류 응답

WAS 오류 응답 형태는 `{ code, message, requestId }`다.

- Storix가 반환한 오류는 `status`·`code`·`message`를 그대로 전달한다.
  - `message`에는 Storix의 설명이 들어가며 사용자 root 형태의 경로(`/documents/alice/...`)가 포함될 수 있다.
  - demo1은 보안 최소화 시나리오라서 이를 숨기지 않는다. 오류 정보를 숨기는 쪽은 `demo2` 범위다.
- Storix가 WAS의 API 키를 거부하면(upstream 401) 502 `STORIX_UPSTREAM_UNAUTHORIZED`로 응답한다.
  - 사용자 인증 실패(401)와 구분하기 위해서다.
  - 응답 `message`는 고정 문구다. upstream `code`와 `requestId`는 WAS 로그에만 남는다.
- 요청 본문의 경로 필드(`source`·`destination`·`path`)는 문자열이어야 한다.
  - 문자열이 아니거나 없거나 `null`이면 400 `DEMO_INVALID_REQUEST_BODY`다.
  - 빈 문자열은 사용자 root를 뜻하며 허용한다.
- JSON 파싱 실패(400)와 본문 과대(413)는 `HTTP_ERROR` code로 응답하고 `requestId`를 포함한다.
