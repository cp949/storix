# 같은 namespace 내 file 복사는 Blob-level copy-on-write다

- `cp`는 스토리지 object copy나 content streaming을 하지 않는다.
- 새 `VfsNode`는 source와 같은 immutable Blob을 참조한다.
- 복사 시 Blob의 `reference_count`를 늘린다.
- 어느 한 Node를 write하면 그 Node의 참조만 새 Blob으로 교체한다.
- 원본 Blob과 다른 Node의 참조는 유지한다.

## 결정 근거

- 대용량 파일과 디렉터리 recursive copy의 스토리지 I/O와 소요 시간을 줄인다.
- 공유 Blob을 회수하려면 참조 카운팅과 GC grace period가 필요하다.
