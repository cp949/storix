# Namespace 암호화 정책은 생성 시 고정한다

Namespace는 생성 시점에 파일 콘텐츠 암호화 정책(`NONE`, 향후 `ENCRYPTED`)을 지정하고
이후 변경할 수 없다. 암호화는 `BlobStorage` 뒤에 `EncryptedBlobStorage` decorator를
끼워 넣는 방식으로 구현할 예정인데, 기존 Blob을 다른 암호화 상태로 재작성하는
마이그레이션 기능은 만들지 않기로 했기 때문이다. 암호화 정책을 바꾸려면 새
Namespace를 만들고 데이터를 옮겨야 한다.
