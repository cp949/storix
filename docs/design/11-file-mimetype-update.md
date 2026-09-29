# 조건부 mimeType 변경 (setMimeType)

bbcode `updateFileMetadata`(Content-Type 변경)는 전체 bytes를 재조회해 조건부
content PUT으로 다시 쓴다. 응답을 잃고 재시도하는 사이 다른 호출자가 bytes를
바꾸면 `MUTATION_KEY_REUSED`가 최초 결과를 재현하지 못한다. bytes를 건드리지
않고 FILE의 mimeType만 바꾸는 조건부 mutation `setMimeType`으로 이 경로를
없앤다.

## 데이터 모델

`vfs_node.mime_type`은 기존 nullable varchar(255) 컬럼을 그대로 쓴다. 스키마
변경이나 migration은 없다. DIRECTORY의 `mime_type`은 항상 NULL이며
`setMimeType`은 DIRECTORY를 대상으로 받을 수 없다(409 `VFS_IS_DIRECTORY`).

## 요청과 검증

`POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 body:

```json
{ "kind": "setMimeType", "path": "/a/b.bin", "ifRevision": "r1.…", "mimeType": "image/png" }
```

`Idempotency-Key`와 `X-Mutation-Scope`가 필요하고 `ifRevision` 누락은 428
`VFS_PRECONDITION_REQUIRED`다. 나머지 필드가 더 있거나(`recursive` 등) `path`가
루트(`/`)면 400 `VFS_INVALID_MUTATION_REQUEST`다.

`mimeType`은 `assertStrictMimeType`(`mime.ts`)으로 검증한다. 이 함수는 content
PUT 경로의 관대한 `normalizeMimeType`(검증 실패 시 `application/octet-stream`으로
조용히 대체)과 다르며, `upload-session-request.dto.ts`가 이미 쓰는 것과 같은
`MIME_PATTERN`(`type/subtype`, 대소문자 무관, 파라미터 불허)에 매칭하지 않으면
예외를 던진다. 세미콜론 파라미터(`; charset=...`)는 잘라내지 않고 그 자체로
거부한다: JSON 필드로 값을 받는 구조라 HTTP `Content-Type` 헤더 관례(파라미터
스트립)를 따를 이유가 없다. 통과하면 소문자로 정규화한다. 255자 초과도 거부한다.
검증과 정규화는 `parseConditionalMutation` 파싱 단계에서 수행하며 결과가 canonical
command에 반영되어 fingerprint 계산에 쓰인다. 검증 실패는 400
`VFS_INVALID_MUTATION_REQUEST`이며 다른 요청 형식 오류와 같은 receipt 규칙을
따른다: claim을 얻은 뒤 기록되므로 같은 key 재시도는 최초 status·body·
`X-Request-Id`를 재생하고, 유효한 값으로 같은 key를 재사용하면 409
`MUTATION_KEY_REUSED`다. 결정적 4xx만 재생 대상이며 재생 정책 전체는
`openapi.yaml`의 `/fs/mutations` 설명과 ADR-0024를 따른다.

## no-op 규칙

요청 mimeType(정규화 후)이 현재 저장값과 같으면 revision을 소모하지 않고 조상
체인도 bump하지 않는다. `persist`가 `target.expiresAt === null`(이미 확정)일 때
쓰는 no-op 관례와 같다. 응답은 200이고 `affectedRevisions`는 빈 배열이다.

## 파일 종류·revision 검사

`VfsNodeRepository.applyConditionalMutation`은 namespace root 잠금 아래
부모 체인과 대상을 잠근다. 순서는 다음과 같다.

1. 대상이 없으면 404 `VFS_NODE_NOT_FOUND`.
2. DIRECTORY면 409 `VFS_IS_DIRECTORY`(revision 검사보다 먼저).
3. `ifRevision`이 대상과 다르면 412 `VFS_PRECONDITION_FAILED`이고 `current`에
   충돌 시점 노드(현재 `mimeType` 포함)를 담는다.
4. mimeType이 현재 값과 같으면 no-op 200.
5. 다르면 `markAncestorChain`으로 조상 전부의 revision을 bump하고 대상의
   `mime_type`을 갱신·저장한다(`mkdir`/`delete`/`move`/`persist`와 같은 관례).
   성공 응답은 200과 대상+조상을 담은 `affectedRevisions`다.

성공 응답을 잃고 새 key로 재시도해 412를 받으면 `current.mimeType`이 이미
바뀐 값인지 확인해 완료 여부를 판정할 수 있다(`persist`의
`current.expiresAt === null` 판정과 같은 패턴).

## 만료 예정 파일과의 관계

`setMimeType`은 `expiresAt`을 읽지도 쓰지도 않는다. 만료 예정 FILE도 변경할
수 있고 만료는 그대로 유지된다(`docs/design/10-file-expiry.md`의 "다른 연산과
조회" 표). 확정(persist)과 mimeType 변경은 독립적인 관심사다.

GC 만료 삭제와는 같은 namespace root 잠금으로 직렬화되지만, `persist`와 달리
경합 결과가 순서에 좌우되지 않는다: `setMimeType`이 만료를 해제하지 않으므로
GC가 재검사 시점에 여전히 만료 상태를 보고 삭제를 진행한다.

- `setMimeType`이 먼저 커밋되면: mimeType 변경은 성공(200)하고, 이어서 GC가
  같은 FILE을 삭제한다.
- GC가 먼저 커밋되면: `setMimeType`은 대상을 찾지 못해 404 `VFS_NODE_NOT_FOUND`다.

즉 실행 순서와 무관하게 GC는 항상 만료 삭제에 성공한다. 만료 해제가 필요하면
호출자가 별도로 `persist`를 보내야 한다.

## fingerprint·재생 규칙

fingerprint는 파싱이 만든 canonical command(`{kind, path, segments, ifRevision, mimeType}`,
mimeType은 정규화 후 값)의 `JSON.stringify`와 raw JSON body SHA-256으로 계산한다
(`mutation.service.ts`). 같은 key로 값만 바꾸면 fingerprint가 달라 409
`MUTATION_KEY_REUSED`다. 결정적 4xx(400 형식 오류, 404, 409, 412, 428)는
receipt에 저장·재생하고, 5xx·401·진행 중 key(409 `MUTATION_IN_PROGRESS`)·
`MUTATION_KEY_REUSED`는 저장하지 않는다. 전체 재생 경계는 ADR-0024를 따른다.

## OpenAPI 참조

`openapi.yaml`의 `POST /api/v2/namespaces/{namespaceId}/fs/mutations`
`requestBody.content.application/json.schema.oneOf`에 `setMimeType` 분기가
있고, 같은 operation의 `description`에 `**setMimeType.**` 문단이 있다.
검증 정책의 결정과 대안은 `apps/api/docs/adr/0028-conditional-mimetype-strict-validation.md`
참고.
