# `openapi.yaml`을 1.0.0으로 확정하고 draft 표기를 제거한다

api ADR-0020은 `apps/demo` 실사용 검증이 끝날 때까지 초안 표기를 유지하도록 정했다.
대상은 `openapi.yaml`의 "초안 상태" 문구와 `info.version`의 `-draft` 접미사다.
검증 조건이 충족돼 1.0을 확정한다.
api ADR-0020은 수정하지 않고 이 ADR에 확정 결정을 기록한다.

## 결정

1. `info.version`을 `0.1.0-draft`에서 `1.0.0`으로 바꾼다.
2. `info.description`의 "초안 상태" 문단을 삭제한다.
3. 첫 릴리즈 태그는 `v1.0.0`이다.
   `info.version`은 태그의 버전 값과 일치한다(api ADR-0020).
4. 다음 작업은 사용자가 `docs/deployment/release.md` 절차로 직접 수행한다.
   - 태그 push.
   - `CHANGELOG.md`의 `[Unreleased]`를 `[1.0.0]`으로 정리.

   이 ADR의 변경에는 포함하지 않는다.

5. API 경로 prefix는 `/api/v2`를 유지한다.
   경로 버전과 release 태그 버전은 독립된 숫자 계열이다(api ADR-0020).

## 확정 근거

- demo1 실사용 검증:
  - 전체 스택 HTTP smoke 20단계를 통과했다.
  - Chromium에서 MIME 변경 UI와 presigned 다운로드 응답 헤더를 확인했다.
  - presigned 다운로드의 `Content-Type`이 변경된 MIME type을 반영하지 않는 결함을 고쳤다.
- 대용량 업로드 메모리(GitHub 이슈 #9):
  - demo1 WAS가 요청 본문을 요청 종료까지 보유하던 결함을 고쳤다.
  - 256 MiB 업로드의 RSS 피크는 396 MiB에서 200 MiB로 줄었다.
  - 64 MiB 업로드와 같은 수준이다.
  - 본문 보유 여부는 `storix-http.client.spec.ts`의 회귀 테스트로 판정한다.
  - smoke의 RSS는 정보성 기록이다.
- 공개 HTTP 계약:
  - `apps/contract`가 실제 서버에 실행한다(ADR-0029).

## 검토한 대안

- **`0.x` 유지**:
  - 0.x는 MINOR bump로 breaking change를 허용한다(ADR-0007).
  - 검증이 끝난 계약을 불안정하다고 표시할 근거가 없어 채택하지 않았다.
- **`v0.2.0` 등 다른 번호로 첫 태그 생성**:
  - `info.version`은 태그의 버전 값을 따른다.
  - 계약 확정 표기와 어긋나므로 채택하지 않았다.

## 결과

- 1.0 이후 breaking change는 `/api/v2`에서 `/api/v3`로 전체 교체한다(api ADR-0020).
  두 버전을 병행 노출하지 않는다.
- 확인하지 않은 범위:
  - Firefox·WebKit.
  - demo1의 이동·복사·공개 링크 브라우저 UI.

  이 범위의 결함은 1.0 이후 PATCH·MINOR 변경으로 고친다.
