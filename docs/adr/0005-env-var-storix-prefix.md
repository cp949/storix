# Storix가 정의하는 환경변수는 전부 STORIX_ 접두어를 쓴다

## 상태

승인됨 (2026-09-08)

구현 완료.

## 배경

ADR-0004 시점의 환경변수는 다음 명명 방식이 섞여 있었다.

- DB: `DB_*`(5개).
- 스토리지: `STORAGE_*`(11개).
- 접두어 없는 한도값: `MAX_FILE_SIZE_BYTES`, `MAX_SYNC_DELETE_NODES`, `MAX_SYNC_COPY_NODES`, `PRESIGNED_URL_EXPIRY_SECONDS`, `ORPHAN_GRACE_PERIOD`.
- 접두어 없는 비밀값·기타: `API_KEY`, `API_KEY_PREVIOUS`, `ENCRYPTION_MASTER_KEY`, `SENTRY_DSN`, `PORT`.
- 잡 전용: `BACKUP_DIR`, `RESTORE_SOURCE_DIR`, `RESTORE_FORCE`.

같은 `.env`에는 compose 보간 전용 변수 `VERSITYGW_DATA_PATH`, `NGINX_PUBLIC_PORT`도 있었다. 앱은 이 변수를 읽지 않는다.

컨테이너 격리로 저장소 단독 실행에서는 충돌이 없다. 충돌 위험은 다음 두 환경에 있다.

- **호스트 셸에서 직접 실행(`pnpm dev`)**
  - 당시 `@nestjs/config` 12의 `override` 기본값은 false다.
  - 셸의 기존 변수가 `.env`보다 우선한다.
  - `requireEnv`도 `process.env`를 직접 읽는다.
  - 다른 프로젝트의 `DB_PASSWORD`, `API_KEY`, `PORT`가 셸에 남으면 `.env` 값이 무시된다.
  - 이 우선순위는 `docs/deployment/multi-instance-versitygw.md`에 의도된 동작으로 명시돼 있다.
  - 변수 이름을 분리해 충돌 가능성을 낮춘다.
- **운영자의 compose 프로젝트에 Storix 서비스를 병합**
  - `.env`는 프로젝트 전체의 보간 네임스페이스다.
  - 다른 앱도 `DB_HOST`, `PORT`, `API_KEY`를 쓸 수 있다.
  - Storix API 이미지에는 자체 접두어가 필요하다.
  - postgres 이미지의 `POSTGRES_*`와 같은 방식이다.

`PORT`는 Storix compose 안에서도 두 의미로 쓰였다.

- `.env`의 `PORT`: 호스트 publish 포트(`${PORT:-3000}:3000`).
- 컨테이너의 `PORT: '3000'`: listen 포트.

## 결정

1. **Storix가 정의한 변수는 모두 `STORIX_` 접두어를 쓴다.**
   - 결정 시점에 앱이 읽는 변수 29개가 대상이다.
   - compose 전용 `STORIX_VERSITYGW_DATA_PATH`, `STORIX_NGINX_PUBLIC_PORT`도 대상이다.
2. **외부 규약만 예외로 둔다.**
   - `NODE_ENV`(Node)와 `COMPOSE_FILE`(compose)은 유지한다.
   - `SENTRY_DSN`은 Sentry SDK 자동 인식 규약이다.
   - 당시 코드는 `config.get`으로 값을 명시 전달한다.
   - `STORIX_SENTRY_DSN`으로 바꿔도 동작이 같으므로 예외로 두지 않는다.
3. **`PORT`는 의미별로 분리한다.**
   - `STORIX_PUBLISH_PORT`: compose가 app 컨테이너를 호스트에 노출하는 포트.
   - `STORIX_PORT`: 앱의 listen 포트.
   - 컨테이너에서는 `STORIX_PORT: '3000'`으로 고정한다.
   - `.env`의 `STORIX_PORT` 변경은 호스트 직접 실행(`pnpm dev`)에만 적용한다.
4. **DI 토큰은 변경 대상이 아니다.**
   - `STORAGE_CLIENT`, `STORAGE_PUBLIC_CLIENT`, `STORAGE_BUCKET`은 내부 심볼이다.
   - 환경변수 이름과 무관하다.
5. **하위호환 alias와 마이그레이션 가이드는 두지 않는다.**
   - 결정 시점에는 릴리스 태그와 실제 배포가 없다.
   - 이 시점에 breaking change 비용이 가장 낮다고 판단했다.
   - DEPLOY-01(README 환경변수 문서화)과 API-03(1.0 직전 breaking-change 정책 고정) 전에 변경한다.
   - 이 단계 이후의 변경은 alias 코드가 필요해진다고 판단했다.
6. **과거 ADR의 환경변수 이름은 소급 변경하지 않는다.**
   - ADR은 불변 로그다.
   - ADR-0002~0004와 api ADR-0006~0016의 옛 이름은 작성 당시의 이름이다.
   - 이름의 대응 관계는 이 ADR에 기록한다.

## Considered Options

- **충돌 위험이 큰 변수(`PORT`, `DB_*`, `API_KEY`)만 접두어 적용**: 보류한다.
  - 위험 판단에 따라 명명 방식이 다시 갈린다.
- **`STORIX_DB_HOST ?? DB_HOST` fallback 유지**: 보류한다.
  - 실제 배포가 없어 하위호환 코드가 필요하지 않다.
  - 배포 이후 다시 변경할 때 검토한다.
- **`SENTRY_DSN` 예외 유지**: 보류한다.
  - 공유 `.env`의 다른 앱이 별도 Sentry 프로젝트를 쓸 수 있다.
  - 당시 코드는 SDK 자동 인식에 의존하지 않는다.
- **`PORT`를 `STORIX_PORT`로만 변경**: 보류한다.
  - publish 포트와 listen 포트의 이중 의미가 남는다.

## Consequences

- **breaking**: `.env`, compose, CI 워크플로, 배포 문서의 환경변수 이름을 변경한다.
  - 기존 `.env`는 수동으로 이름을 바꿔야 한다.
  - alias는 제공하지 않는다.
- 당시 치환 범위는 다음과 같다.
  - 코드: `ConfigService.get*` 45곳, `requireEnv` 4곳, `main.ts` 1곳.
  - 통합 테스트: `process.env` 대입.
  - compose 파일 7개.
  - `.env.example`.
  - README 4개와 `docs/deployment/*`.
  - `.github/workflows/versity-demo-smoke.yml`.
- gitignore 대상인 로컬 작업 이력과 과거 ADR의 환경변수 이름은 바꾸지 않는다.
- 새 환경변수에도 `STORIX_` 접두어를 적용한다.
- 외부 규약을 직접 읽어야 하면 예외 목록에 추가한다.
  - 예: PaaS가 주입하는 `PORT`.
  - Storix가 정의한 변수가 아니므로 예외로 취급한다.
  - 이 ADR을 잇는 새 ADR에 기록한다.
