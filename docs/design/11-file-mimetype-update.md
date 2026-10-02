# 조건부 mimeType 변경 (setMimeType)

`setMimeType`은 FILE의 mimeType만 바꾸는 조건부 mutation이다.
파일 bytes를 다시 전송하지 않고 metadata를 변경한다.
본문을 재조회해 업로드하는 방식은 재시도 사이의 bytes 변경에 영향을 받는다.

## 데이터 모델

- `vfs_node.mime_type`은 기존 nullable varchar(255) 컬럼을 그대로 쓴다.
- 스키마 변경이나 migration은 없다.
- DIRECTORY의 `mime_type`은 항상 NULL이며 `setMimeType`은 DIRECTORY를 대상으로 받을 수 없다(409 `VFS_IS_DIRECTORY`).

## 요청과 검증

`POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 body:

```json
{
  "kind": "setMimeType",
  "path": "/a/b.bin",
  "ifRevision": "r1.…",
  "mimeType": "image/png"
}
```

`Idempotency-Key`와 `X-Mutation-Scope`가 필요하고 `ifRevision` 누락은 428 `VFS_PRECONDITION_REQUIRED`다. 나머지 필드가 더 있거나(`recursive` 등) `path`가 루트(`/`)면 400 `VFS_INVALID_MUTATION_REQUEST`다.

`assertStrictMimeType`(`mime.ts`)이 `mimeType`을 검증한다.

- `MIME_PATTERN`은 `type/subtype` 형식만 허용한다.
- 대소문자는 구별하지 않고 통과한 값을 소문자로 정규화한다.
- 세미콜론 파라미터(`; charset=...`)와 255자 초과 값은 거부한다.
- JSON 필드는 HTTP `Content-Type` 헤더처럼 파라미터를 제거하지 않는다.
- content PUT의 `normalizeMimeType`은 검증 실패 시 `application/octet-stream`을 쓴다.
- `assertStrictMimeType`은 검증 실패 시 오류를 던진다.
- `upload-session-request.dto.ts`도 같은 형식을 검증한다.

`parseConditionalMutation`은 검증·정규화 결과를 canonical command에 넣는다.
fingerprint는 이 command를 사용한다.

검증 실패와 재시도:

- 검증 실패는 400 `VFS_INVALID_MUTATION_REQUEST`다.
- claim을 얻으면 다른 요청 형식 오류와 같은 규칙으로 receipt를 저장한다.
- 같은 key·fingerprint는 최초 status·body·`X-Request-Id`를 재생한다.
- 유효한 값으로 같은 key를 재사용하면 409 `MUTATION_KEY_REUSED`다.
- 전체 재생 정책은 `openapi.yaml`의 `/fs/mutations` 설명과 api ADR-0024를 따른다.

## no-op 규칙

- 요청 mimeType(정규화 후)이 현재 저장값과 같으면 revision을 소모하지 않고 조상 체인도 bump하지 않는다.
- `persist`가 `target.expiresAt === null`(이미 확정)일 때 쓰는 no-op 관례와 같다.
- 응답은 200이고 `affectedRevisions`는 빈 배열이다.

## 파일 종류·revision 검사

`VfsNodeRepository.applyConditionalMutation`은 namespace root 잠금 아래 부모 체인과 대상을 잠근다. 순서는 다음과 같다.

1. 대상이 없으면 404 `VFS_NODE_NOT_FOUND`.
2. DIRECTORY면 409 `VFS_IS_DIRECTORY`(revision 검사보다 먼저).
3. `ifRevision`이 대상과 다르면 412 `VFS_PRECONDITION_FAILED`이고 `current`에 충돌 시점 노드(현재 `mimeType` 포함)를 담는다.
4. mimeType이 현재 값과 같으면 no-op 200.
5. 다르면 `markAncestorChain`으로 조상 전부의 revision을 bump하고 대상의 `mime_type`을 갱신·저장한다(`mkdir`/`delete`/`move`/`persist`와 같은 관례). 성공 응답은 200과 대상+조상을 담은 `affectedRevisions`다.

성공 응답을 잃고 새 key로 재시도해 412를 받으면 `current.mimeType`이 이미 바뀐 값인지 확인해 완료 여부를 판정할 수 있다(`persist`의 `current.expiresAt === null` 판정과 같은 패턴).

## 만료 예정 파일과의 관계

`setMimeType`은 `expiresAt`을 변경하지 않는다. 만료 예정 FILE도 변경할 수 있고 만료는 그대로 유지된다(`docs/design/10-file-expiry.md`의 "다른 연산과 조회" 표). 확정(persist)과 mimeType 변경은 독립적인 관심사다.

- GC 만료 삭제와 `setMimeType`은 같은 namespace root 잠금으로 직렬화한다.
- `setMimeType`은 만료를 해제하지 않는다.
- GC는 재검사 시점에도 만료된 FILE을 삭제 대상으로 판단한다.

- `setMimeType`이 먼저 커밋되면: mimeType 변경은 성공(200)하고, 이어서 GC가 같은 FILE을 삭제한다.
- GC가 먼저 커밋되면: `setMimeType`은 대상을 찾지 못해 404 `VFS_NODE_NOT_FOUND`다.

두 연산의 실행 순서는 만료 삭제 대상 여부를 바꾸지 않는다. 만료 해제가 필요하면 호출자가 별도로 `persist`를 보내야 한다.

## fingerprint·재생 규칙

- fingerprint는 파싱이 만든 canonical command(`{kind, path, segments, ifRevision, mimeType}`, mimeType은 정규화 후 값)의 `JSON.stringify`와 raw JSON body SHA-256으로 계산한다 (`mutation.service.ts`). 같은 key로 값만 바꾸면 fingerprint가 달라 409 `MUTATION_KEY_REUSED`다.
- 결정적 4xx(400 형식 오류, 404, 409, 412, 428)는 receipt에 저장·재생하고, 5xx·401·진행 중 key(409 `MUTATION_IN_PROGRESS`)· `MUTATION_KEY_REUSED`는 저장하지 않는다.
- 전체 재생 경계는 ADR-0024를 따른다.

## OpenAPI 참조

- `openapi.yaml`의 `POST /api/v2/namespaces/{namespaceId}/fs/mutations`에 `setMimeType`을 정의한다.
- 요청 schema 위치는 `requestBody.content.application/json.schema.oneOf`다.
- 같은 operation의 `description`에 `**setMimeType.**` 설명이 있다.
- 검증 정책의 결정과 대안은 api ADR-0028(`apps/api/docs/adr/0028-conditional-mimetype-strict-validation.md`)을 따른다.
