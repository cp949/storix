# VersityGW가 목표 기본 스토리지 백엔드이며, 멀티 인스턴스 배포 형태는 NAS 유무로 갈린다

## 상태

승인됨 (2026-09-08) — 방향 확정, 구현은 아직 시작 전. 현재
`docker-compose.versity-demo.yml`은 이 방향으로 가는 준비 단계(단일 인스턴스
백엔드 스왑 증명)일 뿐이다.

## 배경

Storix의 스토리지 백엔드는 VersityGW다. 코드는 S3 API 호환 클라이언트 하나
(`STORAGE_*` 벤더중립 추상화, `apps/api/docs/adr/0012-s3-client-sdk.md`)로 VersityGW와
그 밖의 S3 호환 백엔드를 지원한다. 루트 `docker-compose.yml`(base)은 백엔드를
정하지 않고, 백엔드는 override 파일이 정한다.

## 결정

1. 목표 기본 스토리지 백엔드는 VersityGW다. 그 밖의 S3 호환 백엔드 지원은
   STORAGE_* 추상화를 지키기만 하면 자동으로 따라온다.
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
