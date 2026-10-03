# 단일 호스트 private 배포

이 문서는 여러 배포 시나리오 중 하나다. Storix의 표준 배포 방법을 정의하지 않는다.
NAS 없이 한 호스트에서 WAS와 Storix를 모두 Docker로 운영하고, 파일에 개인정보가 포함될 수 있을 때 적용한다.

## 적용 조건

- 호스트가 1대다.
- WAS, Storix, VersityGW가 모두 Docker Compose 컨테이너다.
- VersityGW의 데이터는 그 호스트의 로컬 디스크에 둔다.
- DB는 SQLite 또는 Postgres 컨테이너다.
- 개인정보 파일은 `ENCRYPTED` namespace에 둔다.
- 개인정보 파일은 presigned URL 없이 Storix `/download`를 WAS가 중계해 내려준다.

적용하지 않는 경우:

- 호스트가 2대 이상이다. [내부 mTLS 시나리오](../co-located-nginx-mtls/README.md)를 쓴다.
- 여러 Storix 프로세스가 SQLite 파일 하나를 공유한다.
- `PLAIN` namespace의 파일을 presigned URL로 브라우저에 직접 내려준다. Nginx가 VersityGW에 접근해야 하므로 이 시나리오의 network 구성을 따로 바꿔야 한다.

## 토폴로지

```text
인터넷 ─443→ Nginx ─ edge ─ WAS ─ storix-front ─ Storix(app) ─ default(internal) ─ VersityGW ─ 로컬 디스크
                                                                                 └ Postgres (선택)
```

| network        | 소속                                               | 성격                                                     |
| -------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `edge`         | Nginx, WAS                                         | WAS 쪽 compose가 정의한다. 이 시나리오의 범위 밖이다.    |
| `storix-front` | WAS, Storix `app`                                  | 외부에서 미리 만든다. `--internal`로 외부 송신을 막는다. |
| `default`      | Storix project의 모든 서비스(VersityGW·DB·잡 포함) | `compose.private.yml`이 `internal: true`로 바꾼다.       |

Storix `app`만 `default`와 `storix-front`에 동시에 속한다. WAS는 `default`에 속하지 않으므로 VersityGW와 DB에 접근하지 못한다.

## 신뢰 경계

| 구간                  | 보호 수단                                                | 비고                                      |
| --------------------- | -------------------------------------------------------- | ----------------------------------------- |
| 외부 → Nginx          | 공개 TLS                                                 | 이 시나리오의 범위 밖                     |
| Nginx → WAS           | `edge` network                                           | Nginx는 `storix-front`에 속하지 않는다.   |
| WAS → Storix          | `storix-front` network와 `Authorization: Bearer` API key | 같은 호스트이므로 TLS·mTLS를 쓰지 않는다. |
| Storix → VersityGW·DB | `default`(internal) network와 S3 SigV4·DB 계정           | WAS에서 도달할 수 없다.                   |
| 디스크·백업           | `ENCRYPTED` namespace, 디스크 암호화, 백업 파일 암호화   | 아래 "데이터 보호"                        |

`ENCRYPTED`를 제외한 보호는 모두 Docker network 경계에 의존한다. 호스트 root나 Docker daemon을 장악한 공격자는 막지 못한다.

## 포함 파일

- [`compose.private.yml`](compose.private.yml): network 분리, 포트 게시 제거, capability 제한
- [`compose.private-postgres.yml`](compose.private-postgres.yml): `docker-compose.postgres.yml`이 연 호스트 포트 제거. Postgres를 쓸 때만 겹친다.
- [`compose.secrets.yml`](compose.secrets.yml): `STORIX_API_KEY`·`STORIX_ENCRYPTION_MASTER_KEY`를 compose secret 파일로 전달한다.
- [`compose.secrets-postgres.yml`](compose.secrets-postgres.yml): Postgres 비밀번호를 파일로 전달한다. `compose.secrets.yml`과 Postgres를 함께 쓸 때만 겹친다.
- [`env/storix.env.example`](env/storix.env.example): 비밀값 파일 틀

## 설치

1. `storix-front` network를 만든다.

   ```bash
   docker network create --internal storix-front
   ```

2. 비밀값 파일을 만든다.

   ```bash
   sudo install -d -m 700 /etc/storix
   sudo install -m 600 docs/deployment/scenarios/single-host-private/env/storix.env.example /etc/storix/storix.env
   sudoedit /etc/storix/storix.env
   ```

   - `STORIX_API_KEY`, `STORIX_ENCRYPTION_MASTER_KEY`, `STORIX_STORAGE_*` 비밀값은 `openssl rand -hex 32`로 만든다.
   - `STORIX_VERSITYGW_DATA_PATH`에 디스크 암호화를 적용한 마운트 경로를 넣는다.
   - 권장: API key·마스터 키·Postgres 비밀번호는 환경변수 대신 파일로 전달한다. 3단계 전에 아래 "비밀값 파일 전달"을 따른다.

3. Storix를 기동한다. SQLite 조합이다.

   ```bash
   docker compose \
     --env-file /etc/storix/storix.env \
     -f docker-compose.yml \
     -f docker-compose.versitygw.yml \
     -f docker-compose.sqlite.yml \
     -f docs/deployment/scenarios/single-host-private/compose.private.yml \
     up -d --build
   ```

   Postgres 조합은 `docker-compose.sqlite.yml` 자리에 `docker-compose.postgres.yml`을 넣고 `compose.private-postgres.yml`을 `compose.private.yml` 뒤에 추가한다.

4. WAS compose에서 `storix-front`에 붙는다.

   ```yaml
   services:
     was:
       networks: [edge, storix-front]
   networks:
     edge: {}
     storix-front:
       external: true
   ```

   WAS는 `http://storix:3000`으로 호출하고 `Authorization: Bearer <STORIX_API_KEY>`를 보낸다.

`storix` 호스트명은 `storix-front` network에서 `app` 컨테이너에 붙은 alias다. alias를 쓰지 않으려면 `compose.private.yml`의 `aliases`를 지우고 WAS가 `http://app:3000`을 쓴다.

## 비밀값 파일 전달

권장 방식이다. 비밀값을 환경변수 대신 compose secret 파일로 전달한다.
규약과 규칙은 [비밀값 전달 방식](../../../../README.md#비밀값-전달-방식)과 [비밀값 소스 설계](../../../design/15-secret-sources.md)에 있다.

전달하는 값:

- `compose.secrets.yml`: `STORIX_API_KEY`, `STORIX_ENCRYPTION_MASTER_KEY`.
- `compose.secrets-postgres.yml`: `STORIX_DB_PASSWORD`(Postgres 서비스의 `POSTGRES_PASSWORD`도 같은 파일).

### 절차

1. 비밀 파일 디렉터리를 만든다.

   ```bash
   sudo install -d -m 700 /etc/storix/secrets
   ```

2. 비밀 파일을 만든다. 파일 이름은 compose secret 이름과 같다.

   ```bash
   openssl rand -hex 32 | sudo tee /etc/storix/secrets/storix_api_key >/dev/null
   openssl rand -hex 32 | sudo tee /etc/storix/secrets/storix_encryption_master_key >/dev/null
   sudo chmod 444 /etc/storix/secrets/storix_api_key /etc/storix/secrets/storix_encryption_master_key
   ```

   Postgres 조합이면 비밀번호 파일도 만든다.

   ```bash
   openssl rand -hex 32 | sudo tee /etc/storix/secrets/storix_db_password >/dev/null
   sudo chmod 444 /etc/storix/secrets/storix_db_password
   ```

   - 마스터 키는 `ENCRYPTED` namespace를 쓰지 않아도 파일을 만든다.
   - 빈 파일은 해석 단계에서 `empty`로 실패한다.
   - 파일이 없을 때 `docker compose`가 어떻게 동작하는지는 확인하지 않았다.
   - 다른 위치를 쓰려면 `STORIX_SCENARIO_SECRETS_DIR`을 지정한다.

3. `/etc/storix/storix.env`에서 `STORIX_API_KEY`와 `STORIX_ENCRYPTION_MASTER_KEY` 값을 비운다. Postgres 조합이면 `STORIX_DB_PASSWORD`도 비운다.
   - override가 `app`의 해당 환경변수를 `""`로 덮어쓴다.
   - 값이 남아 있으면 호스트의 env 파일에 평문이 남는다.

4. 기동 명령에 override를 추가한다. SQLite 조합이다.

   ```bash
   docker compose \
     --env-file /etc/storix/storix.env \
     -f docker-compose.yml \
     -f docker-compose.versitygw.yml \
     -f docker-compose.sqlite.yml \
     -f docs/deployment/scenarios/single-host-private/compose.private.yml \
     -f docs/deployment/scenarios/single-host-private/compose.secrets.yml \
     up -d --build
   ```

   Postgres 조합은 `docker-compose.sqlite.yml` 자리에 `docker-compose.postgres.yml`을 넣는다. `compose.private-postgres.yml`을 `compose.private.yml` 뒤에, `compose.secrets-postgres.yml`을 `compose.secrets.yml` 뒤에 추가한다.

파일 권한:

- 비밀 파일은 0444, 디렉터리는 0700이다.
- 디렉터리 0700은 호스트의 다른 사용자가 파일에 닿지 못하게 한다.
- postgres 이미지가 어느 사용자로 `POSTGRES_PASSWORD_FILE`을 읽는지는 확인하지 않았다.
- 0444 파일은 postgres 이미지가 읽었다.
- 그래서 파일을 0444로 둔다.
- 더 좁은 권한(0400 root 등)에서 읽히는지는 확인하지 않았다.
- 컨테이너 안에서 `/run/secrets`의 파일은 `-r--r--r--`이다. 호스트 디렉터리의 0700은 컨테이너 안에 적용되지 않는다.

### 위협 모델 요약

막는 경로(파일 전달 컨테이너에서 확인):

- `docker inspect`의 `Config.Env`에 비밀값이 없다.
- `app` 프로세스와 컨테이너에 exec한 셸의 `/proc/*/environ`에 비밀값이 없다.

막는 경로(코드):

- `backup`·`restore`가 실행하는 `pg_dump`·`pg_restore` 자식은 허용 목록(`PATH`, `HOME`, `TZ`, `LANG`, `LC_*`, `PG*`)만 받는다. 비밀값을 상속하지 않는다.
- 단위 테스트(`apps/api/test/jobs/pg-dump-cli.tool.spec.ts`)로 확인했다. 컨테이너 안 자식 프로세스의 환경은 확인하지 않았다.

막는 경로(구성상):

- compose `.env`·env 파일 보간으로 다른 서비스에 값이 전달되지 않는다. 비밀값이 env 파일에 없기 때문이다.

막지 못하는 경로:

- 호스트의 평문 파일. 호스트 root와 Docker daemon 권한자는 `/etc/storix/secrets`를 읽는다.
- 컨테이너 안의 `/run/secrets` 파일. 0444이므로 컨테이너 안의 모든 프로세스가 읽는다.
- 같은 프로세스 권한의 읽기. 해석값이 `app` 프로세스의 `process.env`에 있다.

### VersityGW 한계

- 이 override는 VersityGW에 비밀값을 파일로 전달하지 않는다.
- VersityGW v1.8.0의 최상위 `--help` 범위에서 파일 기반 자격증명 옵션이 없었다. `posix` 등 하위 명령 도움말은 확인하지 않았다.
- `STORIX_STORAGE_ACCESS_KEY`·`STORIX_STORAGE_SECRET_KEY`는 VersityGW root 자격증명으로도 쓰인다.
- 따라서 두 값은 `/etc/storix/storix.env`에 남고 컨테이너 환경변수로 전달된다. 파일 전달로 노출 경로가 줄지 않는다.
- `STORIX_DB_USERNAME`과 `STORIX_SENTRY_DSN`도 이 override의 대상이 아니다.

### 확인한 범위

- 시나리오 override로 Postgres 조합을 기동했다. VersityGW는 v1.8.0이다.
  - `postgres`와 `versitygw`가 `healthy`이고 `app`이 `healthy`이다.
  - `migrate`와 `versitygw-init`이 종료 코드 0이다.
- `app` 컨테이너에서 확인했다.
  - `STORIX_API_KEY`, `STORIX_ENCRYPTION_MASTER_KEY`, `STORIX_DB_PASSWORD`의 비밀값이 `Config.Env`와 `/proc/*/environ`에 없다.
  - `/proc/*/environ`에서 세 변수의 `_FILE=` 줄은 나왔다. 검사 대상이 비어 있지 않다는 대조다.
  - 키 없이 호출하면 401이다. 파일에서 읽은 키로 호출하면 400이다. 401이 아니므로 인증은 통과했다. 200 응답은 확인하지 않았다.
- `docker compose config`에서 `app`에 세 비밀이 모두 있다. compose가 override 파일들의 `secrets:` 목록을 병합한다.
- postgres 공식 이미지가 0444 비밀 파일을 `POSTGRES_PASSWORD_FILE`로 읽었다. 같은 파일로 `migrate`와 `app`이 접속했다.
- `backup` 서비스가 종료 코드 0으로 끝났다.

확인하지 않은 것:

- 통신형(`_REF`) 어댑터를 쓰는 구성. 어댑터 패키지를 설치한 사용자 이미지에서 패키지가 해석되는지도 확인하지 않았다.
- SQLite 조합에서 `compose.secrets.yml`을 쓴 기동.
- `/etc/storix/secrets` 생성과 `sudo install`·`tee`·`chmod` 절차. 이 절차는 실행하지 않았다. L3는 임시 디렉터리로 실행했다.

## 개발과 운영의 차이

| 항목                         | 개발                          | 운영                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 토폴로지                     | 같다                          | 같다                                                                                                                                                                                                                         |
| DB                           | SQLite 또는 Postgres          | 규모에 맞게 선택한다. 백업 형식은 서로 호환되지 않는다.                                                                                                                                                                      |
| `STORIX_VERSITYGW_DATA_PATH` | 비워 두면 named volume을 쓴다 | 디스크 암호화를 적용한 마운트 경로                                                                                                                                                                                           |
| 비밀값                       | 약한 값 허용                  | 무작위 값. 대상은 SQLite 조합 2개(`STORIX_API_KEY`, `STORIX_ENCRYPTION_MASTER_KEY`)와 Postgres 조합 3개(DB 비밀번호 포함)이며 `/etc/storix/secrets` 파일(0444, 디렉터리 0700)로 둔다. 나머지는 `/etc/storix/storix.env` 0600 |
| 백업                         | 호스트 안에 둬도 된다         | 호스트 밖으로 보낸다                                                                                                                                                                                                         |

## 데이터 보호

### `ENCRYPTED` namespace

- 암호화 코드는 파일 콘텐츠 경로(`content.service.ts` 등)에서만 쓰인다.
- 파일명·경로 등 DB 메타데이터를 암호화하는 코드는 찾지 못했다.
- 파일명에 개인정보가 들어갈 수 있으면 디스크 암호화로 보완한다.
- AES-256-CTR은 무결성 태그가 없다. 변조를 탐지하지 못한다(api ADR-0009).
- 마스터 키를 잃으면 복호화할 수 없다. 키 로테이션은 지원하지 않는다.
- 마스터 키는 데이터 볼륨·백업과 다른 위치에 별도로 보관한다.

### 백업

- 이 구성은 호스트 디스크 하나가 단일 장애 지점이다.
- `backup` 서비스는 `default`(internal) network에 있어 외부로 직접 보낼 수 없다.
- `./backups`를 호스트의 별도 작업이 암호화해 호스트 밖으로 전송한다.
- `PLAIN` namespace의 blob은 백업에도 평문이다.
- 절차는 [백업/복구 운영 절차](../../backup-restore.md)를 따른다.

## 검증

Storix 이미지로 WAS 역할의 컨테이너를 `storix-front`에만 붙여 확인한다. WAS 쪽 compose에는 `edge`가 추가로 있다.

호스트에서 게시된 포트가 없어야 한다. 출력이 없어야 한다.

```bash
ss -ltn | grep -E ':3000|:7070|:5432'
```

`storix-front`의 컨테이너에서 Storix가 보여야 한다.

```bash
docker run --rm --network storix-front --entrypoint node <storix 이미지> \
  -e "fetch('http://storix:3000/health/ready').then(r => console.log(r.status))"
```

- 기대 출력은 `200`이다.
- `/health/ready`는 DB와 VersityGW 연결까지 확인한다.

같은 컨테이너에서 백엔드가 보이지 않아야 한다.

```bash
docker run --rm --network storix-front --entrypoint node <storix 이미지> \
  -e "require('dns/promises').lookup('versitygw').catch(e => console.log(e.code))"
```

기대 출력은 `EAI_AGAIN`이다. `postgres`도 같다.

### 확인한 범위

- 환경: Docker Compose v5.5.1, Storix 이미지 `storix-api:cand-alpine`(Alpine 런타임).
- SQLite 조합과 Postgres 조합을 각각 기동했다. `app`이 `healthy`이고 `migrate`와 `versitygw-init`이 종료 코드 0이다.
- `storix-front`의 컨테이너에서 다음을 확인했다.
  - `/health/live`가 200이다.
  - API key 없이 `/api/v2/namespaces`를 부르면 401이다.
  - 올바른 API key로 부르면 200이다.
  - `versitygw`와 `postgres`는 DNS가 풀리지 않는다.
  - VersityGW와 `app`의 `default` network IP로 TCP 연결하면 `ENETUNREACH`다.
  - 외부(`https://1.1.1.1`) 송신이 `ENETUNREACH`다.
- 호스트의 3000·7070·5432는 listen하지 않는다. `127.0.0.1:3000` 접근은 실패한다.
- `compose.private-postgres.yml` 없이 Postgres 조합을 `config`로 렌더링하면 `127.0.0.1:5432`가 게시된다. 이 파일이 필요한 이유다.

확인하지 않은 것:

- `!reset` 태그는 Compose v5.5.1에서만 확인했다. 구버전과 podman-compose는 확인하지 않았다.
- `ENCRYPTED` namespace 업로드·다운로드는 이 시나리오 구성에서 실행하지 않았다.
- WAS 쪽 `edge` network와 Nginx 구성은 구성하지 않았다.
- 호스트 방화벽 규칙과 디스크 암호화는 구성하지 않았다.

## 알려진 제약

- Storix 이미지는 root로 실행된다(`apps/api/Dockerfile`에 `USER`가 없다). `app`은 `cap_drop: [ALL]`로 실행하고, 그 밖의 서비스는 `NET_RAW`만 제거한다.
  - 잡(`backup`·`restore`)은 호스트 디렉터리에 쓰므로 `cap_drop: [ALL]`을 적용하지 않았다.
  - 비root 실행과 `read_only` 파일시스템은 적용하지 않았다. 검증하지 않았다.
- `NET_RAW` 제거는 같은 bridge의 침해 컨테이너가 ARP spoofing으로 트래픽을 가로채는 경로를 줄이기 위한 것이다. 일반적으로 알려진 경로이며 이 저장소에서 재현하지 않았다.
- API key는 배포 단위의 공유 키다. WAS가 침해되면 Storix API 전체가 열린다. 서비스별 신원 분리는 지원하지 않는다([서비스 간 신뢰 가이드](../../../guides/was-storix-service-trust.md)).
- `default`와 `storix-front`가 모두 internal이므로 `app`은 외부로 나가지 못한다. `STORIX_SENTRY_DSN`을 쓰면 오류 전송이 막힌다. Sentry가 필요하면 `storix-front`를 `--internal` 없이 만든다.
- 이 구성은 같은 호스트 안의 다른 프로세스(호스트에서 직접 실행하는 서비스)와의 경계를 만들지 않는다.

## 확장

- Storix를 별도 호스트로 옮기면 WAS의 호출 주소를 바꾸고 [내부 mTLS 시나리오](../co-located-nginx-mtls/README.md)로 옮긴다. API 계약은 바뀌지 않는다.
- VersityGW를 NAS로 옮기면 `STORIX_VERSITYGW_DATA_PATH`를 NAS 경로로 바꾼다. 다중 호스트 배치는 [ADR-0003](../../../adr/0003-versitygw-primary-backend-and-topology.md)을 따른다.
