import { DomainError } from '../common/domain-error.js';

export class NamespaceEncryptionNotConfiguredError extends DomainError {
  readonly code = 'NAMESPACE_ENCRYPTION_NOT_CONFIGURED';
  readonly status = 400;

  constructor() {
    super('STORIX_ENCRYPTION_MASTER_KEY가 설정되지 않아 ENCRYPTED namespace를 생성할 수 없음');
  }
}
