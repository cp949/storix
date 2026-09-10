# Storix all-in-one 데모 배포

이 문서는 여러 배포 시나리오 중 하나다. Storix의 표준 배포 방법을 정의하지
않는다. Browser부터 Storix의 실제 저장 백엔드까지 한 번의 compose 명령으로
기동해 업로드·디렉터리 조작·복사·이동·삭제·인가된 다운로드·영구 공개 링크
발행을 실제 스택으로 확인하려 할 때 적용한다. **개발/데모 전용이며 운영
배포에는 사용하지 않는다** — 인증은 `X-Demo-User` 헤더뿐이고 TLS도 없다.

## 적용 조건

- 단일 개발 호스트에서 Postgres·VersityGW·Storix·Demo WAS·Nginx·React를 모두
  컨테이너로 띄운다.
- Browser는 Nginx의 단일 origin(`http://localhost:8080`)만 사용한다.
- 운영 배포, 실사용자 인증, mTLS가 필요하면
  [`co-located-nginx-mtls`](../co-located-nginx-mtls/README.md)를 별도로
  본다 — 이 문서는 그 시나리오로 가는 다음 단계가 아니라 완전히 다른 토폴로지의
  데모다.

## 토폴로지

```text
Browser
  │
  ▼
Nginx(:8080) ──/demo-api/──────> Demo WAS ──────> Storix(app:3000) ─> PostgreSQL
  │                                                    │
  ├──/storix-demo/(서명된 GET만)─────────────────────> VersityGW(:7070)
  └──/api/v1/public/(무인증 GET만)────────────────────> Storix(app:3000)
```

## 포함 파일

- [`nginx/Dockerfile`](nginx/Dockerfile): React(`@storix/demo`) production
  build + nginx:1.29-alpine 런타임
- [`nginx/default.conf`](nginx/default.conf): `= /health`, `/`, `/demo-api/`,
  `/storix-demo/`, `/api/v1/public/` 5개 location
- [`nginx/00-log-formats.conf`](nginx/00-log-formats.conf): presigned query
  string을 기록하지 않는 로그 형식
- [`compose.demo.yml`](compose.demo.yml): base + versitygw + postgres 위에
  `demo-was`/`nginx` 서비스를 추가하는 override
- [`env/development.env.example`](env/development.env.example): 개발 설정
  예시(운영 자격증명 아님)
- [`smoke-test.sh`](smoke-test.sh): 실제 스택 대상 업로드→목록→검색→복사→
  이동→인가된 다운로드→영구 공개 발행/취소→삭제→상한 초과/경로 충돌 자동 검증
  + 업로드 스트리밍 메모리 바운드 확인

`apps/demo-was/Dockerfile`은 이 시나리오 전용이 아니라 `apps/demo-was` 자체
소유다(다른 배포 조합에서도 재사용 가능하도록).

## 기동

```bash
docker compose \
  --env-file docs/deployment/scenarios/demo-all-in-one/env/development.env.example \
  -f docker-compose.yml \
  -f docker-compose.versitygw.yml \
  -f docker-compose.postgres.yml \
  -f docs/deployment/scenarios/demo-all-in-one/compose.demo.yml \
  up --build --wait
```

`podman-compose`가 `--wait`를 지원하지 않으면 `up -d --build` 후
`curl -sf http://localhost:8080/health`가 200을 반환할 때까지 폴링한다.

기동 후 `http://localhost:8080/`을 연다.

## 검증

```bash
docs/deployment/scenarios/demo-all-in-one/smoke-test.sh
```

이 스크립트가 확인하는 것: mkdir·경로 충돌(409)·대용량 업로드+메모리 바운드·
목록·검색·복사·이동·다른 사용자 경로 이탈(403)·인가된 presigned 다운로드·
query 변조 실패·영구 공개 발행·무인증 공개 다운로드·미발행 경로 404·발행
취소·재귀 삭제·업로드 상한 초과(413). 자세한 단계별 대응은
[`_works/demo-proposals.md`](../../../../_works/demo-proposals.md) 섹션
13.3을 참고한다(로컬 참고자료, git 미추적).

Browser로 직접 확인해야 하는 항목(drag-and-drop 업로드, breadcrumb 이동,
Alice/Bob 전환, 공개 링크를 시크릿 창에서 여는 것 등)은 문서 아카이브 UI가
아직 없어(다음 계획 Plan C) 이 단계에서는 검증하지 않는다.

## 종료

```bash
docker compose \
  --env-file docs/deployment/scenarios/demo-all-in-one/env/development.env.example \
  -f docker-compose.yml \
  -f docker-compose.versitygw.yml \
  -f docker-compose.postgres.yml \
  -f docs/deployment/scenarios/demo-all-in-one/compose.demo.yml \
  down -v
```

## 알려진 제약

- 인증은 `X-Demo-User: alice|bob` 헤더뿐이다 — 실제 인증이 아니며 운영에
  복사하면 안 된다.
- TLS가 없다 — 모든 트래픽이 평문이다.
- 공개 발행(`accessPolicy=PUBLIC`)은 되돌릴 수 없다 — 발행 취소는 공개
  namespace에서 해당 경로만 삭제할 뿐, 이미 요청되어 캐시되었거나 공유된
  사본까지 회수하지 못한다.
- 공개 콘텐츠 접근에 대한 로그·감사·rate limit이 없다(Storix 자체에 감사
  로그가 없고, rate limit은 nginx 책임이라는 ADR-0023 결정을 그대로 따른다).
- `STORIX_MAX_FILE_SIZE_BYTES`를 40MiB로 낮춰 검증 편의를 높였다 — 운영값
  (기본 5GiB)과 다르다.
- `app:3000`(Storix API 컨테이너)도 base `docker-compose.yml`에 의해 호스트에
  노출된다 — 이 시나리오의 override가 이를 막지 않는다. API key로 보호되지만,
  Nginx만이 유일한 호스트 노출 포트가 아니라는 점을 알아둔다.
