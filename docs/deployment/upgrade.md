# 업그레이드 절차

DEPLOY-03. self-host 배포를 새 버전으로 갱신하는 절차다.
롤백 결정은 [api ADR-0017](../../apps/api/docs/adr/0017-migration-rollback-via-backup-restore.md)을 따른다.

이 문서는 single-instance 배포를 다룬다.
멀티인스턴스의 배치·운영 규칙은 [VersityGW 멀티 인스턴스 배포](./multi-instance-versitygw.md)를 따른다.
멀티인스턴스 업그레이드 조율은 이 절차의 범위 밖이다.

Compose 명령에는 실제 배포의 `-f` 조합을 붙인다.
예를 들어 `-f docker-compose.yml -f docker-compose.versitygw.yml`을 사용한다.
조합 설정은 [README](../../README.md)의 "실행"을 따른다.

## 버전 식별

- 배포 버전은 `vX.Y.Z` 태그로 식별한다(API-02).
- 변경사항은 `CHANGELOG.md`의 `## [X.Y.Z]`에서 확인한다.
- 태그 생성·게시는 [릴리즈 절차](./release.md)를 따른다.

아래 절차는 소스 빌드 기준이다.
원하는 태그를 checkout한 뒤 이미지를 재빌드한다.

- 사전 빌드 이미지는 `ghcr.io/cp949/storix:vX.Y.Z`로 게시한다.
- 기본 Compose에는 `image:`가 없고 `build:`만 있다.
- 이 구성에서 `docker compose pull`로 사전 빌드 이미지를 사용하는 흐름은 제공하지 않는다.

## 절차

1. 모든 API 쓰기와 GC를 중단하고 백업한다.
   - 백업 완료를 확인한 뒤 코드 갱신을 시작한다.
   - 스키마 롤백에는 업그레이드 전 백업이 필요하다(api ADR-0017).
   - 중단·백업 방법은 [백업/복구 운영 절차](./backup-restore.md)의 "백업"을 따른다.

   ```bash
   docker compose --profile backup run --rm backup
   ```

2. 코드를 갱신한다.

   ```bash
   git fetch && git checkout <커밋 또는 브랜치>
   ```

3. 이미지를 재빌드하고 재기동한다.
   - base Compose에서 `app`은 `migrate` 성공에 의존한다.
   - `up`은 migration을 실행한다. 별도 migration 명령은 필요 없다.
   - 기동 순서는 [README](../../README.md)의 "기동 순서"를 따른다.
   - namespace 제한·ID 변경 버전은 아래 "Namespace 제한·ID migration 주의"도 따른다.

   ```bash
   docker compose up -d --build
   ```

   Podman 명령:

   ```bash
   podman-compose up -d --build
   ```

4. `migrate` 성공을 확인한다.
   - `migrate`가 `Exited (0)`인지 확인한다.
   - podman-compose 1.6.0 이하는 migration 실패 후에도 `app`을 올릴 수 있다.
   - 제약은 [README](../../README.md)의 "Podman 주의"를 따른다.

   ```bash
   docker compose ps migrate
   ```

5. readiness를 확인한다.

   ```bash
   until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done && echo ready
   ```

6. migration과 readiness가 성공하면 쓰기와 GC를 재개한다.

## 실패 시 대응

자동 스키마 revert는 지원하지 않는다(api ADR-0017).
롤백 전에 migration 로그와 적용 이력을 확인한다.
실패했다는 이유만으로 스키마가 변경되지 않았다고 판단하지 않는다.

| 상태                             | 대응                                      |
| -------------------------------- | ----------------------------------------- |
| 스키마가 변경되지 않음           | 이전 커밋으로 되돌리고 3단계부터 실행한다 |
| 스키마 변경 후 애플리케이션 문제 | 현재 스키마와 호환되는 코드로 재배포한다  |
| 스키마까지 되돌려야 함           | 1단계 백업으로 인스턴스 전체를 복구한다   |

`migrate`는 이미 적용된 migration을 건너뛴다.
이 동작만으로 이전 코드와 새 스키마의 호환성을 보장하지 않는다.
복구는 [백업/복구 운영 절차](./backup-restore.md)의 "복구"를 따른다.
부분 복구는 지원하지 않는다.

```txt
위험도: 높음(스키마 변경 후 백업 복구가 필요한 경우)
롤백: 1번 백업을 실행했다면 가능. 건너뛰었다면 불가능.
```

## 범위 밖

- 여러 WAS가 공유 DB를 사용하는 업그레이드 조율.
- 무중단(zero-downtime) migration 정책.
- 구버전 앱과 호환되지 않는 컬럼 삭제·타입 변경의 무중단 처리.
- 자동 스키마 되돌리기(`migration:revert`).

## Namespace 제한·ID migration 주의

실행 조건:

- Namespace ID·counter 변경 버전은 기존 API와 혼합 실행하지 않는다.
- 쓰기를 중단한 상태에서 migration을 실행한다.
- 실행 전에 백업한다.
- 배포 전 namespace-scale에서 실제 규모의 migration 시간·잠금·WAL을 확인한다.

롤백 조건:

- 새 prefix ID가 생성되면 이전 UUID-only 코드로 재배포하지 않는다.
- 새 ID와 모든 참조를 역변환할 수 있는지 확인한다.
- 역변환할 수 없으면 migration 전 백업을 복원한다.
- UUID 이외의 ID가 있으면 migration down은 거부된다.

새 상한:

- 폴더 FILE 상한 기본값은 10000이다.
- live node 상한 기본값은 1000000이다.
- migration은 상한을 초과한 기존 데이터를 삭제하지 않는다.
- 초과 상태에서도 감소 작업은 허용한다.
- 해당 제한을 늘리는 저장은 사용량이 제한 아래로 내려올 때까지 거부한다.

```text
위험도: 높음
롤백: migration 전 데이터 백업 복원. 새 prefix ID가 생성된 뒤에는 ID·참조 역변환 없이 이전 스키마로 되돌릴 수 없다.
```

측정 근거:

- PostgreSQL 16 전용 하네스의 `storix-scale-v1` seed에서 migration 전체 시간을 측정했다.
- 1만 namespace는 5.53초, 10만은 10.78초, 100만은 105.77초였다.
- 100만 값은 migration transaction 전체 경과 시간이다.
- 개별 테이블 lock·WAL bytes는 직접 계측하지 않았다.
- 데이터 분포·하드웨어·WAL 설정이 다르면 결과도 달라진다.
- 운영 전 실제 배포 조건에서 재측정한다.
