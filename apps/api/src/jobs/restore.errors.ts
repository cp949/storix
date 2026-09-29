import { DomainError } from '../common/domain-error.js';

export class RestoreTargetNotEmptyError extends DomainError {
  readonly code = 'RESTORE_TARGET_NOT_EMPTY';
  readonly status = 409;

  constructor() {
    super('복구 대상에 이미 namespace 데이터가 있음 — 덮어쓰려면 STORIX_RESTORE_FORCE=true를 설정하십시오');
  }
}

export class RestoreUnsupportedBackupError extends DomainError {
  readonly code = 'RESTORE_UNSUPPORTED_BACKUP';
  readonly status = 422;

  constructor(unknownDirectories: readonly string[]) {
    super(
      `지원하지 않는 백업 구조 — object 미러 디렉터리는 'blobs/'뿐이며 알 수 없는 디렉터리가 있음: ${unknownDirectories.join(', ')}`,
    );
  }
}
