# Storix

Storix는 호출 서버가 사용하는 독립 VFS(Virtual File System) 저장 서버다. 파일의
업무적 의미와 최종 사용자 인증·권한 판단은 호출 서버의 책임이며 Storix 도메인에
포함하지 않는다.

## Language

**Namespace**:
Storix가 관리하는 최상위 VFS 격리 단위로, 하나의 VFS root·파일명 범위·생성 시
고정되는 암호화 정책을 소유한다. 불변 `id`(UUID)로 식별하며, 사람이 정하는 `name`은
식별자가 아닌 재사용 가능한 자동화용 slug다.
_Avoid_: 테넌트, 버킷, 워크스페이스

**VFS Node**:
Namespace 안에서 파일 또는 디렉터리 하나를 가리키는 단위로, FILE과 DIRECTORY 두
종류가 있다. 위치는 parent-child 관계로 표현하고 사용자가 보는 경로 문자열은
식별자가 아니며, FILE Node만 Blob을 참조해 콘텐츠를 가리킨다.
_Avoid_: 엔트리, 아이템

**Blob**:
FILE Node의 콘텐츠를 담는 불변 저장 단위로, 사용자 파일명과 무관한 UUID 기반
storage key로 저장된다. 여러 FILE Node가 같은 Blob을 공유해 참조할 수 있으며,
참조가 모두 사라지면 회수 대상이 된다.
_Avoid_: 파일 콘텐츠, 오브젝트
