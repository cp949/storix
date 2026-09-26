import { DomainError } from './domain-error.js';

export class StorageUnavailableError extends DomainError {
  readonly code = 'STORAGE_UNAVAILABLE';
  readonly status = 503;

  constructor(message = 'Storage temporarily unavailable', options?: ErrorOptions) {
    super(message, options);
  }
}

export class StorageFailureError extends DomainError {
  readonly code = 'STORAGE_FAILURE';
  readonly status = 500;

  constructor(message = 'Storage failure', options?: ErrorOptions) {
    super(message, options);
  }
}
