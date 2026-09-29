import type { ProfileName } from '../define-contract.ts';

/** 프로필별로 서버 기동 env에 덧씌우는 값. `default`는 서버 기본값을 그대로 쓴다. */
export const PROFILE_ENV: Readonly<Record<ProfileName, Readonly<Record<string, string>>>> = {
  default: {},

  // 한도 초과 계약용. 전역 한도는 프로세스 시작 때 한 번 읽으므로 기동 설정으로 준다(docs/design/04).
  // 700바이트 파일은 모든 한도 안이고, snapshot을 만들면 사용량 1400, 새 경로로 복원하면 2100이라 논리 상한을 넘는다.
  'small-limits': {
    STORIX_MAX_FILE_SIZE_BYTES: '1200',
    STORIX_MAX_SNAPSHOT_BYTES: '800',
    STORIX_MAX_TOTAL_LOGICAL_BYTES: '2000',
    // 동기 삭제·복사가 한 번에 다루는 노드 수. 노드 여섯 개 이상의 트리가 상한을 넘는다.
    STORIX_MAX_SYNC_DELETE_NODES: '5',
    STORIX_MAX_SYNC_COPY_NODES: '5',
  },
};
