import { DomainError } from '../common/domain-error.js';

export class InvalidApiKeyError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;

  constructor() {
    super('유효하지 않은 API 키');
  }
}
