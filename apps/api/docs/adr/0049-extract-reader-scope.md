# extract는 직접 작성한 tar·zip reader를 쓴다

## 상태

승인됨 (2026-10-19). 압축 FILE 해제는 외부 압축 라이브러리 없이 `node:zlib`와 직접 작성한 reader를 쓴다.

## 배경

extract는 같은 namespace의 압축 FILE을 읽어 대상 트리에 원자적으로 반영한다. 요구 사항은 다음과 같다.

- 원본은 Blob이므로 ZIP은 range read로 임의 접근해야 한다. 암호화 namespace에서도 비블록 경계 range가 평문으로 풀려야 한다.
- 모든 GET·해제·PUT은 취소와 deadline에서 닫히고 닫힘을 기다려야 한다.
- 이름·종류·크기·압축비 검증과 오류 index 규칙이 reader와 맞물린다.

ADR-0048은 ZIP writer로 외부 라이브러리를 쓰지 않기로 했다.

## 결정

- 지원 형식은 zip(STORED·DEFLATE, ZIP32), tar(ustar·PAX·GNU longname), tar.gz다. 새 의존성을 추가하지 않는다.
- tar reader와 ZIP reader를 직접 작성한다. 각 reader는 source stream의 소유권을 갖고 어떤 종료 경로에서도 destroy하고 close를 기다린다.
- 지원하지 않는 형식은 거부한다: bzip2, 7z, xz, zip64, 암호화 ZIP, 다중 볼륨, V7 tar, tar의 link·장치·FIFO·sparse, symlink 속성의 ZIP entry.
- 실제 도구 호환은 Python `tarfile`·`zipfile` 산출물을 읽는 테스트로 고정한다.
- 원본 pin을 만들지 않는다. extract는 archive와 같은 grace 전제를 쓴다(ADR-0048). 원본 소실·storage 오류·DB 장애·commit 응답 유실은 5xx이며 성공으로 해석하지 않는다. 올린 object는 확정 4xx일 때만 즉시 지운다.

## 대안

외부 reader 라이브러리는 평가하지 않았다. 의존성 추가는 별도 승인 대상이고 위 요구 사항(range read, 암호화 range, 취소 수명, 오류 index)을 어댑터로 다시 감싸야 할 가능성이 있다. 직접 reader가 실제 도구 산출물 호환에 실패하면 어댑터 전환을 재검토한다.

영속 read hold는 ADR-0048과 같은 이유로 채택하지 않는다.
