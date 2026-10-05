# TRP-010 TypeORM save()는 같은 밀리초의 Date 변경을 변경 없음으로 보고 UPDATE를 생략한다

- 상태: ACTIVE
- 적용 조건: 엔티티의 Date 컬럼만 `new Date()`로 바꾼 뒤 `save()`의 변경 감지로 UPDATE·`@VersionColumn` 증가를 일으키는 코드를 쓸 때

## 오해하기 쉬운 신호

`save()`가 오류 없이 엔티티를 돌려준다.
요청 간격이 1ms 이상인 단건 테스트는 version 증가를 단언해도 통과한다.
연속 호출에서만 간헐적으로 version이 그대로다.

## 원인

- TypeORM은 `save()` 전에 로드한 값과 엔티티 값을 컬럼별로 비교하고, 바뀐 컬럼이 없으면 UPDATE를 보내지 않는다.
- Date 컬럼은 ms 단위로 비교한다. 직전 쓰기와 같은 ms의 `new Date()`는 변경 없음이다.
- UPDATE가 없으면 `@VersionColumn`도 오르지 않는다.
- 2026-10-05 touch(`touchFile` 기존 FILE 분기)가 이 방식으로 version을 올렸다. SQLite에서 연속 touch 300회 중 115~129회는 version이 그대로였다(GitHub 이슈 #40).

## 탐지/회피

- 탐지: `jest.useFakeTimers({ now, doNotFake: [Date 외 타이머] })`로 `Date`만 고정하고 같은 엔티티를 두 번 저장한다. version이 1만 올라야 한다.
- 회피: 내용 변경 없이 version을 올려야 하면 `save()` 대신 `version = version + 1`을 명시한 UPDATE를 쓴다. affected 수로 상한(`MAX_VFS_VERSION`)을 함께 확인한다.
- 해당하지 않는 경로: 실제 값이 바뀌는 `save()`(put의 `blobId`, persist의 `expiresAt`, setMimeType의 `mimeType`, mv의 `parentId`·`name`)는 diff가 항상 있다. 같은 경로 mv는 그 전에 409로 거부된다.
- 회귀 검증: `apps/api/test/persistence/vfs-change-feed.repository.shared-tests.ts`의 "같은 밀리초 안에 반복한 touch" 테스트(SQLite·PostgreSQL).
