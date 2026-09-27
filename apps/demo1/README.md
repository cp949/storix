# demo1 — Storix 데모 시나리오 (보안 최소화 버전)

## 목적

Storix API를 실사용 시나리오로 검증하는 레퍼런스 예제. `web`(프론트엔드)과
`was`(백엔드 소비자)가 한 쌍을 이룬다 — 구조 결정 배경은
[`docs/adr/0023-demo-scenario-nested-layout.md`](../../docs/adr/0023-demo-scenario-nested-layout.md)
참고.

보안을 최소화한 버전이다. mTLS 등 풀보안을 고려한 풀버전은 `demo2`로 별도
예정(아직 미착수) — 착수 시 `apps/demo2/{web,was}`로 동일 구조를 따른다.

## 구성

- `web/` — `@storix/demo1-web`. React 19 + Vite 8 SPA. 문서 아카이브 UI
  (업로드, 디렉터리 생성·이동·복사·삭제, 인가된 다운로드, 공개 발행/취소).
- `was/` — `@storix/demo1-was`. NestJS. Storix 공개 HTTP API만 사용하는
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
pnpm --filter @storix/demo1-was dev

# web (Vite, 기본 포트 5173, /demo-api를 4000으로 프록시)
pnpm --filter @storix/demo1-web dev
```

`http://localhost:5173/` 접속. `apps/api`까지 로컬로 준비해야 해서 1번보다
준비물이 많다 — Storix API 서버를 이미 운영 중이 아니면 1번을 권장한다.

### 재개 업로드용 private namespace 준비

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
   pnpm --filter @storix/api start:dev
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
   pnpm --filter @storix/demo1-was dev
   ```
