import { DomainError } from '../common/domain-error.js';

export class RestoreTargetNotEmptyError extends DomainError {
  readonly code = 'RESTORE_TARGET_NOT_EMPTY';
  readonly status = 409;

  constructor() {
    super('복구 대상에 이미 namespace 데이터가 있음 — 덮어쓰려면 STORIX_RESTORE_FORCE=true를 설정하십시오');
  }
}
