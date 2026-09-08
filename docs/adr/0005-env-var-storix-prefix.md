# Storix가 정의하는 환경변수는 전부 STORIX_ 접두어를 쓴다

## 상태

승인됨 (2026-09-08) — 구현 완료.

## 배경

ADR-0004 시점의 환경변수 이름은 다섯 가지 방식이 섞여 있었다: `DB_*`(5개),
`STORAGE_*`(11개, ADR api-0016에서 `MINIO_*`에서 개명), 무접두 한도값
(`MAX_FILE_SIZE_BYTES`, `MAX_SYNC_DELETE_NODES`, `MAX_SYNC_COPY_NODES`,
`PRESIGNED_URL_EXPIRY_SECONDS`, `ORPHAN_GRACE_PERIOD`), 무접두 비밀값·기타
(`API_KEY`, `API_KEY_PREVIOUS`, `ENCRYPTION_MASTER_KEY`, `SENTRY_DSN`, `PORT`), 잡
전용(`BACKUP_DIR`, `RESTORE_SOURCE_DIR`, `RESTORE_FORCE`). 여기에 앱은 읽지 않고
compose 보간에만 쓰이는 `VERSITYGW_DATA_PATH`, `NGINX_PUBLIC_PORT`가 같은 `.env`에
있었다.

컨테이너 안은 격리돼 있어 저장소 단독 실행에서는 충돌이 없다. 충돌은 다음 두
지점에서 일어난다.

- **호스트 셸에서 직접 실행(`pnpm dev`)**: `@nestjs/config` 12는 `override`
  기본값이 false라 셸에 이미 있는 변수가 `.env`보다 우선한다. `requireEnv`도
  `process.env`를 직접 읽는다. 셸에 다른 프로젝트의 `DB_PASSWORD`, `API_KEY`,
  `PORT`가 남아 있으면 `.env` 값이 조용히 무시된다. 이 우선순위는
  `docs/deployment/multi-instance-versitygw.md`가 의도된 동작으로 문서화하고
  있어, 이름으로 확률을 낮추는 것 외에 막을 방법이 없다.
- **운영자가 Storix 서비스를 자기 compose 프로젝트에 병합할 때**: `.env`는
  프로젝트 전체가 공유하는 보간 네임스페이스다. 그쪽 앱이 `DB_HOST`, `PORT`,
  `API_KEY`를 쓸 확률은 높다. postgres 이미지가 `POSTGRES_*`만 읽는 것과 같은
  이유로, 남의 프로젝트에 컴포넌트로 들어가는 Storix API 이미지도 자기
  접두어가 필요하다.

또한 `PORT`는 Storix 자체 compose 안에서도 의미가 둘이었다. `.env`의 `PORT`는
호스트 publish 포트(`${PORT:-3000}:3000`)이고 컨테이너 안의 `PORT: '3000'`은
listen 포트였다.

## 결정

1. **Storix가 정의한 변수는 전부 `STORIX_` 접두어를 쓴다.** 앱이 읽는 29개와
   compose 전용 2개(`STORIX_VERSITYGW_DATA_PATH`, `STORIX_NGINX_PUBLIC_PORT`)
   모두 대상이다. 규칙은 "STORIX_로 시작하면 Storix 것" 하나로 끝난다.
2. **외부 규약만 예외다.** `NODE_ENV`(Node), `COMPOSE_FILE`(compose)은 그대로
   둔다. `SENTRY_DSN`은 Sentry SDK 자동 인식 규약이지만 현재 코드가
   `config.get`으로 명시 전달하므로 `STORIX_SENTRY_DSN`으로 바꿔도 동작 차이가
   없어 예외로 두지 않는다.
3. **`PORT`는 의미별로 나눈다.** `STORIX_PUBLISH_PORT`는 compose가 app
   컨테이너를 호스트에 노출하는 포트, `STORIX_PORT`는 앱의 listen 포트다.
   컨테이너 안의 listen 포트는 `STORIX_PORT: '3000'`으로 고정하고,
   `STORIX_PORT`를 `.env`에서 바꾸는 경우는 호스트 직접 실행(`pnpm dev`)뿐이다.
4. **DI 토큰은 대상이 아니다.** `STORAGE_CLIENT`, `STORAGE_PUBLIC_CLIENT`,
   `STORAGE_BUCKET` 심볼은 내부 식별자이며 env 이름과 무관하다.
5. **하위호환 alias나 마이그레이션 가이드는 두지 않는다.** ADR api-0016과 같은
   논리다 — 릴리스 태그도 실 배포도 없어 breaking change 비용이 지금 가장
   낮다. DEPLOY-01(README 환경변수 문서화)과 API-03(1.0 직전 breaking-change
   정책 고정) 이후에는 alias 코드가 필요해지므로 그 전에 바꾼다.
6. **ADR 본문은 고치지 않는다.** 이 저장소의 ADR은 불변 로그다. ADR-0002~0004와
   api-0006~0016에 남은 옛 이름은 당시 이름이며, 이 ADR이 대응 관계를 기록한다.

## Considered Options

- **충돌 위험이 큰 것만 접두(`PORT`, `DB_*`, `API_KEY`)**: "무엇이 위험한가"
  판단이 다시 제각각을 만든다. 보류.
- **`STORIX_DB_HOST ?? DB_HOST` fallback 유지**: 실 배포가 없어 하위호환 코드를
  넣을 이유가 없다. 실 배포 이후에 또 바꿔야 한다면 그때 정당화된다. 보류.
- **`SENTRY_DSN` 예외 유지**: 공유 `.env` 시나리오에서 다른 앱은 다른 Sentry
  프로젝트를 쓸 가능성이 높고, SDK 자동 인식에 의존하는 코드가 없다. 보류.
- **`PORT`를 `STORIX_PORT`로만 개명**: 호스트 publish 포트와 listen 포트의 이중
  의미가 그대로 남는다. 보류.

## Consequences

- **breaking**: `.env`, compose, CI 워크플로, 배포 문서의 env 이름이 전부
  바뀐다. 기존 `.env`가 있다면 이름을 손으로 바꿔야 한다(alias 없음).
- 치환 범위: 코드의 `ConfigService.get*` 45곳·`requireEnv` 4곳·`main.ts` 1곳,
  통합테스트의 `process.env` 대입, compose 7개 파일, `.env.example`, README 4개,
  `docs/deployment/*`, `.github/workflows/versity-demo-smoke.yml`.
- `docs/superpowers/plans|specs`(gitignore된 로컬 이력)와 ADR 본문은 바꾸지
  않는다.
- 앞으로 새 env var를 추가할 때 접두어 없는 이름을 쓰지 않는다. 외부 규약을
  그대로 읽어야 하는 경우(예: PaaS가 주입하는 `PORT`)가 생기면 그 변수는
  Storix가 정의한 것이 아니므로 예외 목록에 추가하고 이 ADR을 잇는 새 ADR로
  기록한다.
