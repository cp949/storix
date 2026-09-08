# compose base 파일은 백엔드 중립이며, 컨테이너 추가는 백엔드·DB별 override 파일로만 한다

## 상태

승인됨 (2026-09-08) — 구현 완료.

## 배경

ADR-0003 이전의 루트 `docker-compose.yml`은 `postgres`/`minio` 컨테이너를 profile
없이 항상 기동하고, `app`/`gc`/`backup`/`restore`에 `STORAGE_ENDPOINT: minio`를
하드코딩했다. 그 위에 `docker-compose.versity-demo.yml`/`docker-compose.s3-demo.yml`/
`docker-compose.shared-db.yml` override가 쌓이면서 다음 문제가 굳어졌다:

- 어떤 override를 겹쳐도 base의 `postgres`/`minio`가 미사용 상태로 같이 떴다
  (ADR-0003 Consequences 1번, "N개 WAS가 1개 공유 DB를 바라보는 토폴로지와 맞지
  않는다").
- base만 보면 MinIO가 기본이고 VersityGW/S3는 시연으로 읽혔다. `-demo` 접미사가
  "지원 백엔드"가 아니라 "예제"라는 인상을 줬다. `docker-compose.minio-demo.yml`은
  동작을 바꾸지 않는 문서용 파일이었다.
- s3 override가 `AWS_S3_*`라는 별도 변수를 써야 했다 — `STORAGE_ACCESS_KEY`가
  base의 `minio` 컨테이너 root 자격증명으로도 흘러들어갔기 때문이다.
- 같은 env 블록이 파일마다 서비스 4개에 반복됐다.
- `PORT: 3000`처럼 unquoted 정수 env 값이 podman-compose 1.6에서 파싱 실패를
  일으켰다(같은 서비스 안의 `${PORT}` 치환에 int가 들어가 `''.join`이 죽는다).
  DEPLOY-05가 전제한 Docker/Podman 공통 동작이 실제로는 깨져 있었다.

## 결정

1. **base(`docker-compose.yml`)는 `app`/`migrate`/`gc`/`backup`/`restore`만
   정의한다.** Postgres·스토리지 컨테이너를 포함하지 않는다. DB·스토리지 접속
   정보는 전부 `.env`의 `DB_*`/`STORAGE_*`에서 온다. base 단독 기동 = 이미 운영
   중인 외부 DB + 외부 S3 호환 스토리지에 붙는 구성.
2. **컨테이너 추가·연결 재정의는 `docker-compose.<대상>.yml` override로만 한다.**
   - `docker-compose.versitygw.yml` — VersityGW 컨테이너 + 버킷 초기화, 4개
     서비스의 `STORAGE_ENDPOINT/PORT/USE_SSL` 재정의. 목표 기본 백엔드(ADR-0003).
   - `docker-compose.minio.yml` — MinIO 동일 패턴. `nginx-demo` profile(STORAGE-03
     샘플)도 여기 둔다 — `nginx-reverse-proxy.conf`가 `minio:9000`으로 고정된
     MinIO 전용 구성이기 때문이다.
   - `docker-compose.s3.yml` — 컨테이너 없음. 엔드포인트/443/SSL/path-style/
     `STORAGE_PUBLIC_*`만 AWS 값으로 고정. 자격증명·리전·버킷은 `.env`의
     `STORAGE_*`를 그대로 쓴다(`AWS_S3_*` 제거 — 이 조합에는 그 값을 root
     자격증명으로 받는 컨테이너가 없다).
   - `docker-compose.postgres.yml` — 개발·검증용 Postgres 컨테이너, 5개 서비스의
     `DB_HOST/DB_PORT`를 `postgres:5432`로 재정의, 호스트 `127.0.0.1:${DB_PORT}`
     노출.
   - 세 백엔드 파일은 서로 우선하지 않는 동급이다. 파일 목록만으로 지원
     백엔드(VersityGW/MinIO/S3)를 알 수 있어야 하므로 `-demo` 접미사를 쓰지
     않는다.
3. **CI 전용 override는 루트 밖(`.github/compose.ci.yml`)에 둔다.** 루트의
   `docker-compose*` 목록은 사용자용 파일만 남긴다. `.github/workflows/` 안은
   GitHub이 워크플로로 파싱하므로 그 바깥에 둔다.
4. **파일 안 중복은 YAML 앵커(`x-*` + `&`/`*`/`<<:`)로 제거한다.** base는
   `x-db-env`/`x-storage-env`/`x-api-build`, 각 override는 `x-<대상>-env`/
   `x-<대상>-deps`를 4~5개 서비스에 재사용한다. compose-spec 표준이며 docker
   compose(yaml.v3)·podman-compose(PyYAML) 모두 지원한다.
5. **`${VAR:?}` 필수 마커를 base·백엔드 override에 쓰지 않는다.** 필수 마커는
   profile 필터링·override 병합보다 먼저 파일 전체에 대해 평가돼, override가
   값을 채우는 조합까지 막는다. 미설정은 app 부팅 시점의 검증(`requireEnv`,
   `ConfigService.getOrThrow`)에 맡긴다. 유일한 예외는 어떤 조합에서도 외부에서
   와야 하는 `API_KEY`다.
6. **`environment`의 숫자 리터럴은 quote한다**(`PORT: '3000'`,
   `STORAGE_PORT: '7070'` 등). Docker Compose는 어차피 문자열로 넘기고,
   podman-compose의 int 치환 결함을 피한다.
7. `docker-compose.shared-db.yml`과 `SHARED_DB_HOST`는 없앤다 — 외부 DB가 base의
   기본이 되어 `.env`의 `DB_HOST`/`DB_PORT`가 그 역할을 한다. 공유 DB의 비표준
   포트도 `DB_PORT`로 지정할 수 있다.
8. `-f` 나열을 줄이는 두 경로를 문서화한다: (a) override를
   `docker-compose.override.yml`로 복사(gitignore, docker/podman 둘 다 자동 병합),
   (b) `.env`의 `COMPOSE_FILE`(docker compose만 읽음, podman-compose는 쉘 export
   필요).

## Considered Options

- **단일 파일 + profile로 백엔드 선택**: `app`이 profile 서비스(`minio` 등)에
  `depends_on`을 걸 수 없고(비활성 profile 의존은 검증 오류), `STORAGE_ENDPOINT`를
  profile에 따라 바꿀 방법이 없다. 파일 목록으로 지원 백엔드를 인지할 수도
  없다. 보류.
- **백엔드별 self-contained 파일(복사해서 쓰는 완결 파일)**: `app`/`gc`/`backup`/
  `restore` 정의가 파일 3개에 그대로 복제돼, env 하나를 바꿀 때마다 세 곳을
  고쳐야 한다. 보류.
- **compose `include:`**: 포함된 파일의 서비스를 override할 수 없어(충돌 오류)
  `STORAGE_ENDPOINT` 재정의·`depends_on` 추가가 불가능하다. 보류.
- **MinIO를 base 기본으로 유지하고 나머지만 override**: ADR-0003 배경에 기록된
  오독(MinIO가 기본이라는 인상)을 그대로 남긴다. 보류.

## Consequences

- **breaking**: base 단독 `docker compose up`이 더 이상 `postgres`/`minio`를 띄우지
  않는다. 기존 로컬 개발 명령은 `-f docker-compose.yml -f docker-compose.versitygw.yml
  -f docker-compose.postgres.yml`(또는 minio)로 바뀐다. `SHARED_DB_HOST`/`AWS_S3_*`
  변수는 사라진다.
- ADR-0003 Consequences 1번("스택마다 전용 postgres를 새로 만드는 구조")은 이
  배치로 해소된다. 멀티 인스턴스 절차는
  `docs/deployment/multi-instance-versitygw.md`가 이 배치 기준으로 갱신됐다.
- nginx reverse-proxy 샘플은 MinIO 전용으로 남는다(`docker-compose.minio.yml`).
  VersityGW 앞에 두는 백엔드 중립 샘플(upstream 템플릿화 + 통합 테스트 반영)은
  후속 작업이다.
- 로컬 검증은 podman-compose `config`로 조합 6종(base 단독, +versitygw,
  +versitygw+postgres+ci, +minio+postgres+nginx-demo, +minio, +s3; gc/backup/restore
  profile 포함)의 병합 결과를 확인했다. 실 기동은 로컬 podman-compose의 기본
  네트워크 DNS 결함 때문에 불가능하며, `dev` push 시
  `.github/workflows/versity-demo-smoke.yml`이 실제 Docker Compose로 검증한다.
- `.env`의 `COMPOSE_FILE`을 docker compose가 읽는다는 것은 compose-go의 옵션 적용
  순서(`WithOsEnv` → `WithDotEnv` → `WithConfigFileEnv`)에 근거한 것으로, 이
  저장소의 로컬 환경(docker 없음)에서는 검증하지 못했다.
