export class InvalidApiKeyError extends Error {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;

  constructor() {
    super('유효하지 않은 API 키');
  }
}
