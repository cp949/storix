# Namespace 제한은 default와 hard ceiling을 분리한다

## 상태

승인됨 (2026-10-02)

## 결정

- quota·파일 크기·폴더별 FILE 수·live node 수는 전역 default와 전역 hard ceiling을 가진다.
- nullable namespace override의 null은 default 상속이다. 지정한 override는 ceiling 이하여야 한다.
- 폴더 직접 FILE 수와 root 제외 live node 수는 transaction delta counter로 유지한다. 운영 제한 판정에서 전체 COUNT를 수행하지 않는다.
- 기존 quota·파일 크기 env 값을 ceiling으로 유지한다. 신규 제한의 default는 폴더 10000, live node 1000000이다.

## 대안

- 전역값 하나만 유지하면 namespace별 사용량 등급을 지원할 수 없다.
- 요청마다 COUNT하면 폴더·namespace 크기에 따라 비용이 증가하고 mutation lock의 경합 시간이 커진다.
- override가 전역 ceiling을 넘게 허용하면 배포 인스턴스의 절대 자원 한도를 보장할 수 없다.

## 결과

Counter backfill과 모든 mutation·GC 경로의 delta 정산이 필요하다. Counter와 실제 행 불일치는 제한 오판으로 이어지므로 양 DB 통합 검증을 유지한다.
