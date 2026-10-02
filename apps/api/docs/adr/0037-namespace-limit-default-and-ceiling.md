# Namespace 제한은 default와 hard ceiling을 분리한다

## 상태

승인됨 (2026-10-02)

## 결정

- 다음 제한은 전역 default와 전역 hard ceiling을 갖는다.
  - quota.
  - 파일 크기.
  - 폴더별 FILE 수.
  - live node 수.
- namespace override가 null이면 default를 상속한다.
- 지정한 override는 ceiling 이하여야 한다.
- 다음 수치는 transaction delta counter로 유지한다.
  - 폴더의 직접 FILE 수.
  - root를 제외한 live node 수.
- 운영 제한 판정에서 전체 COUNT를 수행하지 않는다.
- 기존 quota·파일 크기 env 값은 ceiling으로 유지한다.
- 신규 제한의 default:
  - 폴더별 FILE 수: 10000.
  - live node 수: 1000000.

## 대안

- **전역값 하나만 유지**: namespace별 사용량 등급을 지원할 수 없다.
- **요청마다 COUNT**:
  - 폴더·namespace 크기에 따라 비용이 증가한다.
  - mutation lock 경합 시간이 늘어난다.
- **전역 ceiling을 넘는 override 허용**: 배포 인스턴스의 절대 자원 한도를 보장할 수 없다.

## 결과

- Counter backfill이 필요하다.
- 모든 mutation·GC 경로에서 delta를 정산해야 한다.
- Counter와 실제 행이 다르면 제한을 잘못 판정한다.
- SQLite와 PostgreSQL의 통합 검증을 유지한다.
