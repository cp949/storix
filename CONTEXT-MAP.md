# Context Map

Storix는 모노레포 전환(2026-09) 이후 multi-context 구조를 따른다. 컨텍스트별
`CONTEXT.md`는 각 앱 아래에 있다.

| Context | 위치 | 설명 |
| --- | --- | --- |
| api | [`apps/api/CONTEXT.md`](apps/api/CONTEXT.md) | Namespace/VFS Node/Blob 등 Storix 핵심 도메인 (NestJS 서버) |

`admin`, `demo`는 아직 고유 도메인 용어가 없어 `CONTEXT.md`를 두지 않는다(용어가
생기면 `/domain-modeling`으로 추가).

시스템 전역 아키텍처 결정(모노레포 전환 등)은 `docs/adr/`에, api 컨텍스트
결정(Namespace/VFS/Blob 관련)은 `apps/api/docs/adr/`에 있다.
