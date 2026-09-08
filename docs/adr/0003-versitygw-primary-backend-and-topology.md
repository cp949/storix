# VersityGW가 목표 기본 스토리지 백엔드이며, 멀티 인스턴스 배포 형태는 NAS 유무로 갈린다

## 상태

승인됨 (2026-09-08) — 방향 확정, 구현은 아직 시작 전. 현재
`docker-compose.versity-demo.yml`은 이 방향으로 가는 준비 단계(단일 인스턴스
백엔드 스왑 증명)일 뿐이다.

## 배경

Storix는 개발 초기 편의상 MinIO로 시작했지만, 실사용처는 MinIO가 아니라
VersityGW를 스토리지 백엔드로 쓴다. 루트 `docker-compose.yml`(base)이 여전히
`app`/`gc`/`backup`/`restore`에 `STORAGE_ENDPOINT: minio`를 하드코딩된 기본값으로
두고 있어, 코드/설정만 보면 "MinIO가 기본이고 VersityGW/S3는 그 대안을
증명하는 데모"로 오독하기 쉽다 — 실제로 이 오독 때문에 세션 하나가 잘못된
설계 권고(`docker-compose.minio-demo.yml`로의 재구성 제안)를 낸 적이 있다.
방향은 정반대다: VersityGW가 목적지이고, MinIO/S3 지원은 이미 마련된
STORAGE_* 벤더중립 추상화(`apps/api/docs/adr/0012-minio-sdk-generic-s3-client.md`)
덕에 별도 작업 없이 따라오는 파생 결과일 뿐이다.

## 결정

1. 목표 기본 스토리지 백엔드는 VersityGW다. MinIO/S3 지원 유지 자체가 목표가
   아니라, STORAGE_* 추상화를 지키기만 하면 자동으로 계속 따라오는 부산물이다.
2. 여러 Storix WAS(API 서버) 인스턴스는 Postgres DB를 공유한다 — 인스턴스마다
   전용 DB를 새로 두지 않는다.
3. 스토리지 배치 형태는 기반 매체가 NAS인지 아닌지에 따라 갈린다:
   - **NAS 기반 posix 백엔드일 때**: 각 WAS에 VersityGW를 1:1 전용으로 붙인다.
     실제 데이터는 NAS라는 공유·내구성 계층에 있고 각 VersityGW 인스턴스는
     자기 WAS 전용 접근 지점일 뿐이므로, 인스턴스별 전용 배치가 안전하다.
   - **NAS가 아닌 스토리지(로컬/직결 디스크 등)일 때**: 데이터가 특정 호스트에
     고정되므로 인스턴스별 전용 배치가 불가능하다. VersityGW를 active/standby로
     운영해야 한다.

## Consequences

- 현재 `docker-compose.yml`은 스택 하나를 띄울 때마다 전용 `postgres` 컨테이너를
  새로 만드는 구조라, "N개 WAS가 1개 공유 DB를 바라보는" 이 토폴로지와 맞지
  않는다. 별도 배포 아키텍처 설계로 해소해야 한다(이 ADR의 스코프 밖 — 후속
  작업).
- NAS 기반 배치에서는 여러 VersityGW 인스턴스가 같은 NAS 마운트를 posix
  백엔드로 동시에 바라본다. VersityGW의 posix 백엔드 구현이 다중 프로세스의
  동시 파일시스템 접근(락킹 등)을 안전하게 처리하는지는 아직 검증되지 않았다.
- `docker-compose.versity-demo.yml`의 이름에 있는 "demo"는 VersityGW가
  부차적이라는 뜻이 아니라, 아직 HA를 구현하지 않은 단일 인스턴스 증명
  단계라는 뜻이다 — 이름만 보고 우선순위를 오판하지 않는다.
- active/standby 운영 방식, NAS 마운트 방식, 공유 DB로의 전환 같은 실제 구현은
  별도의 아키텍처 브레인스토밍/설계 문서로 이어간다.
