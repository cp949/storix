# 업그레이드 절차

DEPLOY-03. self-host 배포에서 Storix를 새 버전으로 올리는 절차다. 롤백 정책의
설계 배경은 `../../apps/api/docs/adr/0017-migration-rollback-via-backup-restore.md`
참고.

범위: single-instance 배포만 다룬다. 여러 WAS가 Postgres를 공유하는 멀티인스턴스
배치(`multi-instance-versitygw.md`)는 아직 미구현이라 이 절차에 없다 — 도입되면
이 문서도 갱신한다.

아래 `docker compose ...` 명령은 실제 배포에 쓰는 `-f` 조합(예:
`-f docker-compose.yml -f docker-compose.versitygw.yml`)을 그대로 앞에 붙여
실행한다(`README.md` "실행" 절 참고).

## 버전 식별

태그 릴리즈(`API-02`)가 도입돼 "버전"은 `vX.Y.Z` 태그 기준이다. `CHANGELOG.md`의
`## [X.Y.Z]` 절에서 해당 버전에 포함된 변경사항을 확인한다. 릴리즈를 어떻게
만드는지는 `release.md` 참고 — 이 문서는 이미 나온 버전으로 배포 인스턴스를
올리는 절차만 다룬다.

아래 절차는 소스 빌드 기준이다(원하는 태그를 `git checkout`한 뒤 로컬에서
이미지를 재빌드) — README가 명시한 배포 단위 그대로다. `ghcr.io/cp949/storix:vX.Y.Z`
사전 빌드 이미지도 나오지만, 이 compose 구성은 아직 `image:` 필드가 없어
`docker compose pull`로 바로 받아 쓸 수는 없다(`build:`만 정의됨). compose에서
사전 빌드 이미지를 직접 당겨 쓰는 흐름은 후속 과제로 남겨둔다.

## 절차

1. **백업(필수)**. 마이그레이션이 스키마를 바꾸면 되돌릴 방법은 이 백업뿐이다
   (ADR-0017).

   ```bash
   docker compose --profile backup run --rm backup
   ```

2. **코드 갱신**.

   ```bash
   git fetch && git checkout <커밋 또는 브랜치>
   ```

3. **재빌드·재기동**. `migrate`는 base compose에서 `app`의 의존성이라 `up`마다
   자동 실행된다(`README.md` "기동 순서" 참고) — 별도 마이그레이션 명령이
   필요 없다.

   ```bash
   docker compose up -d --build
   ```

   Podman은 명령 이름만 다르다.

   ```bash
   podman-compose up -d --build
   ```

4. **`migrate` 성공 확인**. podman-compose 1.6.0 이하는 `migrate` 실패에도
   `app`을 올릴 수 있다(`README.md` "Podman 주의" 참고) — `ps`에서 `migrate`가
   `Exited (0)`인지 반드시 확인한다.

   ```bash
   docker compose ps migrate
   ```

5. **동작 확인**.

   ```bash
   until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done && echo ready
   ```

## 실패 시 대응

자동 revert는 지원하지 않는다(ADR-0017). 이번 마이그레이션이 스키마를 바꿨는지로
갈린다.

- **스키마 변경 없이 애플리케이션 버그만 있는 경우**(`migrate`가 아무 것도 하지
  않았거나 애초에 실패): 이전 커밋으로 되돌려 3번부터 다시 실행한다. `migrate`는
  이미 적용된 마이그레이션을 건너뛰므로 안전하다.
- **스키마 변경 마이그레이션까지 성공한 뒤 문제가 발견된 경우**: 애플리케이션
  코드만 문제라면 위와 동일하게 재배포한다. 스키마까지 되돌려야 하면 1번에서
  뜬 백업으로 복구한다(`backup-restore.md`의 복구 절차 — 인스턴스 전체 재해복구
  절차와 동일하며 부분 복구는 지원하지 않는다).

```txt
위험도: 높음(스키마 변경 후 백업 복구가 필요한 경우)
롤백: 1번 백업을 실행했다면 가능. 건너뛰었다면 불가능.
```

## 범위 밖

- 멀티인스턴스(여러 WAS가 DB 공유) 업그레이드 조율 — 토폴로지 자체가 아직
  미구현이다(`../adr/0003-versitygw-primary-backend-and-topology.md`).
- 무중단(zero-downtime) 마이그레이션 정책 — 현재 마이그레이션 6개는 전부
  추가적(additive)이라 문제되지 않았지만, 컬럼 삭제·타입 변경처럼 구버전
  앱과 호환되지 않는 마이그레이션을 다루는 정책은 아직 없다.
- 자동 스키마 되돌리기(`migration:revert`) — ADR-0017.
