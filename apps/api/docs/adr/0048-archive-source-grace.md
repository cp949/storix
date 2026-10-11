# archive 원본 보호에 GC grace를 사용한다

## 상태

채택. Archive는 grace 기반 원본 보호를 사용한다.

## 배경

Archive는 capture 뒤 원본 Blob을 읽고 별도 ZIP Blob을 만든다. 원본 참조 수를 유지하는 영속 lock은 설계 범위에 없다. API·GC 시계와 DB transaction 지연 상한을 함께 증명한 운영 근거도 없다.

## 결정

- API는 `STORIX_ARCHIVE_MAX_SECONDS + 60 <= STORIX_ORPHAN_GRACE_PERIOD`를 시작 시 검사한다.
- 60초는 DB·GC 시계 차이와 정리 지연을 덮는다고 가정한 여유다.
- 모든 API·GC 실행에 같은 grace를 설정한다.
- 진행 중 archive가 있을 때 grace를 줄이지 않는다.
- 이 검사는 source 보존을 보장하지 않는다. 긴 삭제 transaction과 GC host clock 차이는 제한하지 않는다.
- 엄격한 보존 요구가 있으면 삭제 지연 예산을 검증하거나 read hold를 재검토한다.

## 대안

영속 read hold는 source 참조·정리·crash recovery·GC 상호 배제 상태를 추가한다. 필요한 보존 수준이 입증되지 않아 현재 채택하지 않는다.

ZIP 직접 writer는 고정한 포맷 범위와 외부 reader 검증을 갖는다. 별도 ZIP 라이브러리를 제품 dependency에 추가하지 않는다. Zip64 지원은 제외한다.
