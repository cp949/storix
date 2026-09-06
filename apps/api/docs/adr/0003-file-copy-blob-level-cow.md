# 같은 namespace 내 file 복사는 Blob-level copy-on-write다

`cp`는 MinIO object copy나 content streaming을 하지 않는다. 새 VfsNode가 source와
같은 immutable Blob을 참조하며 `reference_count`만 늘린다. 대용량 파일이나 디렉터리
recursive copy에서 MinIO I/O와 시간을 절약하기 위한 선택이며, 그 대가로 Blob에 참조
카운팅과 GC grace period를 도입해야 했다. 이후 어느 한 Node를 write하면 그 Node만
새 Blob으로 교체하고 원본 Blob과 다른 참조자는 그대로 둔다.
