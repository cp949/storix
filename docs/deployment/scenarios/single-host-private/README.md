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

## 개발과 운영의 차이

| 항목                         | 개발                          | 운영                                                    |
| ---------------------------- | ----------------------------- | ------------------------------------------------------- |
| 토폴로지                     | 같다                          | 같다                                                    |
| DB                           | SQLite 또는 Postgres          | 규모에 맞게 선택한다. 백업 형식은 서로 호환되지 않는다. |
| `STORIX_VERSITYGW_DATA_PATH` | 비워 두면 named volume을 쓴다 | 디스크 암호화를 적용한 마운트 경로                      |
| 비밀값                       | 약한 값 허용                  | 무작위 값, `/etc/storix/storix.env` 0600                |
| 백업                         | 호스트 안에 둬도 된다         | 호스트 밖으로 보낸다                                    |

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
