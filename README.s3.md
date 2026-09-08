# AWS S3 백엔드로 Storix 실행하기

S3는 관리형 서비스라 컨테이너로 띄울 대상이 없다. `docker-compose.s3.yml`은
`app`/`gc`/`backup`/`restore`의 엔드포인트 관련 값만 AWS용으로 고정하고,
자격증명·리전·버킷은 `.env`의 `STORIX_STORAGE_*`를 그대로 쓴다. 이 문서는 그 조합을
처음부터 끝까지 따라가는 절차다. 파일 배치 배경은
`docs/adr/0004-compose-file-layout.md`.

## 언제 쓰는가

- 오브젝트 스토리지를 직접 운영하지 않고 AWS에 맡길 때.
- AWS가 아닌 S3 호환 서비스(예: 다른 클라우드의 S3 호환 스토리지)는 이 override
  대신 base 단독 + `.env`의 `STORIX_STORAGE_ENDPOINT` 등으로 붙인다(아래 "AWS 외 S3
  호환 서비스").

## 사전 준비

compose가 대신 해주지 않는다.

1. **버킷 생성**. 리전을 정해 미리 만든다. Storix는 버킷을 만들지 않는다
   (자격증명에 버킷 생성 권한을 요구하지 않기 위해).
2. **IAM 사용자와 access key 발급**. 아래 정책을 그 버킷에 한정해 붙인다.
   Storix는 모든 업로드를 크기 미지정 스트림으로 보내 minio-js가 항상
   멀티파트 업로드 경로를 타므로, `GetObject`/`PutObject`/`DeleteObject`/
   `ListBucket`만으로는 업로드가 `AccessDenied`로 실패한다. 멀티파트 관련 3개
   액션이 추가로 필요하다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Bucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Sid": "Objects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

`YOUR-BUCKET`을 실제 버킷 이름으로 바꾼다. `backup`은 버킷 전체를 나열·읽고,
`restore`/`gc`는 오브젝트를 쓰고 지우므로 위 정책이 세 잡에도 그대로 충분하다.

3. (선택) **AWS CLI**. 아래 동작 확인에서 버킷 내용을 대조할 때만 쓴다.

## .env 설정

```bash
cp .env.example .env
```

이 조합에서 실제로 읽히는 값:

| 변수 | 값 | 비고 |
|---|---|---|
| `STORIX_API_KEY` | `openssl rand -hex 32` 출력 | 필수. 비어 있으면 compose가 즉시 실패 |
| `STORIX_STORAGE_REGION` | 버킷의 리전(예: `ap-northeast-2`) | 필수. 비우면 리전 자동 조회로 요청마다 추가 왕복 |
| `STORIX_STORAGE_ACCESS_KEY` / `STORIX_STORAGE_SECRET_KEY` | 위에서 발급한 IAM access key | 정적 키만 지원(IAM 역할·STS 세션 토큰 미지원) |
| `STORIX_STORAGE_BUCKET` | 미리 만든 버킷 이름 | |
| `STORIX_DB_HOST` / `STORIX_DB_PORT` / `STORIX_DB_USERNAME` / `STORIX_DB_PASSWORD` / `STORIX_DB_NAME` | 외부 Postgres 접속 정보 | `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽은 `postgres:5432`로 재정의 |

override가 덮어써서 무시되는 값: `STORIX_STORAGE_ENDPOINT` / `STORIX_STORAGE_PORT` /
`STORIX_STORAGE_USE_SSL` / `STORIX_STORAGE_PATH_STYLE`(`s3.amazonaws.com` / `443` / `true` /
`false`)과 `STORIX_STORAGE_PUBLIC_*`(내부와 같은 `s3.amazonaws.com:443`, S3는 애초에
외부에서 접근 가능한 주소라 내부/외부 구분이 필요 없다).

이 조합에는 `STORIX_STORAGE_ACCESS_KEY`/`STORIX_STORAGE_SECRET_KEY`를 root 자격증명으로 받는
`minio`/`versitygw` 컨테이너가 없으므로 AWS 시크릿이 다른 서비스로 흘러가지
않는다.

## 기동

개발(로컬 Postgres 컨테이너 포함):

```bash
docker compose -f docker-compose.yml -f docker-compose.s3.yml -f docker-compose.postgres.yml up -d --build
```

운영(외부 Postgres, `.env`의 `STORIX_DB_*` 사용):

```bash
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d --build
```

기동 순서: `migrate`(스키마) → `app`. 스토리지 컨테이너가 없어 다른 조합보다
짧다. 자격증명이 틀리면 compose는 통과하고 `app`이 부팅 헬스체크 또는 최초
요청에서 인증 실패로 드러난다(`docker compose ... logs app`).

매번 `-f`를 나열하지 않으려면 `.env`에 조합을 적는다(docker compose 전용,
podman-compose는 쉘에서 export):

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.s3.yml
```

Podman은 위 명령의 `docker compose`를 `podman-compose`로 바꾸면 된다.

### 리전 전용 엔드포인트가 필요할 때

`STORIX_STORAGE_ENDPOINT`는 `s3.amazonaws.com`으로 고정돼 있다. 리전에 따라
`PermanentRedirect`(301)가 나면 `docker-compose.s3.yml`을 복사해 `x-s3-env`의
`STORIX_STORAGE_ENDPOINT`와 `app`의 `STORIX_STORAGE_PUBLIC_ENDPOINT`를
`s3.<region>.amazonaws.com`으로 바꾸고 그 사본을 `-f`로 넘긴다.

### AWS 외 S3 호환 서비스

이 override는 AWS 전용 값을 고정한다. 다른 S3 호환 서비스는 base 단독으로
기동하고 `.env`에 그 서비스의 접속 정보를 넣는다:

```bash
STORIX_STORAGE_ENDPOINT=<서비스 엔드포인트 호스트>
STORIX_STORAGE_PORT=443
STORIX_STORAGE_USE_SSL=true
STORIX_STORAGE_PATH_STYLE=<서비스가 요구하는 값, 보통 true>
STORIX_STORAGE_REGION=<서비스가 요구하는 값>
STORIX_STORAGE_ACCESS_KEY=...
STORIX_STORAGE_SECRET_KEY=...
STORIX_STORAGE_BUCKET=...
STORIX_STORAGE_PUBLIC_ENDPOINT=<같은 호스트>
STORIX_STORAGE_PUBLIC_PORT=443
STORIX_STORAGE_PUBLIC_USE_SSL=true
```

```bash
docker compose up -d --build
```

## 동작 확인

```bash
STORIX_API_KEY=$(grep '^STORIX_API_KEY=' .env | cut -d= -f2-)
AUTH="Authorization: Bearer ${STORIX_API_KEY}"

# app 준비 대기
until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done

# namespace 생성 (Idempotency-Key 헤더 필수)
NS=$(curl -sf -X POST http://localhost:3000/api/v1/namespaces \
  -H "$AUTH" -H "Idempotency-Key: readme-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"readme-check","encryptionPolicy":"NONE"}' | jq -r '.id')

# 업로드 (parents=true: 중간 디렉터리 자동 생성)
curl -sf -X PUT "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt&parents=true" \
  -H "$AUTH" -H 'Content-Type: text/plain' --data-binary 'hello s3'

# 다운로드
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt" -H "$AUTH"

# 디렉터리 목록
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/ls?path=docs" -H "$AUTH"

# presigned download — S3는 공개 주소라 추가 설정 없이 바로 동작한다
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/presigned-download?path=docs/hello.txt" \
  -H "$AUTH" | jq -r '.url' | xargs curl -sf
```

버킷 안의 실제 오브젝트 확인(AWS CLI):

```bash
aws s3 ls "s3://$(grep '^STORIX_STORAGE_BUCKET=' .env | cut -d= -f2-)" --recursive
```

Storix는 파일 경로가 아니라 생성된 storage key로 오브젝트를 저장하므로
`docs/hello.txt`라는 이름은 버킷에 보이지 않는다. 경로 ↔ 오브젝트 매핑은
Postgres(metadata)에 있다.

## 운영 잡

배포에 쓴 것과 같은 `-f` 조합에 profile을 더한다. 절차와 주의사항은
`docs/deployment/backup-restore.md`.

```bash
C="-f docker-compose.yml -f docker-compose.s3.yml"   # 개발이면 -f docker-compose.postgres.yml 추가

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

`backup`은 버킷 전체를 로컬 `./backups`로 미러하므로 버킷 크기만큼 S3 egress
비용과 시간이 든다.

## 특이사항·문제 해결

- **업로드가 `AccessDenied`**: IAM 정책에 멀티파트 액션 3개
  (`s3:ListBucketMultipartUploads`, `s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts`)가 빠졌는지 확인한다. 작은 파일도 예외가 아니다.
- **`PermanentRedirect`(301)**: 위 "리전 전용 엔드포인트가 필요할 때".
- **정적 키만 지원**: EC2 인스턴스 프로파일·IAM 역할·STS 세션 토큰은 쓸 수
  없다. `MinioBlobStorage`가 minio SDK Client를 그대로 쓰기 때문이다
  (`apps/api/docs/adr/0012-minio-sdk-generic-s3-client.md`).
- **presigned URL 만료**: `STORIX_PRESIGNED_URL_EXPIRY_SECONDS` 상한은 SigV4 제한인
  604800초(7일)다. 초과하면 `app`이 부팅 시 종료된다.
- **로그**: `docker compose $C logs -f app`.
- **데이터 초기화**: `docker compose $C down -v`는 로컬 Postgres 볼륨만 지운다.
  버킷의 오브젝트는 남으므로 필요하면 AWS 쪽에서 직접 비운다.

  ```txt
  위험도: 높음
  롤백: 불가능 — postgres-data(개발 조합)가 삭제된다. 버킷은 그대로 남아
  metadata 없는 orphan object가 되며, 새 인스턴스의 gc 대상이 아니다.
  ```
