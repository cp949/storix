import type { ProfileName } from '../define-contract.ts';

/** 프로필별로 서버 기동 env에 덧씌우는 값. `default`는 서버 기본값을 그대로 쓴다. */
export const PROFILE_ENV: Readonly<Record<ProfileName, Readonly<Record<string, string>>>> = {
  default: {},
  'change-feed': {},
  'resumable-upload': {},
  'change-feed-prefix': {},
  'resumable-upload-prefix': {},

  // 한도 초과 계약용. 전역 한도는 프로세스 시작 때 한 번 읽으므로 기동 설정으로 준다(docs/design/04).
  // 700바이트 파일은 모든 한도 안이고, snapshot을 만들면 사용량 1400, 새 경로로 복원하면 2100이라 논리 상한을 넘는다.
  'small-limits': {
    STORIX_MAX_FILE_SIZE_BYTES: '1200',
    STORIX_MAX_SNAPSHOT_BYTES: '800',
    STORIX_MAX_TOTAL_LOGICAL_BYTES: '2000',
    // 동기 삭제·복사가 한 번에 다루는 노드 수. 노드 여섯 개 이상의 트리가 상한을 넘는다.
    STORIX_MAX_SYNC_DELETE_NODES: '5',
    STORIX_MAX_SYNC_COPY_NODES: '5',
    // 휴지통이 namespace마다 보존하는 노드 수. 파일 세 개까지 보존하고 네 번째 삭제가 상한을 넘는다.
    STORIX_MAX_RETAINED_TRASH_NODES: '3',
  },
};

/**
 * 프로필이 전역과 사전 준비 namespace에 허용하는 선택 capability.
 * 시작 설정이 namespace ID를 요구하므로 러너가 namespace를 먼저 만들고 설정을 쓴 뒤 서버를 재시작한다.
 */
export const PROFILE_CAPABILITIES: Readonly<Partial<Record<ProfileName, readonly string[]>>> = {
  'change-feed': ['change-feed'],
  'change-feed-prefix': ['change-feed'],
  'resumable-upload': ['resumable-upload'],
  'resumable-upload-prefix': ['resumable-upload'],
};

/**
 * `resumable-upload`를 허용하는 프로필의 세션 정책. 시작 설정(`STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`)이 유한한 전역·namespace 정책을 요구한다.
 * 조각 크기를 4바이트로 줄여 짧은 본문으로도 여러 조각을 만든다. 활성 세션·임시 바이트 상한은 계약이 닿지 않을 만큼 넉넉하다.
 */
export const UPLOAD_SESSION_POLICY = {
  partSizeBytes: 4,
  maxStagedBytes: '1048576',
  maxActiveSessions: 100,
} as const;
