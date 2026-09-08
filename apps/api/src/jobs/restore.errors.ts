export class RestoreTargetNotEmptyError extends Error {
  readonly code = 'RESTORE_TARGET_NOT_EMPTY';

  constructor() {
    super('복구 대상에 이미 namespace 데이터가 있음 — 덮어쓰려면 STORIX_RESTORE_FORCE=true를 설정하십시오');
  }
}
