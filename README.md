# Storix

Storix는 호출 서버가 사용하는 독립 VFS(Virtual File System) 저장 서버다.
파일의 업무적 의미와 최종 사용자 인증·권한 판단은 호출 서버의 책임이며 Storix
도메인에 포함하지 않는다.

## 핵심 기능

### 파일시스템식 API

Storage key나 object ID가 아니라 경로(path) 기준으로 동작한다.

- `mkdir`, `touch`, `mv`, `cp`, `rmdir`, `rm` — 디렉터리/파일 조작
- `PUT`/`GET content`, `GET download` — 콘텐츠 업로드/다운로드(Range 지원)
- `ls`, `stat`, `exists`, `find` — 조회, cursor 기반 페이지네이션

전체 엔드포인트는 `api/v1/namespaces/:namespaceId/fs/*` 아래에 있다
(`src/vfs/fs.controller.ts`). 호출 서버가 로컬 파일시스템을 다루듯 Storix를
다룰 수 있게 하는 것이 설계 목표다.

### Blob-level Copy-on-Write

같은 namespace 안에서 `cp`는 파일 콘텐츠를 복사하지 않는다. 새 VFS Node가
원본과 같은 immutable Blob을 참조하며 `reference_count`만 증가시킨다.
대용량 파일이나 디렉터리 recursive copy가 MinIO I/O 없이 즉시 끝난다. 이후
어느 한쪽 Node에 내용을 쓰면 그 Node만 새 Blob으로 교체되고 다른 참조자는
영향받지 않는다. 참조 카운트가 0이 되면 grace period 이후 GC가 회수한다.

자세한 배경: `apps/api/docs/adr/0003-file-copy-blob-level-cow.md`,
`apps/api/docs/adr/0006-gc-zero-since-grace-period.md`.

## 문서

- 컨텍스트 목록: `CONTEXT-MAP.md`
- api 도메인 용어: `apps/api/CONTEXT.md`
- 시스템 전역 아키텍처 결정: `docs/adr/`, api 컨텍스트 결정: `apps/api/docs/adr/`
- 상용화 로드맵: `docs/ROADMAP.md`
