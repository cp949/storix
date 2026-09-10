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
