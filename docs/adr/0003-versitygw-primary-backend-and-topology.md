# VersityGW가 목표 기본 스토리지 백엔드이며, 멀티 인스턴스 배포 형태는 NAS 유무로 갈린다

## 상태

승인됨 (2026-09-08)

- 배포 방향 확정.
- 결정 시점에는 구현 미착수.
- 당시 `docker-compose.versity-demo.yml`은 단일 인스턴스의 백엔드 교체를 검증하는 준비 단계다.

## 배경

Storix의 스토리지 백엔드는 VersityGW다.
S3 API 호환 클라이언트 하나로 VersityGW와 다른 S3 호환 백엔드를 지원한다.
벤더 중립 추상화는 `STORAGE_*`이며, 근거는 api ADR-0012다.

루트 `docker-compose.yml`(base)은 백엔드를 정하지 않는다. 백엔드는 override 파일에서 정한다.

## 결정

1. 목표 기본 스토리지 백엔드는 VersityGW다.
   - 다른 S3 호환 백엔드도 `STORAGE_*` 추상화로 지원한다.
2. 여러 Storix WAS(API 서버) 인스턴스는 Postgres DB를 공유한다.
   - 인스턴스마다 전용 DB를 만들지 않는다.
3. 스토리지 배치는 NAS 유무에 따라 나눈다.
   - **NAS 기반 posix 백엔드**: 각 WAS에 VersityGW를 1:1로 배치한다.
     - 실제 데이터는 공유·내구성 계층인 NAS에 둔다.
     - 각 VersityGW는 자기 WAS의 전용 접근 지점이다.
     - 이 역할 분리를 근거로 인스턴스별 전용 배치를 선택한다.
   - **NAS가 아닌 스토리지(로컬·직결 디스크 등)**: VersityGW를 active/standby로 운영한다.
     - 데이터가 특정 호스트에 고정된다.
     - 인스턴스별 전용 배치를 할 수 없다.

## Consequences

- 결정 시점의 `docker-compose.yml`은 스택마다 전용 `postgres` 컨테이너를 만든다.
  - N개 WAS가 DB 하나를 공유하는 토폴로지와 맞지 않는다.
  - 별도 배포 아키텍처 설계에서 해결한다.
- NAS 배치에서는 여러 VersityGW가 같은 NAS 마운트를 posix 백엔드로 사용한다.
  - posix 백엔드의 다중 프로세스 동시 접근 안전성은 검증하지 않았다.
  - 파일시스템 락킹 등이 검증 대상이다.
- `docker-compose.versity-demo.yml`의 `demo`는 HA 미구현 상태의 단일 인스턴스 검증을 뜻한다.
  - VersityGW의 우선순위가 낮다는 뜻은 아니다.
- 다음 구현은 별도 아키텍처 브레인스토밍·설계에서 다룬다.
  - active/standby 운영.
  - NAS 마운트.
  - 공유 DB 전환.
