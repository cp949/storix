# Namespace 암호화 정책은 생성 시 고정한다

- Namespace 생성 시 파일 콘텐츠 암호화 정책(`NONE`, 향후 `ENCRYPTED`)을 지정한다.
- 생성 후에는 암호화 정책을 변경할 수 없다.
- 정책을 바꾸려면 새 Namespace를 만들고 데이터를 옮긴다.

## 결정 근거

- 기존 Blob의 암호화 상태를 바꾸는 마이그레이션 기능은 만들지 않는다.
- 암호화는 `BlobStorage`를 감싸는 `EncryptedBlobStorage` decorator로 구현할 계획이었다.
- 실제 구현 형태는 api ADR-0009에서 업로드 래퍼와 다운로드 헬퍼로 대체한다.
