# @cp949/storix-scale

namespace 수가 1만·10만·100만으로 늘 때 API 시작·요청 지연·GC·메모리가 어떻게 변하는지 재는 수동 측정 하네스다.
일반 `pnpm test`·CI에는 넣지 않는다. 수치는 workload 조건에서 나온 관측값이며 SLA가 아니다.

## 전제

- Docker, Node 24.18 이상, 빌드된 API(`pnpm --filter @cp949/storix-api build`).
- 전용 컨테이너 `storix-scale-pg`(PostgreSQL 16)·`storix-scale-vgw`(VersityGW)와 volume `storix-scale-pgdata`·`storix-scale-vgwdata`만 만들고 지운다.
- 대량 적재·reset은 `storix_scale_` 접두어 database와 `storix-scale-` 접두어 컨테이너에만 허용한다(`src/infra/guard.ts`). 접속 호스트는 `127.0.0.1`이다.
- 포트: PostgreSQL `55433`(`STORIX_SCALE_PG_PORT`), VersityGW `57070`(`STORIX_SCALE_VGW_PORT`).
- 결과·서버 로그: `apps/scale/.work/`(`STORIX_SCALE_WORK_DIR`로 변경, git 제외).

## 실행

```sh
pnpm --filter @cp949/storix-api build
node apps/scale/src/cli.ts env up
node apps/scale/src/cli.ts seed --scale 1000000          # 약 2~3분, database 약 2.3GB
node apps/scale/src/cli.ts verify-fidelity               # API 표본과 SQL 적재 표본의 행 모양 대조
node apps/scale/src/cli.ts seed-objects --scale 1000000  # blob 행에 대응하는 실제 storage object 생성(GC 측정 전)
node apps/scale/src/cli.ts measure --scale 1000000 --label baseline --objects
node apps/scale/src/cli.ts report                        # 저장된 결과를 표로 출력
node apps/scale/src/cli.ts env down --volumes            # 컨테이너와 seed 데이터 삭제
```

- `seed`는 `storix_scale_t_<규모>_<seed>` template database를 만든다. 명세는 database comment에 저장한다.
- `measure`는 template을 복제(`CREATE DATABASE ... TEMPLATE`)한 database에서 실행하고 끝나면 지운다. 두 번 복제한다: API 단계(시작·capability 시작·요청·목록)와 GC 단계. GC가 데이터를 소모하므로 단계마다 복원한다.
- `--objects`는 GC 단계 전에 storage object를 복원한다(`seed-objects`가 해당 template용으로 만든 것이어야 한다). VersityGW posix 백엔드의 bucket 디렉터리(`apps/scale/.work/vgw-data/storix`)에 파일을 직접 만들고 수정 시각을 과거로 둔다.
- `--gc-env KEY=VALUE`는 GC 프로세스에만 env를 준다(`STORIX_GC_MAX_ROWS_PER_STAGE`, `NODE_OPTIONS=--max-old-space-size=48` 등). heap 상한을 낮춰 실패 지점을 찾으면 보유 메모리를 잴 수 있다.
- `STORIX_SCALE_API_DIR`로 측정 대상 API 디렉터리를 바꾼다. 이전 커밋을 `git archive`로 풀어 `./node_modules/.bin/nest build`로 빌드한 디렉터리를 줘 개선 전 기준선을 같은 하네스로 잰다(복사본에서 `pnpm`을 실행하면 실제 `node_modules`가 망가진다).
- 복제한 database에는 template 적재 이후의 migration을 적용하고 `restore.migrateMs`에 기록한다.
- 변형 데이터셋은 seed 이름으로 구분한다: `seed --scale N --seed s1-blocked --set blockedEvery=100`, 측정은 `measure --seed s1-blocked`.
- `--phases startup,startup-capability,startup-capability-default,requests,list,list-pages,gc`로 단계를 고른다(`startup-capability`는 활동 namespace를 설정에 나열, `-default`는 `defaultEnabledCapabilities`만 둔 기본 활성 모드). 적재 시각이 20일을 넘은 template은 보존 기간 기준이 어긋나 측정을 거부한다.

## 데이터셋

모든 행은 PostgreSQL의 `generate_series`로 만든다. 하네스는 ID를 보관하지 않고 번호 구간(5만)만 순회한다. ID는 `md5(seed:종류:번호)`에 version 4·variant 8 자리를 덮어쓴 UUID다.
기본 비율(`src/dataset/spec.ts`):

| 항목                   | 값                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| ACTIVE namespace       | N개. 모두 namespace 행·root `vfs_node`·생성 receipt(`idempotency_key`)를 가진다           |
| 활동 namespace         | 번호가 10의 배수(10%). `docs` 디렉터리·FILE 5개(1KiB)·blob 5개·관리 receipt 3개           |
| change feed            | 활동 namespace마다 state 1행·이벤트 10개. 번호가 1000의 배수이면 선두 3개가 60일 전       |
| orphan blob            | 번호가 500의 배수이면 `reference_count = 0`·60일 전 `zero_since`인 blob 2개               |
| DELETED namespace      | N/10개. `namespace_deletion`(COMPLETED)·생성 receipt·삭제 receipt                         |
| `blockedEvery`(기본 0) | 0이 아니면 해당 번호의 이벤트는 선두만 유효하고 뒤 3개가 90일 전. 보존 정리의 불리한 입력 |

- `seed`는 DB 행만 만든다. blob 행의 `storage_key`가 가리키는 object는 `seed-objects`가 만든다. object 없이 잰 GC 결과는 storage 목록·삭제 I/O와 메모리를 반영하지 않는다.
- `verify-fidelity`는 같은 이름의 namespace를 API로 만든 표본과 SQL로 적재한 표본을 비교한다. id·시각·해시·sequence 계열 열은 제외한다.

## 측정 항목

- API 시작 시간(spawn부터 `/health/ready` 200까지)과 준비 직후 RSS. capability 설정에 활동 namespace 수만큼 나열한 시작을 따로 잰다.
- 요청 지연 p50·p95(`GET /namespaces/{id}`, `fs/stat`, `fs/ls`, `fs/mkdir`, 1KiB 업로드), namespace 생성·삭제 접수 처리량. 실패 요청은 표본에 남기고 `failures`로 센다.
- `GET /api/v2/namespaces` 응답 시간·크기·API 프로세스 최대 RSS(전체 배열), page 모드의 첫 page와 전체 순회(`list-pages`).
- GC 1회 wall 시간·GC 프로세스 최대 RSS(`/proc/<pid>/status`의 `VmHWM`)·결과 JSON.
- 단계별 `pg_stat_database` 차이(트랜잭션·buffer·tuple), 주요 테이블·인덱스 크기.
